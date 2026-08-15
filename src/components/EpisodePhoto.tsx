import { useEffect, useState } from "react";
import { clearArtwork, loadArtwork, saveArtwork } from "../lib/history";

// この回の写真。**SNS 告知画像は作らなくなったが、写真そのものは2箇所で効く。**
//
//  ・MP3 のカバー画像(配信アプリの一覧に出る絵)
//  ・切り抜き(縦型ショート)の背景
//
// どちらも「無くても動くが、あると見栄えが変わる」ものなので、
// 小さく置いておく。読み込んだ写真は端末内に控え、開き直しても残す。

interface Props {
  /** 取り込んだ写真。MP3 のカバーと切り抜きの背景に使う。 */
  onChange?: (bitmap: ImageBitmap | null, restored?: boolean) => void;
}

export default function EpisodePhoto({ onChange }: Props) {
  const [photo, setPhoto] = useState<ImageBitmap | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  // 控えてある写真を読み戻す。ここで戻さないと、タブを切り替えただけで
  // MP3 のカバーも切り抜きの背景も素の状態に戻ってしまう
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadArtwork();
        if (!saved || cancelled) return;
        const bitmap = await createImageBitmap(saved.blob);
        if (cancelled) return bitmap.close();
        setPhoto(bitmap);
        setUrl(URL.createObjectURL(saved.blob));
        onChange?.(bitmap, true);
      } catch {
        // 読み戻せなくても、写真無しで続けられる
      }
    })();
    return () => {
      cancelled = true;
    };
    // 初回だけ。以降は取り込み操作で更新する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => photo?.close();
  }, [photo]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  const take = async (file: File) => {
    setError("");
    try {
      const bitmap = await createImageBitmap(file);
      setPhoto(bitmap); // 古いものは上の後片付けで閉じられる
      setUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      onChange?.(bitmap);
      void saveArtwork(file, true);
    } catch {
      setError("この画像は読み込めませんでした(PNG / JPEG をお試しください)");
    }
  };

  const drop = () => {
    setPhoto(null);
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    onChange?.(null);
    void clearArtwork().catch(() => {});
  };

  return (
    <div className="card">
      <h2>🖼 この回の写真(任意)</h2>
      <p className="muted">
        入れると <strong>MP3 のカバー画像</strong>(配信アプリの一覧に出る絵)と
        <strong>切り抜き動画の背景</strong>に使われます。入れなければ単色のままです。
      </p>
      <label className="photo-pick">
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void take(f);
          }}
        />
        <span>{photo ? "別の写真に差し替える" : "写真を選ぶ"}</span>
      </label>
      {url && <img className="card-preview" src={url} alt="この回の写真" />}
      {photo && (
        <button onClick={drop}>写真を外す</button>
      )}
      {error && <p className="muted">⚠️ {error}</p>}
    </div>
  );
}
