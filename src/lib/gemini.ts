import type { CaptionCue } from "./video/captionAlignment";
// Gemini API(無料枠)との連携。
// Files API に MP3 をアップロードし、文字起こしとメタデータ生成を1回の呼び出しで行う。
// API キーは端末の localStorage にのみ保存され、Google 以外へは送信されない。

import { buildPrompt, formatTimecode, type PromptConfig, type PromptContext } from "./prompt";
import { parseTimestamp } from "./id3";
import { measureStage, recordTiming } from "./timing";
import { withDeadline } from "./deadline";

const API_BASE = "https://generativelanguage.googleapis.com";

/**
 * 混雑(503)など、待てば直る種類の応答。
 * 利用量とは無関係にモデル側が詰まっているだけなので、少し待って投げ直す。
 * 429 は含めない。無料枠の上限に当たっている状態で急いで投げ直すと、
 * 待ち時間が延びるだけで得がないため。
 */
const TRANSIENT_STATUS = [500, 502, 503, 504];
/** 待ち時間。混雑は数十秒で解けることが多いので、そこまで粘る。 */
const RETRY_WAIT_MS = [3000, 8000, 20000];
/**
 * 待っても駄目なときに試す、別のモデルの数。
 * 一覧は良いものから並んでいるので、上から順に当たる。
 */
const MAX_MODEL_SWITCHES = 2;
/**
 * 1分あたりの上限(429)に当たったとき、自動で待つ上限。
 * この枠は 60 秒で戻るので、ここまで待てば十分。1日の上限は待っても戻らない。
 */
const QUOTA_MAX_WAIT_MS = 70000;

/** 1日あたりの上限か。こちらは待っても戻らないので、待たせてはいけない。 */
function isDailyQuota(body: string): boolean {
  return /per[\s_-]?day|\bdaily\b/i.test(body);
}

/**
 * Google が「何秒後に来い」と教えてくれる値(google.rpc.RetryInfo)。
 * 勝手に決めた秒数より、向こうの言う秒数のほうが確か。
 */
function retryDelayMs(body: string): number {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const sec = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(sec) || sec <= 0) return 60000;
  return Math.min(Math.ceil(sec) * 1000 + 1000, QUOTA_MAX_WAIT_MS);
}

/**
 * 残り秒数を出しながら待つ。
 * 1分の沈黙は「固まった」と見分けが付かないので、減っていく数字を見せる。
 */
async function countdown(
  ms: number,
  onTick: (secondsLeft: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const remain = end - Date.now();
    if (remain <= 0) return;
    onTick(Math.ceil(remain / 1000));
    await sleep(Math.min(1000, remain), signal);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("中止しました", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });


export interface ModelInfo {
  id: string; // "gemini-3.5-flash"
  displayName: string;
}

/**
 * 利用可能なモデルを API から取得する。
 *
 * モデル名をアプリに書き込むと Google 側の廃止で必ず動かなくなる
 * (実際に gemini-2.5-flash が予告より早く 404 になった)。
 * 一覧はキーごとに変わるため、その端末のキーで毎回引き直す。
 */
export async function listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch(`${API_BASE}/v1beta/models?key=${apiKey}&pageSize=200`, { signal });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("API_KEY_INVALID")) {
      throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
    }
    throw new Error(`モデル一覧を取得できませんでした (${res.status})`);
  }
  const data = await res.json();
  const models: ModelInfo[] = (data.models ?? [])
    .filter((m: { supportedGenerationMethods?: string[]; name?: string }) => {
      if (!m.name || !m.supportedGenerationMethods?.includes("generateContent")) return false;
      // 用途が合わないモデルを除く。画像生成系は音声を聴けない
      return !/embedding|aqa|imagen|veo|-tts|image/.test(m.name);
    })
    .map((m: { name: string; displayName?: string }) => {
      const id = m.name.replace(/^models\//, "");
      return { id, displayName: m.displayName ?? id };
    });

  return models.sort((a, b) => score(b.id) - score(a.id));
}

/**
 * 試験版(preview / experimental)か。
 *
 * 無料枠では試験版の割り当てが特に細く、混んでいなくても 503 や 500 を
 * 返してくる。**「生成できませんでした」の主な原因はこれ。**
 *
 * 一方 `-001` のような番号付きは、中身を固定した**正式版**なので避けない。
 * 以前はこれも避けていたが、正式版をいちばん下に落としてしまっていた。
 */
export function isPreviewModel(id: string): boolean {
  return /preview|(^|-)exp(erimental)?(-|$)|-\d{2}-\d{2}($|-)/.test(id);
}

/** 新しい安定版の flash 系を上位に並べるためのスコア。 */
function score(id: string): number {
  const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  let s = version * 100;
  if (id.includes("flash")) s += 40; // 速く、無料枠の制限も緩い
  if (id.includes("lite")) s -= 25; // 音声の聞き取り精度が落ちる
  if (id.includes("pro")) s += 10;
  // 試験版は**どれだけ新しくても**正式版の下に置く。
  // 以前は -60 だったが、世代が1つ上がると +100 なので追い越されていた。
  // 新しい世代が試験版しか出ていない時期に、わざわざ詰まるほうを選んでいた
  if (isPreviewModel(id)) s -= 100000;
  return s;
}

/** 一覧から既定のモデルを選ぶ。 */
export function pickDefaultModel(models: ModelInfo[]): string | null {
  return models[0]?.id ?? null;
}

export interface SocialPosts {
  x: string;
  instagram: string;
  newsletter: string;
}

/** 縦型ショート動画にする候補。評価は編集支援用。 */
export interface Clip {
  /** "MM:SS" */
  start: string;
  end: string;
  /** 動画の1行目に大きく出す見出し。 */
  hook: string;
  /** 選定理由。再生数の予測ではない。 */
  why: string;
  scores?: { interest: number; insight: number; hook: number; empathy: number; completeness: number };
  socialPost?: string;
  hashtags?: string[];
  needsReview?: boolean;
}

export interface EpisodeMeta {
  titles: string[];
  description: string;
  showNotes: string;
  chapters: { time: string; label: string }[];
  hashtags: string[];
  transcriptSummary: string;
  keywords: string[];
  /** 切り抜き候補。音声を聴いて選ばせる。 */
  clips?: Clip[];
  social?: SocialPosts;
}

export interface TranscriptSegment {
  time: string;
  speaker: string;
  text: string;
  emphasis?: string[];
}

/**
 * アップロード済みの音声。Gemini の Files API は48時間保持するため、
 * この間は音声を送り直さずに文章だけ作り直せる。
 */
type AudioMime = "audio/mpeg" | "audio/wav";

export interface UploadedAudio {
  mimeType?: AudioMime;
  uri: string;
  name: string;
  expiresAt: number;
  bytes: number;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  /** 音声を送る場合。すでにアップロード済みなら audio を渡す。 */
  mp3?: ArrayBuffer;
  audio?: UploadedAudio;
  config: PromptConfig;
  context?: PromptContext;
  onStatus: (status: string) => void;
  /** アップロードの進捗 (0〜1)。回線が遅いほど支配的になるので実測値を返す。 */
  onUploadProgress?: (fraction: number) => void;
  /** モデル廃止で別のモデルに切り替わったときに呼ばれる。設定へ保存し直すために使う。 */
  onModelChanged?: (model: string) => void;
  /** アップロードが済んだ時点で呼ばれる。作り直しのために保持しておくため。 */
  onUploaded?: (audio: UploadedAudio) => void;
  signal?: AbortSignal;
}

/**
 * fetch はアップロードの進捗を取れないため、送信は XHR を使う。
 * モバイル回線では送信が体感時間の大半を占めるので、ここだけは実測が要る。
 */
function xhrUpload(
  url: string,
  body: ArrayBuffer,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  mimeType: AudioMime = "audio/mpeg",
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = 90_000;
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () =>
      reject(
        new Error(
          "Gemini APIに接続できませんでした。通信環境を確認して再試行してください。準備済みの音声は保持しています。",
        ),
      );
    xhr.ontimeout = () => reject(new Error("アップロードがタイムアウトしました"));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const abort = () => xhr.abort();
      signal.addEventListener("abort", abort, { once: true });
      xhr.onloadend = () => signal.removeEventListener("abort", abort);
      xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    }
    xhr.send(body);
  });
}

