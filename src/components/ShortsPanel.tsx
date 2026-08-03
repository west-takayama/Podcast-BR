import { useEffect, useRef, useState } from "react";
import {
  findClips,
  transcribeRange,
  uploadEpisodeAudio,
  type Clip,
  type TranscriptSegment,
} from "../lib/gemini";
import { parseTimestamp } from "../lib/id3";
import type { Settings } from "../lib/settings";
import type { ClipCapability } from "../lib/video/clip";

// エンコーダは重いので、このページを開いてから取りに行く
const loadClipLib = () => import("../lib/video/clip");

interface Props {
  settings: Settings;
  onModelChanged: (model: string) => void;
}

type Phase = "idle" | "extracting" | "finding" | "ready" | "rendering";

const fmt = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** 秒を "MM:SS.S" に。字幕の時刻は小数第1位まで持つ。 */
const fmtFine = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

/**
 * 切り出した音声だけを聴かせて書き起こすので、返ってくる時刻は 0 起点。
 * 動画全体の時間軸に戻してから字幕として使う。
 */
const shiftSegments = (segments: TranscriptSegment[], offsetSec: number): TranscriptSegment[] =>
  segments.map((s) => {
    const ms = parseTimestamp(s.time);
    return ms === null ? s : { ...s, time: fmtFine(ms / 1000 + offsetSec) };
  });

/**
 * 動画から縦型ショートを作るページ。
 *
 * 収録の回とは別に、撮った動画をそのまま投げ込めるようにしている。
 * 音声だけを Gemini に聴かせて面白い区間を選ばせ、映像はその区間を
 * 端末内で切り出す。動画そのものはどこにも送らない。
 */
