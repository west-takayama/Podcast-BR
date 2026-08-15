import { useEffect, useRef, useState } from "react";
import type { Clip, TranscriptSegment } from "../lib/gemini";
import { parseTimestamp } from "../lib/id3";
import type { ClipCapability } from "../lib/video/clip";

// 動画の書き出しには mediabunny のエンコーダが要る。起動時に読み込むと
// 変換にたどり着く前の待ち時間が伸びるので、結果画面に来てから取りに行く。
const loadClipLib = () => import("../lib/video/clip");

interface Props {
  clips: Clip[];
  /** 配信用 MP3 の URL。ここから区間だけデコードする。 */
  audioUrl?: string;
  transcript?: TranscriptSegment[] | null;
  showName: string;
  accent: string;
  /** 背景に敷く写真(告知画像で取り込んだもの)。 */
  background?: ImageBitmap | null;
  fileName: string;
}

const fmt = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export default function ClipStudio({
  clips,
  audioUrl,
  transcript,
  showName,
  accent,
  background,
  fileName,
}: Props) {
  const [selected, setSelected] = useState(0);
  const [nudge, setNudge] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  // null は判定前、false は書き出せない端末
  const [cap, setCap] = useState<ClipCapability | null | undefined>(undefined);
  const [shared, setShared] = useState(false);
  // 音声が端末に残っていない回のために、その場で選んでもらった MP3
  const [picked, setPicked] = useState<{ url: string; name: string; durationSec: number } | null>(
    null,
  );
  const [pickError, setPickError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // 片付け用。作った URL を全部覚えておく(二重に解放しても害はない)
  const madeUrls = useRef<string[]>([]);
  const keep = (url: string) => {
    madeUrls.current.push(url);
    return url;
  };

  useEffect(() => {
    loadClipLib()
      .then((m) => m.detectCapability())
      .then(setCap)
      .catch(() => setCap(null));
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      // 出来上がった動画は数十MBになる。閉じたら手放す
      madeUrls.current.forEach(URL.revokeObjectURL);
      madeUrls.current = [];
    };
  }, []);

  // 候補を選び直したら、前の書き出しは意味を失う
  useEffect(() => {
    setNudge({ start: 0, end: 0 });
    setVideoBlob(null);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
  }, [selected]);

  if (clips.length === 0) return null;

  const clip = clips[selected];
  const rawStart = (parseTimestamp(clip.start) ?? 0) / 1000;
  const rawEnd = (parseTimestamp(clip.end) ?? rawStart + 45) / 1000;
  const startSec = Math.max(0, rawStart + nudge.start);
  const endSec = Math.max(startSec + 5, rawEnd + nudge.end);
  const duration = endSec - startSec;

  /**
   * 選ばれた音声の長さを先に確かめる。
   *
   * 時刻はこのアプリが書き出した MP3 を基準にしている。収録時の元ファイルや
   * 別の回を選ぶと、無関係な場所が切り出される。長さを見れば大半は弾ける。
   */
  const pick = async (file: File) => {
    setPickError("");
    const url = keep(URL.createObjectURL(file));
    const durationSec = await new Promise<number>((resolve) => {
      const el = new Audio();
      el.preload = "metadata";
      el.onloadedmetadata = () => resolve(el.duration);
      el.onerror = () => resolve(NaN);
      el.src = url;
    });
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      setPickError("この音声を読み取れませんでした。別のファイルをお試しください。");
      return;
    }
    setPicked({ url, name: file.name, durationSec });
  };

  const source = audioUrl || picked?.url || "";
  // 選んだ音声が短すぎる = 別の回か、元の収録ファイルを選んでいる
  const tooShort = picked && !audioUrl && picked.durationSec < rawEnd - 1;

  const make = async () => {
    if (!source) return;
    setError("");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { renderClip } = await loadClipLib();
      const mp3 = await (await fetch(source)).arrayBuffer();
      const blob = await renderClip({
        mp3,
        startSec,
        endSec,
        hook: clip.hook,
        showName,
        accent,
        background: background ?? undefined,
        transcript,
        onProgress: setProgress,
        signal: controller.signal,
        capability: cap ?? undefined,
      });
      setVideoBlob(blob);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return keep(URL.createObjectURL(blob));
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const ext = cap?.mp4 === false ? "webm" : "mp4";
  const mime = ext === "mp4" ? "video/mp4" : "video/webm";
  const clipName = `${fileName.replace(/\.mp3$/i, "")}-clip${selected + 1}.${ext}`;
  const canShare =
    typeof navigator !== "undefined" &&
    !!navigator.canShare &&
    !!videoBlob &&
    navigator.canShare({ files: [new File([videoBlob], clipName, { type: mime })] });

  const share = async () => {
    if (!videoBlob) return;
    try {
      await navigator.share({
        files: [new File([videoBlob], clipName, { type: mime })],
        title: clip.hook,
      });
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // 共有シートを閉じただけの場合もここに来るため、エラーにはしない
    }
  };

  return (
    <div className="card">
      <h2>✂️ 切り抜き(縦型ショート)</h2>
      <p className="muted">
        音声を聴いた AI が「単体で完結して面白い」区間を選びました。TikTok / Reels / Shorts
        に上げる用の縦型動画にできます。
      </p>

      {clips.map((c, i) => {
        const s = (parseTimestamp(c.start) ?? 0) / 1000;
        const e = (parseTimestamp(c.end) ?? s) / 1000;
        return (
          <div
            key={i}
            className={`title-option${i === selected ? " chosen" : ""}`}
            onClick={() => setSelected(i)}
            style={{ display: "block" }}
          >
            <div style={{ fontWeight: 600 }}>
              {i === selected ? "★ " : ""}
              {c.hook || "(見出しなし)"}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              {fmt(s)}〜{fmt(e)}({Math.round(e - s)}秒){c.why ? ` ・ ${c.why}` : ""}
            </div>
          </div>
        );
      })}

      <div className="clip-trim">
        <div className="muted">
          書き出す範囲: {fmt(startSec)} 〜 {fmt(endSec)}({Math.round(duration)}秒)
        </div>
        <div className="row-buttons">
          <button onClick={() => setNudge((n) => ({ ...n, start: n.start - 3 }))}>開始 -3秒</button>
          <button onClick={() => setNudge((n) => ({ ...n, start: n.start + 3 }))}>開始 +3秒</button>
          <button onClick={() => setNudge((n) => ({ ...n, end: n.end - 3 }))}>終了 -3秒</button>
          <button onClick={() => setNudge((n) => ({ ...n, end: n.end + 3 }))}>終了 +3秒</button>
        </div>
        {source && (
          // 書き出す前に耳で確かめられるようにする。範囲の調整はこれを聴きながら
          <audio
            controls
            preload="none"
            src={`${source}#t=${startSec.toFixed(1)},${endSec.toFixed(1)}`}
            style={{ width: "100%", marginTop: 10 }}
          />
        )}
      </div>

      {!audioUrl && (
        <div className="clip-source">
          <p className="muted">
            この回の音声は端末に残っていません(容量のため、音声は直近5回ぶんだけ残しています)。
            <strong>このアプリで書き出した MP3 を選べば、この回も切り抜けます。</strong>
            <br />
            時刻は書き出した MP3 を基準にしているので、収録時の元ファイルではなく
            <strong>ダウンロードした MP3</strong> を選んでください。
          </p>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
            }}
          />
          {picked && (
            <p className="muted">
              選んだ音声: {picked.name}({fmt(picked.durationSec)})
            </p>
          )}
          {pickError && <p className="muted">⚠️ {pickError}</p>}
          {tooShort && (
            <p className="muted">
              ⚠️ 選んだ音声({fmt(picked.durationSec)})が、切り抜きたい位置({fmt(rawEnd)})より
              短いです。別の回か、収録時の元ファイルを選んでいる可能性があります。
            </p>
          )}
        </div>
      )}

      {error && <p className="muted">⚠️ {error}</p>}

      {progress !== null ? (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="muted">動画を書き出しています… {Math.round(progress * 100)}%</p>
        </>
      ) : (
        cap !== null && (
          <button className="primary" onClick={make} disabled={!source || cap === undefined}>
            🎬 この範囲を縦型動画にする
          </button>
        )
      )}

      {cap === null && (
        <p className="muted">
          この端末では動画を書き出せません(WebCodecs 非対応)。ブラウザを更新するか、パソコンでお試しください。
        </p>
      )}
      {cap && !cap.mp4 && (
        <p className="muted">
          この端末には H.264 が入っていないため WebM で書き出します。YouTube には上げられますが、
          Instagram と TikTok は MP4 しか受け付けません。
        </p>
      )}

      {videoUrl && (
        <>
          <video className="card-preview" src={videoUrl} controls playsInline />
          {canShare && (
            <button className="primary" onClick={share}>
              {shared ? "✓ 共有しました" : "📤 共有 / 写真に保存"}
            </button>
          )}
          <a className="dl" href={videoUrl} download={clipName}>
            ⬇️ {ext.toUpperCase()} をダウンロード({videoBlob ? Math.round(videoBlob.size / 1024 / 1024) : 0} MB)
          </a>
        </>
      )}

      <p className="muted" style={{ marginTop: 12 }}>
        見出しは動画の上部に大きく出ます。
        {transcript
          ? "字幕は書き起こしから自動で入ります。"
          : "ショートは音を出さずに見られることが多いので、上の「全文書き起こし」を作ってから書き出すと字幕が入ります。"}
      </p>
    </div>
  );
}
