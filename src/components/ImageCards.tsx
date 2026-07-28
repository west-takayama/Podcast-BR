import { useEffect, useMemo, useState } from "react";
import { PRESETS, canvasToBlob, renderCard, type CardContent, type Preset } from "../lib/image";

interface Props {
  quote: string;
  title: string;
  showName: string;
  accent: string;
}

interface Rendered {
  url: string;
  blob: Blob;
}

export default function ImageCards({ quote, title, showName, accent }: Props) {
  const [selected, setSelected] = useState<Preset>("square");
  const [rendered, setRendered] = useState<Partial<Record<Preset, Rendered>>>({});
  const [error, setError] = useState("");
  const [shared, setShared] = useState(false);

  const content: CardContent = useMemo(
    () => ({ quote, title, showName, accent }),
    [quote, title, showName, accent],
  );

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      const next: Partial<Record<Preset, Rendered>> = {};
      for (const spec of PRESETS) {
        try {
          const blob = await canvasToBlob(renderCard(spec, content));
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
  }, [content]);

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
    </div>
  );
}