export default function ShortsPanel({ settings, onModelChanged }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [fileInfo, setFileInfo] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [selected, setSelected] = useState(0);
  const [nudge, setNudge] = useState({ start: 0, end: 0 });
  const [captions, setCaptions] = useState<TranscriptSegment[] | null>(null);
  const [withCaptions, setWithCaptions] = useState(true);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [cap, setCap] = useState<ClipCapability | null | undefined>(undefined);
  const [shared, setShared] = useState(false);

  const fileRef = useRef<File | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadClipLib()
      .then((m) => m.detectCapability())
      .then(setCap)
      .catch(() => setCap(null));
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setNudge({ start: 0, end: 0 });
  }, [selected]);

  // 範囲を動かしたら字幕は作り直す。切り出して聴かせる音声そのものが変わる
  useEffect(() => {
    setCaptions(null);
    setVideoBlob(null);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
  }, [selected, nudge.start, nudge.end]);

  /** 動画から AI に聴かせる用の音声だけを取り出す(無音カットはしない)。 */
  const extractAudio = (file: File): Promise<{ mp3: ArrayBuffer; durationSec: number }> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../lib/encoder.worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "progress") setProgress(msg.fraction ?? 0);
        else if (msg.type === "done") {
          worker.terminate();
          workerRef.current = null;
          // 長さを渡さないと、短い動画で「30〜60秒の区間を3つ」が無理になる
          resolve({ mp3: msg.aiMp3, durationSec: msg.durationSec ?? 0 });
        } else if (msg.type === "error") {
          worker.terminate();
          workerRef.current = null;
          reject(new Error(msg.message));
        }
      };
      worker.onerror = () => reject(new Error("動画から音声を取り出せませんでした"));
      worker.postMessage({
        file,
        // 配信用 MP3 も音量合わせも要らない。AI に聴かせるぶんだけ1回で作る
        // (10分の素材で 17秒 → 4秒 になる)
        purpose: "ai",
        // 無音カットを有効にすると音声と映像の時刻がずれるため、必ず切っておく
        dsp: { ...settings.dsp, trimSilence: false },
        mono: true,
        bitrate: settings.bitrate,
      });
    });

  const handleFile = async (file: File) => {
    if (!settings.apiKey) {
      setError("先に設定画面で Gemini API キーを入力してください");
      return;
    }
    fileRef.current = file;
    setClips([]);
    setSelected(0);
    setError("");
    setFileInfo(`${file.name}(${(file.size / 1024 / 1024).toFixed(0)} MB)`);
    setPhase("extracting");
    setStatus("動画から音声を取り出しています…");
    setProgress(0);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { mp3, durationSec } = await extractAudio(file);
      setPhase("finding");
      setProgress(0);
      const found = await findClips({
        apiKey: settings.apiKey,
        model: settings.model,
        mp3,
        durationSec,
        onStatus: setStatus,
        onUploadProgress: setProgress,
        onModelChanged,
        signal: controller.signal,
      });
      setClips(found);
      setPhase("ready");
      setStatus("");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase(clips.length > 0 ? "ready" : "idle");
    } finally {
      abortRef.current = null;
    }
  };

  const clip = clips[selected];
  const rawStart = clip ? (parseTimestamp(clip.start) ?? 0) / 1000 : 0;
  const rawEnd = clip ? (parseTimestamp(clip.end) ?? rawStart + 45) / 1000 : 0;
  const startSec = Math.max(0, rawStart + nudge.start);
  const endSec = Math.max(startSec + 5, rawEnd + nudge.end);

  const make = async () => {
    const file = fileRef.current;
    if (!file || !clip) return;
    setError("");
    setPhase("rendering");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { extractRangeMp3, renderClip } = await loadClipLib();

      // 字幕はこの区間だけ書き起こす。全編より速く、無料枠も食わない。
      // しかも「この区間の音声」だけを切り出して渡す。全編を聴かせて
      // 「12:34 から」と頼むと AI はファイルの頭から数えることになり、
      // 後ろの回ほど時刻がずれる(実際に数秒ずれていた)。
      let segments = captions;
      if (withCaptions && !segments) {
        setStatus("この区間の音声を取り出しています…");
        const rangeMp3 = await extractRangeMp3(file, startSec, endSec);
        const audio = await uploadEpisodeAudio(
          settings.apiKey,
          rangeMp3,
          setStatus,
          setProgress,
          controller.signal,
        );
        const raw = await transcribeRange({
          apiKey: settings.apiKey,
          model: settings.model,
          audio,
          startSec: 0,
          endSec: endSec - startSec,
          speakers: settings.prompt.speakers,
          onStatus: setStatus,
          onModelChanged,
          signal: controller.signal,
        });
        segments = shiftSegments(raw, startSec);
        setCaptions(segments);
      }

      setStatus("動画を書き出しています…");
      const blob = await renderClip({
        videoFile: file,
        startSec,
        endSec,
        hook: clip.hook,
        showName: settings.prompt.showName,
        accent: settings.accentColor,
        transcript: withCaptions ? segments : null,
        onProgress: setProgress,
        signal: controller.signal,
        capability: cap ?? undefined,
      });
      setVideoBlob(blob);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPhase("ready");
      setStatus("");
      abortRef.current = null;
    }
  };

  const ext = cap?.mp4 === false ? "webm" : "mp4";
  const mime = ext === "mp4" ? "video/mp4" : "video/webm";
  const clipName = `short${selected + 1}.${ext}`;
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
        title: clip?.hook,
      });
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // 共有シートを閉じただけの場合もここに来る
    }
  };

  const busy = phase === "extracting" || phase === "finding" || phase === "rendering";

  return (
    <>
      {error && <div className="error">⚠️ {error}</div>}

      {phase === "idle" && clips.length === 0 && (
        <label className="drop card">
          <input
            type="file"
            accept="video/*,.mp4,.mov,.m4v,.webm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          <p style={{ fontSize: "2rem", margin: "0 0 8px" }}>🎬</p>
          <p style={{ margin: 0, fontWeight: 600 }}>動画をここから選択</p>
          <p className="muted">
            MP4 / MOV など。音声を聴いた AI が、ショートに向いた区間を自動で探します。
            <br />
            動画そのものは端末から出ません(送るのは音声だけです)
          </p>
        </label>
      )}

      {busy && (
        <div className="card">
          <h2>⏳ {status || "処理中…"}</h2>
          <p className="muted">{fileInfo}</p>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <button
            onClick={() => {
              abortRef.current?.abort();
              workerRef.current?.terminate();
              workerRef.current = null;
              setPhase(clips.length > 0 ? "ready" : "idle");
            }}
          >
            やめる
          </button>
        </div>
      )}

      {clips.length > 0 && !busy && (
        <div className="card">
          <h2>✂️ ショートの候補</h2>
          <p className="muted">{fileInfo}</p>

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
              書き出す範囲: {fmt(startSec)} 〜 {fmt(endSec)}({Math.round(endSec - startSec)}秒)
            </div>
            <div className="row-buttons">
              <button onClick={() => setNudge((n) => ({ ...n, start: n.start - 3 }))}>開始 -3秒</button>
              <button onClick={() => setNudge((n) => ({ ...n, start: n.start + 3 }))}>開始 +3秒</button>
              <button onClick={() => setNudge((n) => ({ ...n, end: n.end - 3 }))}>終了 -3秒</button>
              <button onClick={() => setNudge((n) => ({ ...n, end: n.end + 3 }))}>終了 +3秒</button>
            </div>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={withCaptions}
              onChange={(e) => setWithCaptions(e.target.checked)}
            />
            <span>
              字幕を入れる
              <br />
              <span className="muted">
                この区間だけを書き起こします。ショートは音を出さずに見られることが多いので、入れたほうが伸びます。
              </span>
            </span>
          </label>

          {cap !== null && (
            <button className="primary" onClick={make}>
              🎬 この範囲を縦型ショートにする
            </button>
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
                ⬇️ {ext.toUpperCase()} をダウンロード(
                {videoBlob ? Math.round(videoBlob.size / 1024 / 1024) : 0} MB)
              </a>
            </>
          )}

          <button
            onClick={() => {
              setClips([]);
              setPhase("idle");
              fileRef.current = null;
              setVideoBlob(null);
              setVideoUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return "";
              });
            }}
          >
            別の動画にする
          </button>
        </div>
      )}
    </>
  );
}
