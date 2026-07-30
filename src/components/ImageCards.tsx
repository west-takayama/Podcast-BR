import { useEffect, useMemo, useState } from "react";
import {
  PRESETS,
  canvasToBlob,
  renderCard,
  renderPlainImage,
  type CardContent,
  type Preset,
} from "../lib/image";
import { generateIllustration } from "../lib/gemini";
import { buildImagePrompt } from "../lib/imagePrompt";
import CopyButton from "./CopyButton";

interface Props {
  quote: string;
  title: string;
  showName: string;
  accent: string;
  /** イラスト生成に使う。未設定ならボタンを出さない。 */
  apiKey?: string;
  imageModel?: string | null;
  /** 絵柄の題材にする内容(要約やキーワード)。 */
  subject?: string;
}

interface Rendered {
  url: string;
  blob: Blob;
}

export default function ImageCards({
  quote,
  title,
  showName,
  accent,
  apiKey,
  imageModel,
  subject,
}: Props) {
  const [selected, setSelected] = useState<Preset>("square");
  const [rendered, setRendered] = useState<Partial<Record<Preset, Rendered>>>({});
  const [error, setError] = useState("");
  const [shared, setShared] = useState(false);
  const [background, setBackground] = useState<ImageBitmap | null>(null);
  const [generating, setGenerating] = useState(false);
  const [imported, setImported] = useState<ImageBitmap | null>(null);
  // 取り込んだ画像に文字まで描かれている場合は、こちらで重ねると二重になる
  const [importedAsIs, setImportedAsIs] = useState(true);
  const [promptShape, setPromptShape] = useState<"square" | "story">("square");

  const content: CardContent = useMemo(
    () => ({
      quote,
      title,
      showName,
      accent,
      background: (imported && !importedAsIs ? imported : background) ?? undefined,
    }),
    [quote, title, showName, accent, background, imported, importedAsIs],
  );

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      const next: Partial<Record<Preset, Rendered>> = {};
      for (const spec of PRESETS) {
        try {
          const canvas =
            imported && importedAsIs ? renderPlainImage(spec, imported) : renderCard(spec, content);
          const blob = await canvasToBlob(canvas);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          next[spec.id] = { url, blob };
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!cancelled) setRendered(next);
    })();
    return () => {
      cancelled = true;
      urls.forEach(URL.revokeObjectURL);
    };
    // そのまま使う場合は content を経由しないので、切り替えも依存に入れる
  }, [content, imported, importedAsIs]);

  useEffect(() => {
    return () => background?.close();
  }, [background]);

  useEffect(() => {
    return () => imported?.close();
  }, [imported]);

  /** ChatGPT などで作った画像を取り込む。文字が描かれているかは利用者が選ぶ。 */
  const importImage = async (file: File) => {
    setError("");
    try {
      const bitmap = await createImageBitmap(file);
      // 古い bitmap は上の useEffect の後片付けで閉じられる
      setImportedAsIs(true);
      setImported(bitmap);
    } catch {
      setError("この画像は読み込めませんでした(PNG / JPEG をお試しください)");
    }
  };

  const makeIllustration = async () => {
    if (!apiKey || !imageModel) return;
    setGenerating(true);
    setError("");
    try {
      const blob = await generateIllustration({
        apiKey,
        model: imageModel,
        subject: subject || quote || title,
        accent,
      });
      const bitmap = await createImageBitmap(blob);
      setBackground((prev) => {
        prev?.close();
        return bitmap;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  // 主役の文字は、採用したタイトルを優先する(「題名をそのまま画像に」が目的のため)
  const chatgptPrompt = useMemo(
    () =>
      buildImagePrompt({
        headline: title || quote,
        showName,
        subject,
        accent,
        shape: promptShape,
      }),
    [title, quote, showName, subject, accent, promptShape],
  );

  const current = rendered[selected];
  const spec = PRESETS.find((p) => p.id === selected)!;
  const fileName = `${(showName || "episode").replace(/\s+/g, "-")}-${selected}.png`;

  // iOS では共有シートから写真アプリや Instagram へ直接渡せる。
  // ダウンロードより手数が少ないので、使えるときはこちらを主にする。
  const canShare =
    typeof navigator !== "undefined" &&
    !!navigator.canShare &&
    !!current &&
    navigator.canShare({ files: [new File([current.blob], fileName, { type: "image/png" })] });

  const share = async () => {
    if (!current) return;
    try {
      await navigator.share({
        files: [new File([current.blob], fileName, { type: "image/png" })],
        title: title || showName,
      });
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // 共有シートを閉じただけの場合もここに来るため、エラー表示はしない
    }
  };

  return (
    <div className="card">
      <h2>🖼 告知画像</h2>
      {error && <p className="muted">⚠️ {error}</p>}

      <div className="preset-tabs">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={selected === p.id ? "active" : ""}
            onClick={() => setSelected(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="muted">
        {spec.note} ・ {spec.width}×{spec.height}
      </p>

      {current ? (
        <>
          <img className="card-preview" src={current.url} alt={`${spec.label}の告知画像`} />
          {canShare && (
            <button className="primary" onClick={share}>
              {shared ? "✓ 共有しました" : "📤 共有 / 写真に保存"}
            </button>
          )}
          <a className="dl" href={current.url} download={fileName}>
            ⬇️ PNG をダウンロード({(current.blob.size / 1024).toFixed(0)} KB)
          </a>
        </>
      ) : (
        <p className="muted">生成中…</p>
      )}

      {/*
        題名を絵の中に描かせたい場合の経路。画像生成 API は有料なので、
        すでに契約している ChatGPT をそのまま使えるように注文文を渡す形にした。
      */}
      <div className="illust">
        <h3 style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
          ✍️ 題名を絵の中に描く(ChatGPT)
        </h3>
        <p className="muted">
          下の文をコピーして ChatGPT に貼ると、題名が入った画像を作れます。追加費用はかかりません。
          <br />
          できた画像を保存して、この下から読み込んでください。
        </p>
        <div className="preset-tabs">
          <button
            className={promptShape === "square" ? "active" : ""}
            onClick={() => setPromptShape("square")}
          >
            正方形用
          </button>
          <button
            className={promptShape === "story" ? "active" : ""}
            onClick={() => setPromptShape("story")}
          >
            ストーリー用
          </button>
        </div>
        <div className="result-head">
          <span className="muted">ChatGPT に貼る文</span>
          <CopyButton text={chatgptPrompt} label="この文をコピー" />
        </div>
        <textarea readOnly value={chatgptPrompt} rows={7} />

        <label className="dl" style={{ cursor: "pointer" }}>
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importImage(f);
              e.target.value = "";
            }}
          />
          🖼 作った画像を読み込む
        </label>

        {imported && (
          <>
            <label className="check" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={importedAsIs}
                onChange={(e) => setImportedAsIs(e.target.checked)}
              />
              <span>
                画像に文字が描かれている(そのまま使う)
                <br />
                <span className="muted">
                  外すと背景として扱い、崩れない文字をこちらで重ねます。文字が読みにくい・崩れている
                  ときはこちらが安全です。
                </span>
              </span>
            </label>
            <button
              onClick={() => {
                setImported(null);
                setImportedAsIs(true);
              }}
            >
              取り込んだ画像を外す
            </button>
          </>
        )}
      </div>

      {apiKey && imageModel && (
        <div className="illust">
          <div className="row-buttons">
            <button onClick={makeIllustration} disabled={generating}>
              {generating ? "生成中…" : background ? "🎨 別の絵にする" : "🎨 AIイラストを背景に"}
            </button>
            {background && (
              <button
                onClick={() =>
                  setBackground((prev) => {
                    prev?.close();
                    return null;
                  })
                }
              >
                元に戻す
              </button>
            )}
          </div>
          <p className="muted">
            エピソードの内容に合わせた背景を生成します(無料枠内・1日あたりの上限あり)。文字は
            AI に描かせず、こちらで重ねるため崩れません。
          </p>
        </div>
      )}
    </div>
  );
}