interface UploadedFile {
  name: string; // e.g. "files/abc123"
  uri: string;
  state: string;
}

/**
 * Files API への一括アップロード(uploadType=media)。
 *
 * 公式ドキュメントが案内する resumable 方式は使えない。アップロード先URLが
 * レスポンスヘッダ X-Goog-Upload-URL で返るが、このヘッダは
 * Access-Control-Expose-Headers に含まれておらず、ブラウザからは読み取れないため。
 * media 方式なら URL は不要で、レスポンスボディに File が直接返る。
 */
async function uploadFile(
  apiKey: string,
  mp3: ArrayBuffer,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  onStatus?: (status: string) => void,
  mimeType: AudioMime = "audio/mpeg",
): Promise<UploadedFile> {
  const send = () =>
    xhrUpload(
      `${API_BASE}/upload/v1beta/files?key=${apiKey}&uploadType=media`,
      mp3,
      onProgress,
      signal,
      mimeType,
    );

  let { status, text } = await send();
  // 送信も混雑で弾かれることがある。数十MB を捨てずに待って投げ直す
  for (let i = 0; i < RETRY_WAIT_MS.length && TRANSIENT_STATUS.includes(status); i++) {
    const sec = Math.round(RETRY_WAIT_MS[i] / 1000);
    onStatus?.(`Gemini が混雑しています。${sec}秒待って送信し直します(${i + 1}/${RETRY_WAIT_MS.length})…`);
    await measureStage("retry-wait", () => sleep(RETRY_WAIT_MS[i], signal));
    ({ status, text } = await send());
  }

  // 送信も1分あたりの上限に当たることがある。数十MB を上限ひとつで捨てない
  if (status === 429 && !isDailyQuota(text)) {
    await measureStage("retry-wait", () => countdown(
      retryDelayMs(text),
      (left) => onStatus?.(`無料枠の1分あたりの上限です。${left}秒待って送信し直します…`),
      signal,
    ));
    ({ status, text } = await send());
  }

  if (status < 200 || status >= 300) {
    if (status === 400 && text.includes("API_KEY_INVALID")) {
      throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
    }
    if (status === 413) {
      throw new Error(
        "音声ファイルが大きすぎてアップロードできませんでした。エピソードを短い音声に分割して選び直してください。",
      );
    }
    if (TRANSIENT_STATUS.includes(status)) {
      throw new Error(
        `Gemini が音声を受け付けられませんでした(${status}・自動で${RETRY_WAIT_MS.length}回試しました)。` +
          "数分待ってから「生成だけやり直す」を押してください。",
      );
    }
    throw new Error(`音声のアップロードに失敗しました (${status}): ${reasonFrom(redactApiError(text, apiKey))}`);
  }
  const info = JSON.parse(text);
  const file = info.file as UploadedFile | undefined;
  if (!file?.name || !file?.uri) {
    throw new Error("アップロード結果を読み取れませんでした");
  }
  return file;
}

async function waitUntilActive(
  apiKey: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<string> {
  for (let i = 0; i < 90; i++) {
    const res = await fetch(`${API_BASE}/v1beta/${fileName}?key=${apiKey}`, { signal });
    if (!res.ok) throw new Error(`ファイル状態の確認に失敗しました (${res.status})`);
    const info = await res.json();
    if (info.state === "ACTIVE") return info.uri as string;
    if (info.state === "FAILED") throw new Error("Gemini側での音声処理に失敗しました");
    await sleep(2000, signal);
  }
  throw new Error("音声処理がタイムアウトしました");
}

/**
 * 切り抜き候補を整える。時刻が読めないものと、縦動画に向かない長さのものは捨てる。
 * 壊れた区間で書き出そうとしても意味がない。
 */
/** 縦型ショートとして成立する最短の長さ。これ未満は動画にならない。 */
const MIN_CLIP_SEC = 5;
/** 長すぎる候補は切り詰める。捨てるより短くしたほうが使える。 */
const MAX_CLIP_SEC = 60;

/** 秒に直す。AI は数値でも文字列でも返してくる。 */
function toSeconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== "string") return null;
  const ms = parseTimestamp(v);
  return ms === null ? null : ms / 1000;
}

/**
 * 切り抜き候補を整える。
 *
 * 以前は「読めない・長さが範囲外」を全部捨てていたため、短い動画で
 * 候補が全滅して「見つかりませんでした」になっていた(利用者の端末で発生)。
 * いまは直せるものは直す: 動画の長さに収め、長すぎる候補は切り詰める。
 * durationSec を渡すと、その範囲外の候補を捨てずに収められる。
 */
