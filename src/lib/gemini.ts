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

/** 新しい安定版の flash 系を上位に並べるためのスコア。 */
function score(id: string): number {
  const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  let s = version * 100;
  if (id.includes("flash")) s += 40; // 速く、無料枠の制限も緩い
  if (id.includes("lite")) s -= 25; // 音声の聞き取り精度が落ちる
  if (id.includes("pro")) s += 10;
  if (/preview|exp|-\d{3,}/.test(id)) s -= 60; // プレビュー版と日付入りは避ける
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
        "Gemini が混雑していて音声を受け付けられませんでした(自動で3回試しました)。数分待ってから「生成だけやり直す」を押してください。",
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
function normalizeClips(raw: unknown): Clip[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter(
      (c) =>
        c &&
        typeof c.start === "string" &&
        typeof c.end === "string" &&
        parseTimestamp(c.start) !== null &&
        parseTimestamp(c.end) !== null,
    )
    .map((c) => ({
      start: c.start as string,
      end: c.end as string,
      hook: typeof c.hook === "string" ? c.hook : "",
      why: typeof c.why === "string" ? c.why : "",
    }))
    .filter((c) => {
      const a = parseTimestamp(c.start)!;
      const b = parseTimestamp(c.end)!;
      return b - a >= 10000 && b - a <= 120000;
    });
}

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
  onStatus: (status: string) => void;
  onUploadProgress?: (fraction: number) => void;
  onModelChanged?: (model: string) => void;
  onUploaded?: (audio: UploadedAudio) => void;
  signal?: AbortSignal;
}): Promise<Clip[]> {
  const { apiKey, model, mp3, audio, onStatus, onUploadProgress, onModelChanged, onUploaded, signal } = opts;

  let source = audio;
  if (!isAudioUsable(source)) {
    if (!mp3) throw new Error("音声がありません。もう一度アップロードしてください。");
    source = await uploadEpisodeAudio(apiKey, mp3, onStatus, onUploadProgress, signal);
    onUploaded?.(source);
  }

  onStatus("面白い区間を探しています…");
  const prompt = `添付の音声を聴いて、縦型ショート動画(TikTok / Reels / YouTube Shorts)に
切り出す区間を3つ選んでください。

選ぶ基準(この順に強い):
1. 笑いが起きている、声が跳ねている
2. 言い切っている・断言している
3. 意外な事実や数字が出てくる
4. 話が急に転換して引きが立つ

条件:
- **それ単体で完結して面白い**こと。前後の文脈が無いと意味が通らない箇所は選ばない。
- 長さは30〜60秒。
- **冒頭2秒で引きが立つ位置から始める。** 前置きや「えー」から始めない。
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
  const clips = normalizeClips(parsed.clips);
  if (clips.length === 0) throw new Error("切り出せそうな区間が見つかりませんでした。");
  return clips;
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
  onStatus: (status: string) => void;
  onModelChanged?: (model: string) => void;
  signal?: AbortSignal;
}): Promise<TranscriptSegment[]> {
  const { apiKey, model, audio, startSec, endSec, speakers, onStatus, onModelChanged, signal } = opts;
  onStatus("字幕を作っています…");

  // 字幕にそのまま載せる前提なので、行の長さと時刻の細かさを指定する。
  // 1秒刻みだと画面上で目に見えてずれるため、小数第1位まで求める。
  const prompt = `添付の音声のうち、${formatTimecode(startSec)} から ${formatTimecode(endSec)} までの
区間だけを日本語で書き起こしてください。**動画の字幕としてそのまま画面に出します。**

要件:
- **1行あたり全角20文字以内**で区切る。長い発言は意味の切れ目で複数行に分ける。
- 各行に、その行を**話し始める時刻**を付ける(音声全体の先頭からの時刻)。
- 時刻は "MM:SS.S" の形式で、**小数第1位まで**入れる(例 "01:23.4")。
  字幕は0.5秒ずれるだけで目に見えて合わなくなるため、できる限り正確に。
- 「えー」「あの」などのつなぎ言葉は省いてよい。読みやすさを優先する。
- 聞き取れない箇所は推測で埋めず「(聞き取り不明)」とする。
${speakers.trim() ? `- 話者は次の呼び名を使う: ${speakers}` : "- 話者は A / B のように区別する。"}

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
  // ここに来るのは自動再試行を使い切った場合。原因は Google 側の混雑で、
  // 生の JSON を見せても打つ手は変わらないため、待つべきことだけ伝える
  if (TRANSIENT_STATUS.includes(status)) {
    throw new Error(
      "Gemini が混雑しているため受け付けられませんでした(自動で3回試しました)。数分待ってから「生成だけやり直す」を押してください。変換済みMP3はそのまま使えます。",
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
