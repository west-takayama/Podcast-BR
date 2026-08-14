// Gemini API(無料枠)との連携。
// Files API に MP3 をアップロードし、文字起こしとメタデータ生成を1回の呼び出しで行う。
// API キーは端末の localStorage にのみ保存され、Google 以外へは送信されない。

import { buildPrompt, formatTimecode, type PromptConfig, type PromptContext } from "./prompt";
import { parseTimestamp } from "./id3";

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
  /** 画像を生成できるモデルか。テキスト用と選択肢を分けるために持つ。 */
  image: boolean;
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
      // 用途が合わないモデルを除く。imagen は generateContent ではなく predict を使う
      return !/embedding|aqa|imagen|veo|-tts/.test(m.name);
    })
    .map((m: { name: string; displayName?: string }) => {
      const id = m.name.replace(/^models\//, "");
      return { id, displayName: m.displayName ?? id, image: /image/.test(id) };
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

/** 一覧から既定のテキスト生成モデルを選ぶ。 */
export function pickDefaultModel(models: ModelInfo[]): string | null {
  return models.find((m) => !m.image)?.id ?? null;
}

/**
 * イラスト生成に使うモデルを選ぶ。
 * flash 系の画像モデルには無料枠があるため、pro 系より優先する。
 */
export function pickImageModel(models: ModelInfo[]): string | null {
  const images = models.filter((m) => m.image);
  return images.find((m) => m.id.includes("flash"))?.id ?? images[0]?.id ?? null;
}

export interface IllustrationOptions {
  apiKey: string;
  model: string;
  /** 画像生成に渡す指示文。告知画像と同じ文を使い、指示を一箇所にまとめている。 */
  prompt: string;
  signal?: AbortSignal;
}

/**
 * 告知画像の素材を Gemini に作らせる。
 *
 * 指示文はアプリ側(lib/imagePrompt.ts)で組み立てたものをそのまま渡す。
 * ChatGPT に貼る文と同じにしておかないと、どちらで作ったかで絵の方向性が
 * 変わってしまい、番組としての見た目が揃わない。
 */
export async function generateIllustration(opts: IllustrationOptions): Promise<Blob> {
  const { apiKey, model, prompt, signal } = opts;

  const res = await fetch(`${API_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      throw new Error("画像生成の無料枠(1日あたりの上限)に達しました。明日また試せます。");
    }
    if (res.status === 404) {
      throw new Error(
        `画像モデル ${model} が利用できませんでした。設定画面でモデルを選び直してください。`,
      );
    }
    if (res.status === 400 && /billing|quota|not supported/i.test(body)) {
      throw new Error("このAPIキーでは画像生成が利用できません(無料枠の対象外の可能性があります)。");
    }
    throw new Error(`イラストの生成に失敗しました (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts: Record<string, unknown>[] = data.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    // REST は camelCase で返るが、実装差を考えて snake_case も見る
    const inline = (part.inlineData ?? part.inline_data) as
      | { data?: string; mimeType?: string; mime_type?: string }
      | undefined;
    if (!inline?.data) continue;
    const mime = inline.mimeType ?? inline.mime_type ?? "image/png";
    const binary = atob(inline.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  throw new Error("画像が返りませんでした。もう一度お試しください。");
}

export interface SocialPosts {
  x: string;
  instagram: string;
  newsletter: string;
}

/** 縦型ショート動画にする候補。バズの入り口はここ。 */
export interface Clip {
  /** "MM:SS" */
  start: string;
  end: string;
  /** 動画の1行目に大きく出す見出し。 */
  hook: string;
  /** なぜ伸びると思うか。選び直しの判断に使う。 */
  why: string;
}

export interface EpisodeMeta {
  titles: string[];
  description: string;
  showNotes: string;
  chapters: { time: string; label: string }[];
  hashtags: string[];
  transcriptSummary: string;
  keywords: string[];
  /** 告知画像に載せる一言。 */
  imageQuote: string;
  /** 切り抜き候補。音声を聴いて選ばせる。 */
  clips?: Clip[];
  social?: SocialPosts;
}

export interface TranscriptSegment {
  time: string;
  speaker: string;
  text: string;
}

/**
 * アップロード済みの音声。Gemini の Files API は48時間保持するため、
 * この間は音声を送り直さずに文章だけ作り直せる。
 */
export interface UploadedAudio {
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
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "audio/mpeg");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () =>
      reject(
        new Error(
          "Gemini APIに接続できませんでした。通信環境を確認して再試行してください。変換済みMP3はダウンロード可能です。",
        ),
      );
    xhr.ontimeout = () => reject(new Error("アップロードがタイムアウトしました"));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
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
): Promise<UploadedFile> {
  const send = () =>
    xhrUpload(
      `${API_BASE}/upload/v1beta/files?key=${apiKey}&uploadType=media`,
      mp3,
      onProgress,
      signal,
    );

  let { status, text } = await send();
  // 送信も混雑で弾かれることがある。数十MB を捨てずに待って投げ直す
  for (let i = 0; i < RETRY_WAIT_MS.length && TRANSIENT_STATUS.includes(status); i++) {
    const sec = Math.round(RETRY_WAIT_MS[i] / 1000);
    onStatus?.(`Gemini が混雑しています。${sec}秒待って送信し直します(${i + 1}/${RETRY_WAIT_MS.length})…`);
    await sleep(RETRY_WAIT_MS[i], signal);
    ({ status, text } = await send());
  }

  if (status < 200 || status >= 300) {
    if (status === 400 && text.includes("API_KEY_INVALID")) {
      throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
    }
    if (status === 413) {
      throw new Error(
        "音声ファイルが大きすぎてアップロードできませんでした。設定で無音カットを有効にするか、エピソードを分割してください。",
      );
    }
    if (TRANSIENT_STATUS.includes(status)) {
      throw new Error(
        `Gemini が音声を受け付けられませんでした(${status}・自動で${RETRY_WAIT_MS.length}回試しました)。` +
          "数分待ってから「生成だけやり直す」を押してください。",
      );
    }
    throw new Error(`音声のアップロードに失敗しました (${status}): ${text.slice(0, 200)}`);
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
    await new Promise((r) => setTimeout(r, 2000));
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
const MAX_CLIP_SEC = 90;

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
    if (start === null) continue;
    // 終了が無い・逆転している場合は、長さから決め直す
    if (end === null || end <= start) end = start + 45;

    start = Math.max(0, Math.min(start, Math.max(0, limit - MIN_CLIP_SEC)));
    end = Math.min(end, limit);
    if (end - start > MAX_CLIP_SEC) end = start + MAX_CLIP_SEC;
    if (end - start < MIN_CLIP_SEC) continue;

    out.push({
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

/** 生成物の欠けを埋める。項目が1つ欠けただけで全体を失敗させない。 */
function normalizeMeta(raw: unknown): EpisodeMeta {
  const o = (raw ?? {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const titles = strArray(o.titles);
  const description = typeof o.description === "string" ? o.description : "";
  if (titles.length === 0 || !description) {
    throw new Error("生成結果にタイトルまたは説明文が含まれていませんでした。再試行してください。");
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
    imageQuote: typeof o.imageQuote === "string" ? o.imageQuote : "",
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
  mp3: ArrayBuffer,
  onStatus: (status: string) => void,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadedAudio> {
  onStatus("音声をアップロード中…");
  const file = await uploadFile(apiKey, mp3, onProgress, signal, onStatus);

  let uri = file.uri;
  if (file.state !== "ACTIVE") {
    onStatus("音声を解析待ち…");
    uri = await waitUntilActive(apiKey, file.name, signal);
  }
  // Files API の保持期間は48時間。この間は送り直さずに作り直せる
  return { uri, name: file.name, expiresAt: Date.now() + 48 * 3600 * 1000, bytes: mp3.byteLength };
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
  signal?: AbortSignal;
}): Promise<Clip[]> {
  const {
    apiKey, model, mp3, audio, durationSec,
    onStatus, onUploadProgress, onModelChanged, onUploaded, signal,
  } = opts;

  let source = audio;
  if (!isAudioUsable(source)) {
    if (!mp3) throw new Error("音声がありません。もう一度アップロードしてください。");
    source = await uploadEpisodeAudio(apiKey, mp3, onStatus, onUploadProgress, signal);
    onUploaded?.(source);
  }

  onStatus("面白い区間を探しています…");

  // 動画が短いと「30〜60秒を3つ」は物理的に無理で、候補が返ってこない。
  // 長さに応じて頼み方を変える(実際に短い動画で0件になった)。
  const total = durationSec && durationSec > 0 ? durationSec : 0;
  const lengthRule = !total
    ? "- 長さは30〜60秒。"
    : total <= 70
      ? `- この音声は全体で ${Math.round(total)}秒しかありません。**動画全体を1つの候補にして構いません。**
  無理に短く切らず、面白い部分が入るように取ってください。候補は1〜2個で構いません。`
      : total <= 150
        ? `- この音声は全体で ${Math.round(total)}秒です。長さは20〜60秒の範囲で、
  音声の長さを超えない区間にしてください。候補は2〜3個。`
        : `- 長さは30〜60秒。
- この音声は全体で ${formatTimecode(total)} です。**この長さを超える時刻を返さないでください。**`;

  const prompt = `添付の音声を聴いて、縦型ショート動画(TikTok / Reels / YouTube Shorts)に
切り出す区間を選んでください。

選ぶ基準(この順に強い):
1. 笑いが起きている、声が跳ねている
2. 言い切っている・断言している
3. 意外な事実や数字が出てくる
4. 話が急に転換して引きが立つ

条件:
- **それ単体で完結して面白い**こと。前後の文脈が無いと意味が通らない箇所は選ばない。
${lengthRule}
- **冒頭2秒で引きが立つ位置から始める。** 前置きや「えー」から始めない。
- 候補が1つも思いつかない場合でも、いちばんましな区間を必ず1つは返す。
- hook は動画の1行目に大きく出す見出し。20文字以内。続きを見たくなる言葉にし、
  答えは動画の中に残す。
- why は「なぜ伸びると思うか」を20文字程度で。

次の構造の JSON のみを出力する:
{"clips": [{"start": "MM:SS", "end": "MM:SS", "hook": string, "why": string}]}`;

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
  if (!res.ok) throwForStatus(res.status, await res.text(), "切り抜きの抽出");

  const data = await res.json();
  const text: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("候補が返りませんでした。もう一度お試しください。");
  let parsed: { clips?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("候補を読み取れませんでした。もう一度お試しください。");
  }
  const clips = normalizeClips(parsed.clips, total || undefined);
  if (clips.length > 0) return clips;

  // ここまで来たら AI の答えは使えない。それでも行き止まりにはしない。
  // 音声があるのだから、全体(長ければ先頭60秒)を候補として出す。
  if (total >= MIN_CLIP_SEC) {
    return [
      {
        start: "00:00",
        end: formatTimecode(Math.min(total, 60)),
        hook: "冒頭から",
        why: "AIが選べなかったため、先頭から仮に取っています",
      },
    ];
  }
  throw new Error(
    `切り出せる区間がありませんでした(動画が短すぎます。${MIN_CLIP_SEC}秒以上の動画をお使いください)。`,
  );
}

/**
 * 指定した区間だけを書き起こす。字幕用。
 * 全編を書き起こすより速く、無料枠も食わない。時刻のずれも小さい。
 */
export async function transcribeRange(opts: {
  apiKey: string;
  model: string;
  audio: UploadedAudio;
  startSec: number;
  endSec: number;
  speakers: string;
  /** この番組でよく出る言葉。聞き間違いを減らすために渡す。 */
  glossary?: string;
  onStatus: (status: string) => void;
  onModelChanged?: (model: string) => void;
  signal?: AbortSignal;
}): Promise<TranscriptSegment[]> {
  const { apiKey, model, audio, startSec, endSec, speakers, glossary, onStatus, onModelChanged, signal } = opts;
  onStatus("字幕を作っています…");

  // 字幕にそのまま載せる前提なので、行の長さと時刻の細かさを指定する。
  // 1秒刻みだと画面上で目に見えてずれるため、小数第1位まで求める。
  //
  // 添付の音声が既に切り出し済み(startSec が 0)なら、範囲の指定はしない。
  // 「12:34 から」と言うと AI はファイルの頭から数えることになり、
  // 後ろへ行くほど推定がずれる。0 から数えさせたほうが圧倒的に合う。
  const whole = startSec <= 0.05;
  const target = whole
    ? `添付の音声(${Math.round(endSec - startSec)}秒)を、最初から最後まで日本語で書き起こしてください。`
    : `添付の音声のうち、${formatTimecode(startSec)} から ${formatTimecode(endSec)} までの区間だけを日本語で書き起こしてください。`;

  const prompt = `${target}**動画の字幕としてそのまま画面に出します。**

要件:
- **1行あたり全角16文字以内**で区切る。長い発言は意味の切れ目で複数行に分ける。
- 区切る位置は**文節の切れ目**にする。「という/ことです」のように語の途中で切らない。
- 各行に、その行を**話し始める時刻**を付ける(${whole ? "添付した音声の先頭を 00:00 とする" : "音声全体の先頭からの時刻"})。
- 時刻は "MM:SS.S" の形式で、**小数第1位まで**入れる(例 "01:23.4")。
  字幕は0.5秒ずれるだけで目に見えて合わなくなるため、できる限り正確に。
- **話していない時間には行を作らない。** 間が空いたところは飛ばす。
- 「えー」「あの」「まあ」などのつなぎ言葉と、言い直しの前半は省く。読みやすさを優先する。
- 話し言葉のままでよいが、「〜っていうか」のような口癖の連発は整理してよい。意味は変えない。
- 数字・固有名詞は聞こえたとおりに漢字/カタカナで書く(「にせんにじゅうご年」ではなく「2025年」)。
- 句読点を入れる。読点は息継ぎの位置に置く。
- 聞き取れない箇所は推測で埋めず「(聞き取り不明)」とする。
${speakers.trim() ? `- 話者は次の呼び名を使う: ${speakers}` : "- 話者は A / B のように区別する。"}
${glossary?.trim() ? `- **次の言葉はこの表記で書く。** この番組でよく出る言葉なので、似た音に聞こえてもこちらを優先する: ${glossary.trim()}` : ""}

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
      generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
    },
    onStatus,
    onModelChanged,
    signal,
  );
  if (!res.ok) throwForStatus(res.status, await res.text(), "字幕の作成");

  const data = await res.json();
  const text: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { segments?: Record<string, unknown>[] };
    return (parsed.segments ?? [])
      .filter((s) => s && typeof s.text === "string" && (s.text as string).trim())
      .map((s) => ({
        time: typeof s.time === "string" ? s.time : "",
        speaker: typeof s.speaker === "string" ? s.speaker : "",
        text: (s.text as string).trim(),
      }));
  } catch {
    return [];
  }
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
  const call = (id: string) =>
    fetch(`${API_BASE}/v1beta/models/${id}:generateContent?key=${apiKey}`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  let res = await call(model);

  // 混雑はこちらに原因が無く待てば解ける。利用者に押し直させる必要はない
  for (let i = 0; i < RETRY_WAIT_MS.length && TRANSIENT_STATUS.includes(res.status); i++) {
    const sec = Math.round(RETRY_WAIT_MS[i] / 1000);
    onStatus(`Gemini が混雑しています。${sec}秒待って自動で再試行します(${i + 1}/${RETRY_WAIT_MS.length})…`);
    await sleep(RETRY_WAIT_MS[i], signal);
    onStatus("再試行中…");
    res = await call(model);
  }

  // 待っても駄目で、使っているのが試験版なら、正式版に替えて一度試す。
  // 試験版は無料枠の割り当てが細く、混雑と区別が付かない形で弾かれる。
  // 待つだけでは何度やり直しても通らないので、ここで乗り換える
  if (TRANSIENT_STATUS.includes(res.status) && isPreviewModel(model)) {
    onStatus("試験版のモデルが応答しないため、正式版に切り替えて試します…");
    const stable = pickDefaultModel(await listModels(apiKey, signal));
    if (stable && stable !== model && !isPreviewModel(stable)) {
      const retried = await call(stable);
      if (retried.ok) {
        onModelChanged?.(stable);
        return retried;
      }
      // 正式版でも駄目なら、元の応答で判断させる(原因は別にある)
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

function throwForStatus(status: number, body: string, what: string): never {
  if (status === 400 && body.includes("API_KEY_INVALID")) {
    throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
  }
  if (status === 429) {
    throw new Error("無料枠のレート制限に達しました。1分ほど待って再試行してください。");
  }
  if (status === 403 || (status === 400 && body.includes("PERMISSION_DENIED"))) {
    throw new Error("音声の保持期限(48時間)が切れている可能性があります。もう一度アップロードしてください。");
  }
  // ここに来るのは自動再試行を使い切った場合。
  // どれも「待てば直るかもしれない」応答だが、中身は同じではない。
  // 503/504 は本当に混んでいる。500 は待っても直らないことが多く、
  // その場合は設定でモデルを替えるほうが早い。番号も出して切り分けられるようにする
  if (TRANSIENT_STATUS.includes(status)) {
    const crowded = status === 503 || status === 504;
    throw new Error(
      (crowded
        ? `Gemini が混雑しているため受け付けられませんでした(${status}・自動で${RETRY_WAIT_MS.length}回試しました)。数分待ってから「生成だけやり直す」を押してください。`
        : `Gemini 側で処理できませんでした(${status}・自動で${RETRY_WAIT_MS.length}回試しました)。` +
          `待っても直らない場合は、設定画面でモデルを別のものに替えてみてください。`) +
        "変換済みMP3はそのまま使えます。",
    );
  }
  throw new Error(`${what}に失敗しました (${status}): ${body.slice(0, 300)}`);
}

export async function generateEpisodeMeta(opts: GenerateOptions): Promise<EpisodeMeta> {
  try {
    return await generateEpisodeMetaInner(opts);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof TypeError && /fetch/i.test(err.message)) {
      throw new Error(
        "Gemini APIに接続できませんでした。通信環境を確認して再試行してください。変換済みMP3はダウンロード可能です。",
      );
    }
    throw err;
  }
}

async function generateEpisodeMetaInner(opts: GenerateOptions): Promise<EpisodeMeta> {
  const {
    apiKey, model, mp3, audio, config, context, onStatus,
    onUploadProgress, onModelChanged, onUploaded, signal,
  } = opts;

  let source = audio;
  if (!isAudioUsable(source)) {
    if (!mp3) throw new Error("音声がありません。もう一度アップロードしてください。");
    source = await uploadEpisodeAudio(apiKey, mp3, onStatus, onUploadProgress, signal);
    onUploaded?.(source);
  }

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

  if (!res.ok) throwForStatus(res.status, await res.text(), "生成");

  const data = await res.json();
  const text: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("生成結果が空でした。もう一度お試しください。");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("生成結果がJSONとして読み取れませんでした。もう一度お試しください。");
  }
  return normalizeMeta(parsed);
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

  if (!res.ok) throwForStatus(res.status, await res.text(), "書き起こし");

  const data = await res.json();
  const text: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("書き起こしが空でした。もう一度お試しください。");

  let parsed: { segments?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("書き起こしを読み取れませんでした。もう一度お試しください。");
  }
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
  onStatus: (status: string) => void;
  onModelChanged?: (model: string) => void;
  signal?: AbortSignal;
}): Promise<TopicSuggestions> {
  const { apiKey, model, digest, stats, config, onStatus, onModelChanged, signal } = opts;
  const count = opts.count ?? 6;
  const today = opts.today ?? new Date();
  onStatus("これまでの回を読んでいます…");

  const background = [
    config.showName.trim() && `番組名: ${config.showName.trim()}`,
    config.speakers.trim() && `話者: ${config.speakers.trim()}`,
    config.glossary.trim() && `この番組でよく出る言葉: ${config.glossary.trim()}`,
    config.showContext.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `あなたは日本語ポッドキャストの構成作家です。これまでの回を読んで、**次に話すお題**を${count}個考えてください。

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

  const res = await callWithModelFallback(
    apiKey,
    model,
    {
      contents: [{ parts: [{ text: prompt }] }],
      // 案出しなので少し散らす。固くすると似た案が並ぶ
      generationConfig: { response_mime_type: "application/json", temperature: 0.9 },
    },
    onStatus,
    onModelChanged,
    signal,
  );
  if (!res.ok) throwForStatus(res.status, await res.text(), "お題の提案");

  const data = await res.json();
  const text: string | undefined = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("お題が返りませんでした。もう一度お試しください。");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("お題の形式が読めませんでした。もう一度お試しください。");
  }

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

  return { patterns: asStrings(parsed.patterns, 6), gaps: asStrings(parsed.gaps, 5), ideas };
}
