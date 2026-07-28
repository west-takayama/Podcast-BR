// Gemini API(無料枠)との連携。
// Files API に MP3 をアップロードし、文字起こしとメタデータ生成を1回の呼び出しで行う。
// API キーは端末の localStorage にのみ保存され、Google 以外へは送信されない。

import { buildPrompt, type PromptConfig } from "./prompt";

const API_BASE = "https://generativelanguage.googleapis.com";

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
      // 音声を扱えない用途別モデルを除く
      return !/embedding|aqa|imagen|veo|-tts|image-generation/.test(m.name);
    })
    .map((m: { name: string; displayName?: string }) => ({
      id: m.name.replace(/^models\//, ""),
      displayName: m.displayName ?? m.name.replace(/^models\//, ""),
    }));

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

/** 一覧から既定として使うモデルを選ぶ。 */
export function pickDefaultModel(models: ModelInfo[]): string | null {
  return models[0]?.id ?? null;
}

export interface SocialPosts {
  x: string;
  instagram: string;
  newsletter: string;
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
  social?: SocialPosts;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  mp3: ArrayBuffer;
  config: PromptConfig;
  onStatus: (status: string) => void;
  /** アップロードの進捗 (0〜1)。回線が遅いほど支配的になるので実測値を返す。 */
  onUploadProgress?: (fraction: number) => void;
  /** モデル廃止で別のモデルに切り替わったときに呼ばれる。設定へ保存し直すために使う。 */
  onModelChanged?: (model: string) => void;
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
): Promise<UploadedFile> {
  const { status, text } = await xhrUpload(
    `${API_BASE}/upload/v1beta/files?key=${apiKey}&uploadType=media`,
    mp3,
    onProgress,
    signal,
  );
  if (status < 200 || status >= 300) {
    if (status === 400 && text.includes("API_KEY_INVALID")) {
      throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
    }
    if (status === 413) {
      throw new Error(
        "音声ファイルが大きすぎてアップロードできませんでした。設定で無音カットを有効にするか、エピソードを分割してください。",
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
    social,
  };
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
  const { apiKey, model, mp3, config, onStatus, onUploadProgress, onModelChanged, signal } = opts;

  onStatus("音声をアップロード中…");
  const file = await uploadFile(apiKey, mp3, onUploadProgress, signal);

  let fileUri = file.uri;
  if (file.state !== "ACTIVE") {
    onStatus("音声を解析待ち…");
    fileUri = await waitUntilActive(apiKey, file.name, signal);
  }

  onStatus("タイトル・説明文を生成中…");
  const prompt = buildPrompt(config);
  const call = (modelId: string) =>
    fetch(`${API_BASE}/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { mime_type: "audio/mpeg", file_uri: fileUri } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.7,
        },
      }),
    });

  let res = await call(model);

  // Google はモデルを予告より早く廃止することがある。ここで諦めると変換済みの
  // 音声が無駄になるので、利用可能なモデルを引き直して一度だけやり直す。
  if (res.status === 404) {
    onStatus("モデルが更新されたため切り替え中…");
    const models = await listModels(apiKey, signal);
    const replacement = pickDefaultModel(models);
    if (!replacement || replacement === model) {
      throw new Error(
        `モデル ${model} は利用できなくなっています。設定画面でモデルを選び直してください。`,
      );
    }
    onStatus("タイトル・説明文を生成中…");
    res = await call(replacement);
    if (res.ok) onModelChanged?.(replacement);
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("API_KEY_INVALID")) {
      throw new Error("APIキーが無効です。設定画面でキーを確認してください。");
    }
    if (res.status === 429) {
      throw new Error("無料枠のレート制限に達しました。1分ほど待って再試行してください。");
    }
    throw new Error(`生成に失敗しました (${res.status}): ${body.slice(0, 300)}`);
  }
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