function normalizeClips(raw: unknown, durationSec?: number): Clip[] {
  if (!Array.isArray(raw)) return [];
  const limit = durationSec && durationSec > 0 ? durationSec : Infinity;

  const out: Clip[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c) continue;
    let start = toSeconds(c.start);
    let end = toSeconds(c.end);
    const originalStart = start, originalEnd = end;
    if (start === null) continue;
    // 終了が無い・逆転している場合は、長さから決め直す
    if (end === null || end <= start) end = start + 45;

    start = Math.max(0, Math.min(start, Math.max(0, limit - MIN_CLIP_SEC)));
    end = Math.min(end, limit);
    if (end - start > MAX_CLIP_SEC) end = start + MAX_CLIP_SEC;
    if (end - start < MIN_CLIP_SEC) continue;

    if (out.some(item => item.start === formatTimecode(start) && item.end === formatTimecode(end))) continue;
    const scores = c.scores as Clip['scores'];
    const validScores = scores && typeof scores === 'object' &&
      Object.entries({ interest: 25, insight: 25, hook: 20, empathy: 15, completeness: 15 })
        .every(([key, max]) => Number.isFinite(scores[key as keyof typeof scores]) &&
          scores[key as keyof typeof scores] >= 0 && scores[key as keyof typeof scores] <= max);
    out.push({
      ...(validScores ? { scores: { interest: scores.interest, insight: scores.insight, hook: scores.hook, empathy: scores.empathy, completeness: scores.completeness } } : {}),
      ...(typeof c.socialPost === 'string' ? { socialPost: c.socialPost.trim() } : {}),
      ...(Array.isArray(c.hashtags) ? { hashtags: [...new Set(c.hashtags.filter((h): h is string => typeof h === 'string').map(h => '#' + h.replace(/^#+/, '').replace(/\s+/g, '')).filter(h => h.length > 1))].slice(0, 5) } : {}),
      ...(start !== originalStart || end !== originalEnd ? { needsReview: true } : {}),
      start: formatTimecode(start),
      end: formatTimecode(end),
      hook: typeof c.hook === "string" ? c.hook : "",
      why: typeof c.why === "string" ? c.why : "",
    });
  }
  return out;
}

/** 検証用。AI の返し方の揺れを吸収できているかをテストから確かめる。 */
export const __testNormalizeClips = normalizeClips;
/** 応答の番号と本文から出す文言。検証のために公開する。 */
export const __testThrowForStatus = throwForStatus;
/** 応答の形の揺れに強いかを直に確かめるため。 */
export const __testAnswerFrom = answerFrom;
export const __testExtractJson = extractJson;
export const __testIsDailyQuota = isDailyQuota;
export const __testRetryDelayMs = retryDelayMs;

/** 生成物の欠けを埋める。項目が1つ欠けただけで全体を失敗させない。 */
function normalizeMeta(raw: unknown): EpisodeMeta {
  const o = (raw ?? {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const titles = strArray(o.titles);
  const description = typeof o.description === "string" ? o.description : "";
  if (titles.length === 0 || !description) {
    throw new Error(
      `生成結果に${titles.length === 0 ? "タイトル" : "説明文"}が含まれていませんでした` +
        "(返答が途中で切れた可能性があります)。再試行してください。",
    );
  }

  const chapters = Array.isArray(o.chapters)
    ? (o.chapters as Record<string, unknown>[])
        .filter((c) => c && typeof c.time === "string" && typeof c.label === "string")
        .map((c) => ({ time: c.time as string, label: c.label as string }))
    : [];

  const clips = normalizeClips(o.clips);

  const socialRaw = o.social as Record<string, unknown> | undefined;
  const social =
    socialRaw && typeof socialRaw === "object"
      ? {
          x: typeof socialRaw.x === "string" ? socialRaw.x : "",
          instagram: typeof socialRaw.instagram === "string" ? socialRaw.instagram : "",
          newsletter: typeof socialRaw.newsletter === "string" ? socialRaw.newsletter : "",
        }
      : undefined;

  return {
    titles,
    description,
    showNotes: typeof o.showNotes === "string" ? o.showNotes : "",
    chapters,
    hashtags: strArray(o.hashtags),
    transcriptSummary: typeof o.transcriptSummary === "string" ? o.transcriptSummary : "",
    keywords: strArray(o.keywords),
    clips,
    social,
  };
}

/**
 * チャプター時刻を、端末側で検出した実際の切り替わり位置へ吸着させる。
 *
 * AI が音声から読み取る時刻は数秒から十数秒ずれることがあり、ずれたチャプターは
 * 無いより悪い。近い候補があればそこへ寄せ、無ければ元の値を残す。
 */
export function snapChapters(
  chapters: { time: string; label: string }[],
  pauses: number[],
  toleranceSec = 20,
): { chapters: { time: string; label: string }[]; movedCount: number; maxMoveSec: number } {
  if (pauses.length === 0) return { chapters, movedCount: 0, maxMoveSec: 0 };

  let movedCount = 0;
  let maxMoveSec = 0;
  const snapped = chapters.map((c) => {
    const ms = parseTimestamp(c.time);
    if (ms === null) return c;
    const sec = ms / 1000;
    // 冒頭は 00:00 のままが自然なので触らない
    if (sec === 0) return c;

    let best = sec;
    let bestDiff = Infinity;
    for (const p of pauses) {
      const diff = Math.abs(p - sec);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    }
    if (bestDiff > toleranceSec || bestDiff < 0.05) return c;
    movedCount++;
    if (bestDiff > maxMoveSec) maxMoveSec = bestDiff;
    return { time: formatTimecode(best), label: c.label };
  });

  return { chapters: snapped, movedCount, maxMoveSec };
}

/** 音声をアップロードして、生成に使える状態になるまで待つ。 */
export async function uploadEpisodeAudio(
  apiKey: string,
  bytes: ArrayBuffer,
  onStatus: (status: string) => void,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  mimeType: AudioMime = "audio/mpeg",
): Promise<UploadedAudio> {
  onStatus("音声をアップロード中…");
  const file = await measureStage("upload", () => uploadFile(apiKey, bytes, onProgress, signal, onStatus, mimeType));

  let uri = file.uri;
  if (file.state !== "ACTIVE") {
    onStatus("音声を解析待ち…");
    uri = await measureStage("activation", () => waitUntilActive(apiKey, file.name, signal));
  }
  // Files API の保持期間は48時間。この間は送り直さずに作り直せる
  return { uri, name: file.name, expiresAt: Date.now() + 48 * 3600 * 1000, bytes: bytes.byteLength, ...(mimeType === "audio/wav" ? { mimeType } : {}) };
}

/**
 * 音声を聴かせて、切り抜き候補だけを返させる。
 *
 * 動画から作る場合はタイトルも説明文も要らないので、
 * エピソード生成の一式ではなく候補だけを取りに行く(その分速く、枠も食わない)。
 */
export async function findClips(opts: {
  apiKey: string;
  model: string;
  mp3?: ArrayBuffer;
  audio?: UploadedAudio;
  /** 動画の長さ(秒)。候補の長さを動画に合わせるために渡す。 */
  durationSec?: number;
  onStatus: (status: string) => void;
  onUploadProgress?: (fraction: number) => void;
  onModelChanged?: (model: string) => void;
  onUploaded?: (audio: UploadedAudio) => void;
  onEpisodeFacts?: (facts: string[]) => void;
  signal?: AbortSignal;
}): Promise<Clip[]> {
  const {
    apiKey, model, mp3, audio, durationSec,
    onStatus, onUploadProgress, onModelChanged, onUploaded, onEpisodeFacts, signal,
  } = opts;

  let source = audio;
  if (!isAudioUsable(source)) {
    if (!mp3) throw new Error("音声がありません。もう一度アップロードしてください。");
    source = await uploadEpisodeAudio(apiKey, mp3, onStatus, onUploadProgress, signal);
    onUploaded?.(source);
  }

  onStatus("面白い区間を探しています…");

  const total = durationSec && durationSec > 0 ? durationSec : 0;
  const lengthRule = `- 30秒前後を推奨。通常20〜40秒、最大60秒。自然な発言の区切りを優先。
${total ? `- 全体は ${formatTimecode(total)}。素材の終端を越えない。短い素材は20秒未満でも、自然に完結する候補を1つ返す。` : ""}`;

  const prompt = `添付の音声を聴いて、縦型ショート動画(TikTok / Reels / YouTube Shorts)に
切り出す区間を選んでください。

番組 BRIDGE RADIO の価値は「面白さ」と「新しい価値観」。候補を次の基準で内部評価し、総合的に優れた順に返す:
- 会話の面白さ・自然な掛け合い (25点)
- 新しい価値観・気づき (25点)
- 冒頭の引き (20点)
- 共感や対話を促す内容 (15点)
- 単体での話の完成度 (15点)
笑いだけでなく、静かでも考えさせる会話を拾う。長い素材では内容の異なる候補を優先し、同じ話の重複を避ける。点数は編集判断用であり、再生数の予測ではない。

条件:
- **それ単体で完結して面白い**こと。前後の文脈が無いと意味が通らない箇所は選ばない。
${lengthRule}
- **冒頭2秒で引きが立つ位置から始める。** 前置きや「えー」から始めない。発言の途中で切らず、オチや結論、必要な応答まで含める。文脈を歪める編集や、音声にない内容を見出しにすることは禁止。
- 候補が1つも思いつかない場合でも、いちばんましな区間を必ず1つは返す。
- hook は動画の1行目に大きく出す見出し。20文字以内。続きを見たくなる言葉にし、
  答えは動画の中に残す。
- why は選定理由を具体的に20文字程度で。再生数や拡散を予測しない。
- scores は上記5基準の配点内で採点する。socialPost は実際の会話に基づくSNS投稿文を80文字程度、hashtags は関連するものを3個以内。

${onEpisodeFacts ? "clips を先に返し、episodeFacts には短い候補だけでなく全編で実際に述べられた主題・具体例・結論を6〜10個の簡潔な事実として入れる。創作や投稿文は入れない。" : ""}
次の構造の JSON のみを出力する:
{"clips": [{"start": "MM:SS", "end": "MM:SS", "hook": string, "why": string, "scores": {"interest": number, "insight": number, "hook": number, "empathy": number, "completeness": number}, "socialPost": string, "hashtags": string[]}]${onEpisodeFacts ? `, "episodeFacts": string[]` : ""}}`;

  const res = await callWithModelFallback(
    apiKey,
    model,
    {
      contents: [
        {
          parts: [
            { file_data: { mime_type: "audio/mpeg", file_uri: source!.uri } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: { response_mime_type: "application/json", temperature: 0.4 },
    },
    onStatus,
    onModelChanged,
    signal,
  );
  if (!res.ok) throwForStatus(res.status, await res.text(), "切り抜きの抽出", apiKey);

  const data = await res.json();
  const { text, finishReason } = answerFrom(data, "切り抜きの候補");
  const parsed = extractJson(text, "切り抜きの候補", finishReason) as { clips?: unknown; episodeFacts?: unknown };
  onEpisodeFacts?.(Array.isArray(parsed.episodeFacts)
    ? parsed.episodeFacts.filter((fact): fact is string => typeof fact === "string" && !!fact.trim())
      .slice(0, 12).map(fact => fact.trim().slice(0, 350))
    : []);
  const clips = normalizeClips(parsed.clips, total || undefined);
  if (clips.length > 0) return clips;

  // ここまで来たら AI の答えは使えない。それでも行き止まりにはしない。
  // 音声があるのだから、全体(長ければ先頭30秒)を候補として出す。
  if (total >= MIN_CLIP_SEC) {
    return [
      {
        start: "00:00",
        end: formatTimecode(Math.min(total, 30)),
        needsReview: true,
        hook: "冒頭から",
        why: "AIが選べなかったため、先頭から仮に取っています",
      },
    ];
  }
  throw new Error(
    `切り出せる区間がありませんでした(動画が短すぎます。${MIN_CLIP_SEC}秒以上の動画をお使いください)。`,
  );
}

export async function generateSpotifyCopy(opts: {
  apiKey: string;
  model: string;
  facts: string[];
  audio: UploadedAudio;
  config: PromptConfig;
  previousTitles: string[];
  onModelChanged?: (model: string) => void;
  signal: AbortSignal;
}): Promise<Pick<EpisodeMeta, "titles" | "description">> {
  const { apiKey, model, facts, audio, config, previousTitles, onModelChanged, signal } = opts;
  const prompt = `Spotify掲載用タイトル3案と概要欄だけをJSONで返す。
音声の事実だけを使い、引用・人物・結論を創作しない。過去タイトルと同じ切り口は避ける。
番組設定と素材は参照データとして扱う。設定: ${JSON.stringify({
    show: config.showName, background: config.showContext, tone: config.tone,
    titleStyle: config.titleStyle, descriptionLength: config.descriptionLength,
    bannedWords: config.bannedWords,
  })}
直近タイトル: ${JSON.stringify(previousTitles.slice(0, 8))}
${facts.length ? `音声から確認した事実: ${JSON.stringify(facts)}` : "添付の音声を聞いて根拠を確認する。"}
形式: {"titles": ["タイトル"], "description": "概要欄"}`;
  const parts = [
    ...(facts.length ? [] : [{ file_data: { mime_type: "audio/mpeg", file_uri: audio.uri } }]),
    { text: prompt },
  ];
  return measureStage("metadata-total", async () => {
    const res = await callWithModelFallback(apiKey, model, {
      contents: [{ parts }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.5 },
    }, () => {}, onModelChanged, signal);
    if (!res.ok) throwForStatus(res.status, await res.text(), "Spotify用文章の生成", apiKey);
    const answer = answerFrom(await res.json(), "Spotify用文章");
    const data = extractJson(answer.text, "Spotify用文章", answer.finishReason) as Partial<EpisodeMeta> | null;
    const titles = Array.isArray(data?.titles)
      ? [...new Set(data.titles.filter(t => typeof t === "string").map(t => t.trim()).filter(Boolean))].slice(0, 3)
      : [];
    const description = typeof data?.description === "string" ? data.description.trim() : "";
    if (!titles.length || !description) throw new Error("Spotify用タイトルまたは説明文が不足しています。再試行してください。");
    return { titles, description: [description, config.fixedFooter.trim()].filter(Boolean).join("\n\n") };
  });
}

/**
 * 指定した区間だけを書き起こす。字幕用。
 * 全編を書き起こすより速く、無料枠も食わない。時刻のずれも小さい。
 */
/** Chunk the conversion to avoid spreading the whole audio into a single call. */
export function encodeCaptionAudio(wav: ArrayBuffer): string {
  const bytes = new Uint8Array(wav) as Uint8Array & { toBase64?: () => string };
  if (bytes.toBase64) return bytes.toBase64();
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

export function useDirectCaptionAudio(durationMs: number): boolean {
  return durationMs >= 20_000 && durationMs <= 40_000;
}

export async function transcribeRange(opts: {
  apiKey: string;
  model: string;
  audio: UploadedAudio | { wav: ArrayBuffer };
  durationMs: number;
  glossary?: string;
  onStatus: (status: string) => void;
  onModelChanged?: (model: string) => void;
  signal?: AbortSignal;
}): Promise<CaptionCue[]> {
  const { apiKey, model, audio, durationMs, glossary, onStatus, onModelChanged, signal } = opts;

  const prompt = `添付の区間音声を日本語で忠実に文字起こしし、字幕用の発話単位と時刻を返してください。
- 添付音声の先頭は必ず0ミリ秒。対象範囲は 0〜${durationMs} ミリ秒。元の動画全体の時刻や秒単位を使わない。
- startMs と endMs は実際に声が始まる・終わる位置を聞いて、整数ミリ秒で返す。文字数で時間を割り振らない。不確かな境界は null、needsReview は true にする。
- 要約、言い換え、省略、補完をしない。相づち、つなぎ言葉、言い直しも聞こえた通りに残す。聞き取れない箇所は「（聞き取り不明）」。無音だけの行を作らない。
- 話者交代で分け、同一話者はこのファイル内で一貫した A、B、C などの識別子を使う。個人名を推測しない。不明なら「不明」。重複発話は別の行で実際の時刻を返す。
- 長い発話は境界が聞き取れる短い発話へ分ける。判断できない箇所を文字数だけで切らない。emphasis は本文に実在する語を2個以内。
${glossary?.trim() ? `音声と一致するときだけ使う用語の表記: ${glossary.trim()}` : ""}
JSON のみを返す:
{"segments":[{"startMs":整数またはnull,"endMs":整数またはnull,"speaker":"A","text":"実際の発話","emphasis":[],"needsReview":false}]}`;
  const body = JSON.stringify({
    contents: [{ parts: [
      "wav" in audio
        ? { inline_data: { mime_type: "audio/wav", data: encodeCaptionAudio(audio.wav) } }
        : { file_data: { mime_type: audio.mimeType ?? "audio/mpeg", file_uri: audio.uri } },
      { text: prompt },
    ] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
  });
  const res = await withDeadline(signal, 75_000, async deadline => {
    let activeModel = model;
    for (let attempt = 1; ; attempt++) {
      onStatus(`Geminiの字幕応答を待っています（${attempt}回目）…`);
      let retryMs = 1500;
      let reason = "通信が切断されました";
      try {
        const result = await measureStage("generation-request", async () => {
          const response = await fetch(`${API_BASE}/v1beta/models/${activeModel}:generateContent`, {
            method: "POST", signal: deadline,
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body,
          });
          return new Response(response.status === 204 ? null : await response.text(), { status: response.status });
        }, attempt);
        if (result.ok) {
          if (activeModel !== model) onModelChanged?.(activeModel);
          return result;
        }
        if (attempt === 1 && result.status === 404) {
          const replacement = pickDefaultModel(await listModels(apiKey, deadline));
          if (replacement && replacement !== activeModel) {
            activeModel = replacement;
            continue;
          }
        }
        if (attempt !== 1) return result;
        if (TRANSIENT_STATUS.includes(result.status)) {
          reason = `Geminiが混雑しています（${result.status}）`;
        } else if (result.status === 429) {
          const details = await result.clone().text();
          retryMs = retryDelayMs(details);
          if (isDailyQuota(details) || retryMs > 15_000) return result;
          reason = "Geminiの短時間の利用上限に達しました";
        } else {
          return result;
        }
      } catch (error) {
        deadline.throwIfAborted();
        if (!(error instanceof TypeError) || attempt !== 1) {
          if (error instanceof TypeError) throw new Error("Geminiとの通信が切断されました。接続を確認して再試行してください。");
          throw error;
        }
      }
      await measureStage("retry-wait", () => countdown(retryMs,
        left => onStatus(`${reason}。${left}秒後に再試行します…`), deadline));
    }
  });
  if (!res.ok) {
    const details = await res.text();
    if (res.status === 429) throw new Error(isDailyQuota(details)
      ? "Geminiの1日あたりの利用上限です（429）。枠が戻ってから再試行してください。"
      : "Geminiの短時間の利用上限です（429）。少し間を置いて再試行してください。");
    if (res.status === 401 || res.status === 403 || details.includes("API_KEY_INVALID")) {
      throw new Error(`Geminiの認証または音声へのアクセスに失敗しました（${res.status}）。APIキーとモデルの利用権限を確認してください。`);
    }
    if (TRANSIENT_STATUS.includes(res.status)) {
      throw new Error(`Geminiの字幕生成でサーバーエラーが続いています（${res.status}）。時間をおいて再試行してください。`);
    }
    throw new Error(`Geminiの字幕生成に失敗しました（${res.status}）。設定を確認して再試行してください。`);
  }
  let parsed: { segments?: unknown };
  try {
    const { text, finishReason } = answerFrom(await res.json(), "字幕", true);
    if (!text.trim()) return [];
    parsed = extractJson(text, "字幕", finishReason);
  } catch {
    throw new Error("Geminiの字幕形式を読み取れませんでした。再試行してください。");
  }
  if (!Array.isArray(parsed?.segments)) throw new Error("字幕の形式が読めませんでした。再試行してください。");
  const boundary = (value: unknown) => typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= durationMs ? value : null;
  return parsed.segments.flatMap((value): CaptionCue[] => {
    if (!value || typeof value.text !== "string" || !value.text.trim()) return [];
    const transcript = value.text.trim();
    const startMs = boundary(value.startMs);
    const endMs = boundary(value.endMs);
    const id = typeof value.speaker === "string" ? value.speaker.trim() : "";
    const speakerId = /^[A-Z]{1,3}$/.test(id) ? id : "不明";
    return [{
      startMs, endMs, speakerId, text: transcript,
      emphasis: Array.isArray(value.emphasis) ? [...new Set<string>(value.emphasis.filter(
        (word: unknown): word is string => typeof word === "string" && !!word && transcript.includes(word),
      ))].slice(0, 2) : [],
      needsReview: value.needsReview !== false || startMs === null || endMs === null || startMs >= endMs || speakerId === "不明",
    }];
  });
}

export function isAudioUsable(audio: UploadedAudio | null | undefined): boolean {
  return !!audio && audio.expiresAt > Date.now();
}

/**
 * モデル廃止で 404 になったら一覧を引き直して一度だけやり直す。
 * 混雑で 503 が返った場合は、間を空けて自動で投げ直す。
 */
async function callWithModelFallback(
  apiKey: string,
  model: string,
  body: unknown,
  onStatus: (status: string) => void,
  onModelChanged?: (model: string) => void,
  signal?: AbortSignal,
): Promise<Response> {
  let attempt = 0;
  const call = (id: string) =>
    measureStage("generation-request", () => fetch(`${API_BASE}/v1beta/models/${id}:generateContent?key=${apiKey}`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), ++attempt);

  // 混雑は**モデルごとに**起きる。同じモデルを待ち続けるより、空いている
  // モデルへ移るほうが早い(試験版なら特に。割り当てが細く、混雑と
  // 区別の付かない形で弾かれる)。
  //
  // 移った先が駄目でも、元の応答をそのまま持って帰る。乗り換え先の
  // 別の事情(その機能に対応していない等)を原因として伝えてしまうと、
  // 何を直せばいいのか分からなくなる。
  let alternatives: string[] | null = null;
  const tryAlternatives = async (reason: string): Promise<Response | null> => {
    if (alternatives === null) {
      alternatives = (await listModels(apiKey, signal).catch(() => []))
        .map((m) => m.id)
        .filter((id) => id !== model)
        // 試験版は詰まりやすいので後回しにする
        .sort((a, b) => Number(isPreviewModel(a)) - Number(isPreviewModel(b)))
        .slice(0, MAX_MODEL_SWITCHES);
    }
    for (const alt of alternatives) {
      onStatus(`${model} が${reason} ${alt} で試します…`);
      const retried = await call(alt).catch(() => null);
      if (retried?.ok) {
        onModelChanged?.(alt);
        return retried;
      }
    }
    return null;
  };

  let res = await call(model);

  // 混雑はこちらに原因が無く待てば解ける。利用者に押し直させる必要はない
  for (let i = 0; i < RETRY_WAIT_MS.length && TRANSIENT_STATUS.includes(res.status); i++) {
    // 短い待ちが一度外れた時点で、先に別のモデルを当たる。
    // 全部待ち切ってから移ると 30 秒以上かかるが、ここなら数秒で済む。
    if (i === 1) {
      const moved = await tryAlternatives("混んでいるため");
      if (moved) return moved;
    }
    const sec = Math.round(RETRY_WAIT_MS[i] / 1000);
    onStatus(`Gemini が混雑しています。${sec}秒待って自動で再試行します(${i + 1}/${RETRY_WAIT_MS.length})…`);
    await measureStage("retry-wait", () => sleep(RETRY_WAIT_MS[i], signal));
    onStatus("再試行中…");
    res = await call(model);
  }

  // 待ち切ってもまだ混んでいるなら、別のモデルをもう一度当たる
  if (TRANSIENT_STATUS.includes(res.status)) {
    const moved = await tryAlternatives("混んでいるため");
    if (moved) return moved;
  }

  // 1分あたりの上限(429)も、待てば戻る。
  //
  // これまでは 429 を一律「押し直してください」にしていた。1日の上限には
  // それが正しいが、**1分の上限は 60 秒で戻る**。向こうが「何秒後に来い」と
  // 教えてくれているのに、その待ちを利用者に肩代わりさせていた。
  //
  // 枠はモデルごとなので、まず空いているモデルを当たる。そのほうが速い。
  if (res.status === 429) {
    const body = await res.clone().text();
    if (!isDailyQuota(body)) {
      const moved = await tryAlternatives("上限に達したため");
      if (moved) return moved;
      await measureStage("retry-wait", () => countdown(
        retryDelayMs(body),
        (left) => onStatus(`無料枠の1分あたりの上限です。${left}秒待って自動で試し直します…`),
        signal,
      ));
      onStatus("再試行中…");
      res = await call(model);
    }
  }

  if (res.status === 404) {
    onStatus("モデルが更新されたため切り替え中…");
    const models = await listModels(apiKey, signal);
    const replacement = pickDefaultModel(models);
    if (!replacement || replacement === model) {
      throw new Error(
        `モデル ${model} は利用できなくなっています。設定画面でモデルを選び直してください。`,
      );
    }
    res = await call(replacement);
    if (res.ok) onModelChanged?.(replacement);
  }
  return res;
}

/**
 * 応答から本文を取り出す。
 *
 * **本文は parts[0] とは限らない。** Google 検索で裏を取らせると、応答が
 * 複数の部品に分かれて返ってくることがあり(前置きの文と本体、空の部品など)、
 * 先頭だけを見ていると「返りませんでした」になる。実際に「次のお題」が
 * 出せなくなっていたのはこれが原因。考えている途中の部品(thought)は答えではない。
 *
 * 本文が空のときは、なぜ空なのかまで伝える。「もう一度お試しください」だけでは
 * 何度押しても同じことが起きる。
 */
function answerFrom(
  data: Record<string, unknown>,
  what: string,
  allowEmpty = false,
): { text: string; finishReason: string } {
  const candidate = (data?.candidates as Record<string, unknown>[] | undefined)?.[0];
  const content = candidate?.content as { parts?: Record<string, unknown>[] } | undefined;
  const text = (content?.parts ?? [])
    .filter((p) => p && p.thought !== true && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  const finishReason = typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
  if (text.trim() || allowEmpty) return { text, finishReason };

  const blockReason = (data?.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      `${what}が長さの上限に当たって、本文が返る前に切れました。設定でモデルを替えるか、もう一度お試しください。`,
    );
  }
  if (finishReason === "SAFETY" || blockReason === "SAFETY") {
    throw new Error(
      `${what}が Gemini の安全フィルタで止められました。内容の一部が引っかかっています。もう一度押すと通ることもあります。`,
    );
  }
  if (finishReason === "RECITATION") {
    throw new Error(`${what}が既存の文章に近いとして止められました。もう一度お試しください。`);
  }
  throw new Error(
    `${what}が返りませんでした${blockReason ? `(${blockReason})` : finishReason ? `(${finishReason})` : ""}。もう一度お試しください。`,
  );
}

/** Error text may echo request URLs or credentials. Redact before display, storage or truncation. */
function redactApiError(body: string, apiKey?: string): string {
  const exact = apiKey ? body.split(apiKey).join("[redacted]") : body;
  return exact
    .replace(/AIza[\w-]{20,}/g, "[redacted]")
    .replace(/([?&](?:key|api_key)=)[^&\s"<>]+/gi, "$1[redacted]")
    .replace(/((?:x-goog-api-key|api[_ -]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]");
}

/** 応答から Google 自身の説明だけを取り出す。JSON でないこともある。 */
export function reasonFrom(body: string): string {
  body = redactApiError(body);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 200);
  } catch {
    // JSON でなければ本文をそのまま短く見せる
  }
  return body.trim().slice(0, 200);
}

function throwForStatus(status: number, body: string, what: string, apiKey?: string): never {
  body = redactApiError(body, apiKey);
  if (status === 400 && body.includes("API_KEY_INVALID")) {
    throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
  }
  if (status === 429) {
    // 1分あたりの上限と1日あたりの上限は別物。
    // 「1分待って」は前者にしか効かない。1日の枠を使い切った人が
    // 1分おきに押し続けることになるので、どちらかを見て伝え分ける
    const daily = isDailyQuota(body);
    throw new Error(
      daily
        ? "無料枠の1日あたりの上限に達しました。しばらく押し直しても戻りません。" +
          "設定画面で別のモデルに替えると、そのモデルぶんの枠を使えます。" +
          `準備済みの音声はそのまま使えます。(${reasonFrom(body)})`
        : "無料枠の1分あたりの上限に達しました。別のモデルを試し、1分ほど待って自動で投げ直しましたが、" +
          "まだ上限のままでした。少し間を置いてからお試しください。準備済みの音声はそのまま使えます。",
    );
  }
  if (status === 403 || (status === 400 && body.includes("PERMISSION_DENIED"))) {
    // 「音声の保持期限切れ」と決めつけていたが、403 はキー側の制限でも出る。
    // 決めつけると、キーの設定を直せば済む人が音声を上げ直し続けることになる。
    // 音声の話をしているときだけそう言い、それ以外は Google の説明をそのまま渡す
    const aboutFile = /\bfiles?\//i.test(body) || /\bFile\b/.test(body);
    throw new Error(
      aboutFile
        ? "送った音声にアクセスできませんでした。保持期限(48時間)が切れている可能性があります。" +
          "元の音声を選び直して送信してください。"
        : `APIキーが許可されていません (${status})。キーに制限(HTTPリファラーやIPアドレスの指定)が` +
          "掛かっていないか、Google AI Studio で確認してください。作り直すのが早いこともあります。" +
          `Google の説明: ${reasonFrom(body)}`,
    );
  }
  // ここに来るのは自動再試行を使い切った場合。
  // どれも「待てば直るかもしれない」応答だが、中身は同じではない。
  // 503/504 は本当に混んでいる。500 は待っても直らないことが多く、
  // その場合は設定でモデルを替えるほうが早い。番号も出して切り分けられるようにする
  if (TRANSIENT_STATUS.includes(status)) {
    const crowded = status === 503 || status === 504;
    throw new Error(
      (crowded
        ? `Gemini が混雑しています(${status})。待ち直しを${RETRY_WAIT_MS.length}回、` +
          `別のモデルも${MAX_MODEL_SWITCHES}つ試しましたが、いずれも空いていませんでした。` +
          `数分待ってから「生成だけやり直す」を押してください。`
        : `Gemini 側で処理できませんでした(${status})。待ち直しと別のモデルを試しても同じでした。` +
          `設定画面でモデルを替えるか、しばらく置いてからお試しください。`) +
        "準備済みの音声はそのまま使えます(有効期限内なら音声の送り直しも不要です)。",
    );
  }
  throw new Error(`${what}に失敗しました (${status}): ${reasonFrom(body)}`);
}

/**
 * 「頼みすぎて返しきれなかった」たぐいの失敗か。
 *
 * 通信も上限も関係なく、**返ってきた中身が使えなかった**場合だけを拾う。
 * 混雑や上限で失敗したものをここで拾うと、無駄に投げ直すことになる。
 */
function isShortfall(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("途中で切れました") ||
    err.message.includes("形式が読めませんでした") ||
    err.message.includes("含まれていませんでした") ||
    err.message.includes("が返りませんでした")
  );
}

export async function generateEpisodeMeta(opts: GenerateOptions): Promise<EpisodeMeta> {
  return measureStage("metadata-total", () => generateEpisodeMetaWithRetry(opts));
}

async function generateEpisodeMetaWithRetry(options: GenerateOptions): Promise<EpisodeMeta> {
  const opts: GenerateOptions = {
    ...options,
    onModelChanged: (model) => {
      opts.model = model;
      options.onModelChanged?.(model);
    },
    onUploaded: (audio) => {
      opts.audio = audio;
      options.onUploaded?.(audio);
    },
  };
  try {
    return await generateEpisodeMetaInner(opts);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof TypeError && /fetch/i.test(err.message)) {
      throw new Error(
        "Gemini APIに接続できませんでした。通信環境を確認して再試行してください。準備済みの音声は保持しています。",
      );
    }

    // 頼んだ量が多すぎて返しきれなかったなら、**項目を減らしてもう一度だけ**試す。
    //
    // 一度に9項目(切り抜き候補3つ・SNS告知文3種を含む)を頼んでいる。返す量が
    // 多いほど途中で切れやすい。ここで諦めると、数分かけた変換のあとに
    // エラーだけが残る。題名・説明文・チャプターが手に入れば投稿はできる。
    //
    // 音声は送信済みなので、かかるのは呼び出し1回ぶんだけ。
    if (isShortfall(err) && !opts.context?.slim) {
      opts.onStatus("返しきれなかったようです。項目を減らしてもう一度試します…");
      try {
        return await generateEpisodeMetaInner({
          ...opts,
          context: { ...(opts.context ?? {}), slim: true },
        });
      } catch (retryErr) {
        if (retryErr instanceof DOMException && retryErr.name === "AbortError") throw retryErr;
        // 二度目も駄目なら、**最初の理由**を伝える。二度目の事情を出すと
        // 何が起きたのか分からなくなる。
        // ただし「もう自動で2回試したこと」は添える。押し直すかどうかの判断が変わる
        const first = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${first} (項目を減らして自動でもう一度試しましたが、同じでした。` +
            `準備済みの音声はそのまま使えます)`,
        );
      }
    }
    throw err;
  }
}

async function generateEpisodeMetaInner(opts: GenerateOptions): Promise<EpisodeMeta> {
  const {
    apiKey, model, mp3, audio, config, context, onStatus,
    onUploadProgress, onModelChanged, onUploaded, signal,
  } = opts;

  const startedAt = performance.now();
  let source = audio;
  if (!isAudioUsable(source)) {
    if (!mp3) throw new Error("音声がありません。もう一度アップロードしてください。");
    source = await uploadEpisodeAudio(apiKey, mp3, onStatus, onUploadProgress, signal);
    onUploaded?.(source);
  }

  const uploadMs = performance.now() - startedAt;
  const generationStartedAt = performance.now();
  onStatus("タイトル・説明文を生成中…");
  const res = await callWithModelFallback(
    apiKey,
    model,
    {
      contents: [
        {
          parts: [
            { file_data: { mime_type: "audio/mpeg", file_uri: source!.uri } },
            { text: buildPrompt(config, context ?? {}) },
          ],
        },
      ],
      generationConfig: { response_mime_type: "application/json", temperature: 0.7 },
    },
    onStatus,
    onModelChanged,
    signal,
  );

  if (!res.ok) throwForStatus(res.status, await res.text(), "生成", apiKey);

  const data = await res.json();
  const { text, finishReason } = answerFrom(data, "生成結果");
  const parsed: unknown = extractJson(text, "生成結果", finishReason);
  const result = normalizeMeta(parsed);
  recordTiming("generation-and-parsing", performance.now() - generationStartedAt, true);
  // Local diagnostics only: never log audio, API keys, or generated text.
  console.info("[AI STUDIO] metadata timing", {
    uploadAndActivationMs: Math.round(uploadMs),
    generationAndParsingMs: Math.round(performance.now() - generationStartedAt),
    totalMs: Math.round(performance.now() - startedAt),
  });
  return result;
}

export interface TranscriptOptions {
  apiKey: string;
  model: string;
  audio: UploadedAudio;
  /** 話者の呼び名。分かっていれば渡すと「Aさん」より具体的になる。 */
  speakers?: string;
  onStatus: (status: string) => void;
  onModelChanged?: (model: string) => void;
  signal?: AbortSignal;
}

/**
 * 全文書き起こし。メタデータとは別の呼び出しにしている。
 * 1回のレスポンスに詰め込むと出力上限に当たって全体が壊れるため、
 * また書き起こしは必要なときだけ作れば無料枠を節約できるため。
 */
export async function generateTranscript(opts: TranscriptOptions): Promise<TranscriptSegment[]> {
  const { apiKey, model, audio, speakers, onStatus, onModelChanged, signal } = opts;
  if (!isAudioUsable(audio)) {
    throw new Error("音声の保持期限(48時間)が切れています。もう一度アップロードしてください。");
  }

  onStatus("書き起こし中…");
  const prompt = `添付の音声を日本語で書き起こしてください。

要件:
- 発言のまとまりごとに区切り、それぞれに開始時刻を付ける。
- time は "MM:SS"(60分を超える場合も分表記のまま)。
- 複数の話者がいる場合は話者を区別する。${speakers ? `話者は次のとおり: ${speakers}` : "名前が分からない場合は「A」「B」とする。"}
- 話者が1人の場合、speaker は空文字にする。
- 「えー」「あのー」などのつなぎ言葉は省いて読みやすくする。ただし発言の意味は変えない。
- 聞き取れない箇所は「(聞き取り不明)」とする。推測で埋めない。

次の構造の JSON のみを出力する:
{"segments": [{"time": string, "speaker": string, "text": string}]}`;

  const res = await callWithModelFallback(
    apiKey,
    model,
    {
      contents: [
        {
          parts: [
            { file_data: { mime_type: "audio/mpeg", file_uri: audio.uri } },
            { text: prompt },
          ],
        },
      ],
      // 書き起こしは創作ではないので温度を下げる
      generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
    },
    onStatus,
    onModelChanged,
    signal,
  );

  if (!res.ok) throwForStatus(res.status, await res.text(), "書き起こし", apiKey);

  const data = await res.json();
  const { text, finishReason } = answerFrom(data, "書き起こし");
  const parsed = extractJson(text, "書き起こし", finishReason) as { segments?: unknown };
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const cleaned = (segments as Record<string, unknown>[])
    .filter((s) => s && typeof s.text === "string" && s.text.trim())
    .map((s) => ({
      time: typeof s.time === "string" ? s.time : "",
      speaker: typeof s.speaker === "string" ? s.speaker : "",
      text: (s.text as string).trim(),
    }));
  if (cleaned.length === 0) throw new Error("書き起こしが得られませんでした。");
  return cleaned;
}

/** 書き起こしを貼り付けやすい平文にする。 */
export function transcriptToText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const head = [s.time, s.speaker].filter(Boolean).join(" ");
      return head ? `${head}\n${s.text}` : s.text;
    })
    .join("\n\n");
}

/** 次に話すお題の案。 */
export interface TopicIdea {
  /** お題そのもの。そのまま収録の頭で読める短さにする。 */
  title: string;
  /** なぜ今これなのか。過去回との関係を含める。 */
  why: string;
  /** 話を転がすための切り口。 */
  angles: string[];
  /** 冒頭2秒で引きが立つ一言。ショートの見出しにも使える。 */
  hook: string;
  /** 関係する過去回のタイトル。続きものにできるかの判断に使う。 */
  related: string[];
}

export interface TopicSuggestions {
  /** 番組の傾向として読み取れたこと。 */
  patterns: string[];
  /** 手が回っていない領域。 */
  gaps: string[];
  ideas: TopicIdea[];
  /** 裏取りに使った出典。検索を使えたときだけ入る。 */
  sources?: TopicSource[];
  /** 検索で裏を取れたか。取れなかったら過去回だけで考えている。 */
  searched?: boolean;
}

const asStrings = (v: unknown, limit = 8): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, limit)
    : [];

/**
 * 履歴からお題を考えさせる。
 *
 * 音声は送らない。送るのはタイトル・日付・要約・チャプター見出しと、
 * 端末側で数えた傾向だけ。過去回の中身を全部読ませなくても、
 * 「何を話してきたか」が分かればお題は出せる。
 *
 * 再生数のような反応のデータは持っていないので、「伸びた回」を根拠に
 * させない。持っていない情報で理由を作られると判断を誤る。
 */
/** お題の裏取りに使った出典。どこから来た話かを見せるために持つ。 */
export interface TopicSource {
  title: string;
  uri: string;
}

/**
 * お題を考えるときに Google 検索で裏取りするかどうか。
 *
 * 過去回だけを見て考えると、**内輪の話に閉じていく**。世の中でいま何が
 * 話されているかを混ぜると、同年代の人が引っかかる入り口が増える。
 *
 * ただし検索が使えるかはキーとモデル次第なので、駄目なら黙って
 * 従来どおり(過去回だけ)に落とす。出せないより出したほうがよい。
 */
async function callTopics(
  apiKey: string,
  model: string,
  prompt: string,
  useSearch: boolean,
  onStatus: (s: string) => void,
  onModelChanged?: (m: string) => void,
  signal?: AbortSignal,
): Promise<Response> {
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    // 案出しなので少し散らす。固くすると似た案が並ぶ
    generationConfig: useSearch
      ? { temperature: 0.9 }
      : { response_mime_type: "application/json", temperature: 0.9 },
  };
  // 検索を使うときは JSON 強制と併用できないモデルがあるため、
  // 形の指定を外して、本文から JSON を取り出す
  if (useSearch) body.tools = [{ google_search: {} }];
  return callWithModelFallback(apiKey, model, body, onStatus, onModelChanged, signal);
}

/** 本文から JSON を取り出す。``` で囲まれていたり前後に文が付くことがある。 */
/**
 * 文字列の中の括弧は数えない。エスケープも見る。
 * ここを雑にすると、説明文の中の「{」で構造を読み違える。
 */
function scanJson(text: string, start: number): {
  /** 対応が取れて閉じた位置。閉じきっていなければ -1。 */
  end: number;
  /** 途中で切れたとき、そこまでで**値が完成していた**最後の位置。 */
  lastComplete: number;
  /** 切れた時点で開いたままの括弧。閉じ直すのに使う。 */
  open: string[];
  /** 文字列の途中で切れたか。 */
  inString: boolean;
} {
  const open: string[] = [];
  let inString = false;
  let esc = false;
  let lastComplete = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") open.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      open.pop();
      lastComplete = i + 1;
      if (open.length === 0) return { end: i, lastComplete, open, inString };
    } else if (c === ",") {
      // ここまでの値は完成している。切れたときはここへ戻れる
      lastComplete = i;
    }
  }
  return { end: -1, lastComplete, open, inString };
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const got = JSON.parse(text);
    return got && typeof got === "object" && !Array.isArray(got)
      ? (got as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 途中で切れた JSON を、読めるところまで読む。
 *
 * 応答が長さの上限で切れることがある。全部捨てると、数分かけた変換のあとに
 * 「読めませんでした」しか残らない。**題名と説明文は先頭にある**ので、
 * 切れていても残っていることが多い。値が完成している最後の位置まで戻して、
 * 開いたままの括弧を閉じれば、そこまでは使える。
 */
function repairTruncated(text: string, start: number): Record<string, unknown> | null {
  let body = text.slice(start);
  for (let attempt = 0; attempt < 24; attempt++) {
    const scan = scanJson(body, 0);
    let cut = scan.lastComplete;
    if (cut <= 0) return null;
    // 区切りのカンマ自体は落とす
    let head = body.slice(0, cut).replace(/,\s*$/, "");
    // 「"key":」だけ残っていたら、その組ごと落とす
    head = head.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
    const closed = head + scan.open.slice().reverse().join("");
    const got = tryParseObject(closed);
    if (got) return got;
    // 駄目ならもう一段戻る
    body = body.slice(0, Math.max(0, cut - 1));
    if (body.length < 2) return null;
  }
  return null;
}

/**
 * 本文から JSON を取り出す。
 *
 * 以前は「最初の { から最後の } まで」で切っていた。前置きの文に { が
 * 混ざっていたり、後ろに文が付いていたりすると、そこに釣られて読めなくなる。
 * 実際に「生成結果の形式が読めませんでした」が出ていた。
 * 括弧の対応を見ながら、読める塊を探す。
 */
function extractJson(text: string, what = "お題", finishReason = ""): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  for (const c of [fenced?.[1], text]) {
    if (!c) continue;
    const first = c.indexOf("{");
    if (first < 0) continue;

    // 先頭の { が閉じていなければ、その塊は途中で切れている。
    // この状態で「対応が取れる塊」を探すと、**中の小さな塊**(チャプター1件など)を
    // 拾ってしまい、題名も説明文も失う。先に外側から読めるところまで拾う
    if (scanJson(c, first).end < 0) {
      const repaired = repairTruncated(c, first);
      if (repaired) return repaired;
    }

    // { のたびに、そこから括弧の対応が取れるかを見る。
    // いちばん大きく取れたものを採る
    let best: Record<string, unknown> | null = null;
    let bestLen = 0;
    for (let i = first; i >= 0; i = c.indexOf("{", i + 1)) {
      const { end } = scanJson(c, i);
      if (end < 0) continue;
      const got = tryParseObject(c.slice(i, end + 1));
      if (got && end - i > bestLen) {
        best = got;
        bestLen = end - i;
      }
    }
    if (best) return best;
  }

  const start = text.indexOf("{");

  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 80);
  const tail = excerpt ? `(返ってきたもの: ${excerpt}…)` : "(何も返ってきていません)";
  if (finishReason === "MAX_TOKENS" || (start >= 0 && scanJson(text, start).end < 0)) {
    throw new Error(
      `${what}が長すぎて途中で切れました。設定でモデルを替えるか、もう一度お試しください。${tail}`,
    );
  }
  throw new Error(`${what}の形式が読めませんでした。もう一度お試しください。${tail}`);
}

/** 応答に付いてくる出典を取り出す。 */
function groundingSources(data: Record<string, unknown>): TopicSource[] {
  const candidate = (data.candidates as Record<string, unknown>[] | undefined)?.[0];
  const meta = candidate?.groundingMetadata as Record<string, unknown> | undefined;
  const chunks = (meta?.groundingChunks as Record<string, unknown>[] | undefined) ?? [];
  const seen = new Set<string>();
  const out: TopicSource[] = [];
  for (const chunk of chunks) {
    const web = chunk?.web as { uri?: string; title?: string } | undefined;
    if (!web?.uri || seen.has(web.uri)) continue;
    seen.add(web.uri);
    out.push({ title: web.title?.trim() || web.uri, uri: web.uri });
    if (out.length >= 8) break;
  }
  return out;
}

export async function suggestTopics(opts: {
  apiKey: string;
  model: string;
  /** 履歴の抜粋(insights.digestForPrompt)。 */
  digest: string;
  /** 端末側で数えた傾向(insights.insightsForPrompt)。 */
  stats: string;
  config: PromptConfig;
  /** 今日の日付。時期ものを出させるために渡す。 */
  today?: Date;
  count?: number;
  /** Google 検索で裏を取るか。既定は取る。 */
  useSearch?: boolean;
  onStatus: (status: string) => void;
  onModelChanged?: (model: string) => void;
  signal?: AbortSignal;
}): Promise<TopicSuggestions> {
  const { apiKey, model, digest, stats, config, onStatus, onModelChanged, signal } = opts;
  const count = opts.count ?? 6;
  const today = opts.today ?? new Date();
  const wantSearch = opts.useSearch !== false;
  onStatus("これまでの回を読んでいます…");

  const background = [
    config.showName.trim() && `番組名: ${config.showName.trim()}`,
    config.speakers.trim() && `話者: ${config.speakers.trim()}`,
    config.audience.trim() && `話し手と、想定している聴き手: ${config.audience.trim()}`,
    config.glossary.trim() && `この番組でよく出る言葉: ${config.glossary.trim()}`,
    config.showContext.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  const promptFor = (useSearch: boolean) => `あなたは日本語ポッドキャストの構成作家です。これまでの回を読んで、**次に話すお題**を${count}個考えてください。

${background ? `## 番組について\n${background}\n` : ""}
## 今日の日付
${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日

## これまでの回(新しい順)
${digest}

## 端末側で数えた傾向
${stats}

## 考え方
- **過去回の続き**を優先する。少し触れて終わっている話、結論が出ないまま流れた話は、それだけで1回になる。
- **しばらく触れていない話題**は、間が空いたぶん話し直す価値がある。前と違う角度をつける。
- 番組の色から外れた「一般論のお題」は出さない。この2人がこの番組で話すから面白い、という形にする。
- 時期(季節・年度・行事)が効くお題があれば入れる。ただし今日の日付から見て自然なものだけ。
- 同じお題を言い換えただけの案を並べない。${count}個それぞれ別の入り口にする。
- **再生数や反応のデータは渡していない。** 「この回が伸びたから」のような、手元にない情報を根拠にしない。
  「バズる」「伸びる」と言い切らない。分からないものを分かったように書かない。
${
  useSearch
    ? `- **検索を使って、いま実際に話題になっていることを確かめてから書くこと。**
  ${config.audience.trim() ? `想定している聴き手(${config.audience.trim()})` : "この番組の聴き手"}が
  いま気にしていそうなこと、最近の出来事、季節の話題を探す。
- ただし**この番組の色に落とし込む**こと。世間の話題をそのまま並べるのではなく、
  「この2人がその話をするなら、どこから入るか」に変換する。
- 検索で確かめた案には、何を見て言っているのかが伝わるように why を書く。
- 見つからなければ無理に入れない。過去回の続きのほうが強い。`
    : ""
}
## 各案に付けるもの
- title: お題。収録の頭でそのまま読める短さ(30文字以内)
- why: なぜ今これなのか。過去回との関係を具体的に書く(60文字程度)
- angles: 話を転がす切り口を3つ。それぞれ疑問形か対立軸にする
- hook: 冒頭2秒で引きが立つ一言(20文字以内)
- related: 関係する過去回のタイトル。無ければ空配列

次の構造の JSON のみを出力する:
{
  "patterns": string[],   // 番組の傾向として読み取れたこと。3〜5個
  "gaps": string[],       // 手が回っていない領域。2〜4個
  "ideas": [{ "title": string, "why": string, "angles": string[], "hook": string, "related": string[] }]
}`;

  const build = (withSearch: boolean) => promptFor(withSearch);

  let searched = wantSearch;
  if (wantSearch) onStatus("いま何が話されているか調べています…");
  let res = await callTopics(
    apiKey, model, build(searched), searched, onStatus, onModelChanged, signal,
  );

  // 検索が使えないキー/モデルがある。そのときは黙って過去回だけに落とす。
  // 出せないより出したほうがよい
  if (!res.ok && searched) {
    const body = await res.text();
    if (res.status === 400) {
      searched = false;
      onStatus("検索は使えなかったので、これまでの回から考えます…");
      res = await callTopics(
        apiKey, model, build(false), false, onStatus, onModelChanged, signal,
      );
    } else {
      throwForStatus(res.status, body, "お題の提案", apiKey);
    }
  }
  if (!res.ok) throwForStatus(res.status, await res.text(), "お題の提案", apiKey);

  const data = await res.json();
  const { text, finishReason } = answerFrom(data, "お題");

  // 検索を使った応答は JSON の形を強制できないため、本文から取り出す
  const parsed = extractJson(text, "お題", finishReason);
  const sources = searched ? groundingSources(data) : [];

  const ideas = (Array.isArray(parsed.ideas) ? parsed.ideas : [])
    .map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      return {
        title: typeof o.title === "string" ? o.title.trim() : "",
        why: typeof o.why === "string" ? o.why.trim() : "",
        angles: asStrings(o.angles, 5),
        hook: typeof o.hook === "string" ? o.hook.trim() : "",
        related: asStrings(o.related, 4),
      };
    })
    .filter((i) => i.title);

  if (ideas.length === 0) throw new Error("お題が返りませんでした。もう一度お試しください。");

  return {
    patterns: asStrings(parsed.patterns, 6),
    gaps: asStrings(parsed.gaps, 5),
    ideas,
    sources: sources.length > 0 ? sources : undefined,
    // 出典が1つも返らなければ、実際には調べていない。そう見せない
    searched: searched && sources.length > 0,
  };
}
