import { useEffect, useMemo, useState } from "react";
import {
  PRESETS,
  canvasToBlob,
  renderCard,
  renderPlainImage,
  TEMPLATES,
  type CardContent,
  type Preset,
  type Template,
} from "../lib/image";
import { generateIllustration } from "../lib/gemini";
import { buildImagePrompt, type PromptMode } from "../lib/imagePrompt";
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
  /** 設定の話者欄。写真に写す人数に使う。 */
  speakers?: string;
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
  speakers,
}: Props) {
  const [selected, setSelected] = useState<Preset>("square");
  const [rendered, setRendered] = useState<Partial<Record<Preset, Rendered>>>({});
  const [error, setError] = useState("");
  const [shared, setShared] = useState(false);
  const [background, setBackground] = useState<ImageBitmap | null>(null);
  const [generating, setGenerating] = useState(false);
  const [imported, setImported] = useState<ImageBitmap | null>(null);
  // 背景が無いうちは「全面」のほうが締まる。画像を入れたら「帯」に寄せる。
  // ただし利用者が自分で選んだあとは、その選択を勝手に変えない
  const [template, setTemplate] = useState<Template>("full");
  const [templateChosen, setTemplateChosen] = useState(false);
  // 取り込んだ画像に文字まで描かれている場合は、こちらで重ねると二重になる
  const [importedAsIs, setImportedAsIs] = useState(true);
  const [promptShape, setPromptShape] = useState<"square" | "story">("square");
  // 既定は「絵だけ作らせて文字はこちらで載せる」。日本語が崩れないため
  const [promptMode, setPromptMode] = useState<PromptMode>("background");

  const content: CardContent = useMemo(
    () => ({
      quote,
      title,
      showName,
      accent,
      background: (imported && !importedAsIs ? imported : background) ?? undefined,
      template,
    }),
    [quote, title, showName, accent, background, imported, importedAsIs, template],
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
      if (!templateChosen) setTemplate("band");
    } catch {
      setError("この画像は読み込めませんでした(PNG / JPEG をお試しください)");
    }
  };

  const makeIllustration = async () => {
    if (!apiKey || !imageModel) return;
    setGenerating(true);
    setError("");
    try {
      // ChatGPT に貼る文と同じ指示を渡す。作り手が変わっても絵の方向性を揃える
      const blob = await generateIllustration({
        apiKey,
        model: imageModel,
        prompt: chatgptPrompt,
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
        mode: promptMode,
        speakers,
      }),
    [title, quote, showName, subject, accent, promptShape, promptMode, speakers],
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

  const templateSpec = TEMPLATES.find((t) => t.id === template)!;
  const showTemplatePicker = !(imported && importedAsIs);

  return (
    <div className="card">
      <h2>🖼 告知画像</h2>
      {error && <p className="muted">⚠️ {error}</p>}

      {/*
        素材の差が仕上がりを決めるので、画像の読み込みを最初に置く。
        ChatGPT などで作った絵に、崩れない文字をこちらで載せる形が一番きれいになる。
      */}
      <div className="source">
        <div className="row-buttons" style={{ marginTop: 0 }}>
          <label className="dl" style={{ margin: 0, flex: 1, cursor: "pointer" }}>
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
            {imported ? "🖼 別の画像に差し替える" : "🖼 使う画像を読み込む"}
          </label>
          {imported && (
            <button
              onClick={() => {
                setImported(null);
                setImportedAsIs(true);
              }}
            >
              外す
            </button>
          )}
        </div>
        {imported ? (
          <label className="check" style={{ marginTop: 12, marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={!importedAsIs}
              onChange={(e) => setImportedAsIs(!e.target.checked)}
            />
            <span>
              この画像に文字を入れる
              <br />
              <span className="muted">
                外すと画像をそのまま使います(すでに題名が描かれている場合)。
              </span>
            </span>
          </label>
        ) : (
          <p className="muted" style={{ margin: "10px 0 0" }}>
            ChatGPT などで作った写真を読み込むと、その上に崩れない文字を載せます。読み込まない場合は単色の背景になります。
          </p>
        )}
      </div>

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

      {showTemplatePicker && (
        <>
          <div className="preset-tabs">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                className={template === t.id ? "active" : ""}
                onClick={() => {
                  setTemplate(t.id);
                  setTemplateChosen(true);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="muted">{templateSpec.note}</p>
        </>
      )}

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
          ✍️ ChatGPT で素材を作る
        </h3>
        <p className="muted">
          下の文をコピーして ChatGPT に貼ると、その回の話が実際に交わされている場面の写真が作れます。追加費用はかかりません。
        </p>
        <div className="preset-tabs">
          <button
            className={promptMode === "background" ? "active" : ""}
            onClick={() => setPromptMode("background")}
          >
            写真だけ作る
          </button>
          <button
            className={promptMode === "poster" ? "active" : ""}
            onClick={() => setPromptMode("poster")}
          >
            題名も入れる
          </button>
        </div>
        <p className="muted">
          {promptMode === "background"
            ? "題名はアプリが載せるので日本語が崩れません。読み込んだあと「この画像に文字を入れる」を有効にしてください。"
            : "写真と題名が一体になりますが、日本語が崩れることがあります。読み込んだあと「この画像に文字を入れる」を外してください。"}
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

        <p className="muted" style={{ marginBottom: 0 }}>
          できた画像は、上の「背景にする画像を読み込む」から取り込んでください。
        </p>
      </div>

      {apiKey && imageModel && (
        <div className="illust">
          <div className="row-buttons">
            <button onClick={makeIllustration} disabled={generating}>
              {generating ? "生成中…" : background ? "🎨 別の写真にする" : "🎨 Gemini で写真を作る"}
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
            上と同じ指示で Gemini に作らせます(無料枠内・1日あたりの上限あり)。ChatGPT を開かずに試せますが、写真らしさは ChatGPT のほうが上です。
          </p>
        </div>
      )}
    </div>
  );
}
