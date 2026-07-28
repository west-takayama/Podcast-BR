// Gemini API(無料枠)との連携。
// Files API に MP3 をアップロードし、文字起こしとメタデータ生成を1回の呼び出しで行う。
// API キーは端末の localStorage にのみ保存され、Google 以外へは送信されない。

const API_BASE = "https://generativelanguage.googleapis.com";

export interface EpisodeMeta {
  titles: string[];
  description: string;
  showNotes: string;
  chapters: { time: string; label: string }[];
  hashtags: string[];
  transcriptSummary: string;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  mp3: ArrayBuffer;
  showContext: string; // 番組の背景情報(番組名・テーマなど)
  onStatus: (status: string) => void;
}

async function uploadFile(apiKey: string, mp3: ArrayBuffer): Promise<string> {
  const startRes = await fetch(`${API_BASE}/upload/v1beta/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(mp3.byteLength),
      "X-Goog-Upload-Header-Content-Type": "audio/mpeg",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: `episode-${Date.now()}.mp3` } }),
  });
  if (!startRes.ok) {
    throw new Error(`アップロード開始に失敗しました (${startRes.status}): ${await startRes.text()}`);
  }
  const uploadUrl = startRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new Error("アップロードURLを取得できませんでした");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
    },
    body: mp3,
  });
  if (!uploadRes.ok) {
    throw new Error(`音声のアップロードに失敗しました (${uploadRes.status})`);
  }
  const info = await uploadRes.json();
  return info.file.name as string; // e.g. "files/abc123"
}

async function waitUntilActive(apiKey: string, fileName: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${API_BASE}/v1beta/${fileName}?key=${apiKey}`);
    if (!res.ok) throw new Error(`ファイル状態の確認に失敗しました (${res.status})`);
    const info = await res.json();
    if (info.state === "ACTIVE") return info.uri as string;
    if (info.state === "FAILED") throw new Error("Gemini側での音声処理に失敗しました");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("音声処理がタイムアウトしました");
}

function buildPrompt(showContext: string): string {
  return `あなたは日本語ポッドキャストの敏腕プロデューサーです。添付の音声エピソードを聴き取り、Spotify for Creators に投稿するためのメタデータを作成してください。

${showContext ? `番組の背景情報:\n${showContext}\n` : ""}
要件:
- titles: 魅力的で具体的なタイトル案を3つ。クリックしたくなるが誇張しすぎない。各30文字以内目安。
- description: エピソード説明文。冒頭1〜2文で内容の核心を伝え、続けて聴きどころを2〜3点。250〜400文字。
- showNotes: 箇条書きのショーノート(話題の流れ)。Markdown形式。
- chapters: 主要な話題の切り替わり。time は "MM:SS" 形式。
- hashtags: 日本語圏で使いやすいハッシュタグを5つ(#付き)。
- transcriptSummary: 内容全体の要約(200文字以内)。

必ず次のJSONスキーマで出力してください:
{"titles": string[], "description": string, "showNotes": string, "chapters": [{"time": string, "label": string}], "hashtags": string[], "transcriptSummary": string}`;
}

export async function generateEpisodeMeta(opts: GenerateOptions): Promise<EpisodeMeta> {
  try {
    return await generateEpisodeMetaInner(opts);
  } catch (err) {
    if (err instanceof TypeError && /fetch/i.test(err.message)) {
      throw new Error(
        "Gemini APIに接続できませんでした。通信環境を確認して再試行してください。変換済みMP3はダウンロード可能です。",
      );
    }
    throw err;
  }
}

async function generateEpisodeMetaInner(opts: GenerateOptions): Promise<EpisodeMeta> {
  const { apiKey, model, mp3, showContext, onStatus } = opts;

  onStatus("音声をアップロード中…");
  const fileName = await uploadFile(apiKey, mp3);

  onStatus("音声を解析待ち…");
  const fileUri = await waitUntilActive(apiKey, fileName);

  onStatus("タイトル・説明文を生成中…");
  const res = await fetch(`${API_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { file_data: { mime_type: "audio/mpeg", file_uri: fileUri } },
            { text: buildPrompt(showContext) },
          ],
        },
      ],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.7,
      },
    }),
  });
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

  const meta = JSON.parse(text) as EpisodeMeta;
  if (!Array.isArray(meta.titles) || typeof meta.description !== "string") {
    throw new Error("生成結果の形式が不正でした。もう一度お試しください。");
  }
  return meta;
}
