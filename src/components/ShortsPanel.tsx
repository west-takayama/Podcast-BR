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

type Phase = "idle" | "extracting" | "finding" | "ready" | "captioning" | "rendering";

interface Nudge {
  start: number;
  end: number;
}

interface Result {
  blob: Blob;
  url: string;
}

const ZERO: Nudge = { start: 0, end: 0 };

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
  // 候補ごとに、範囲・字幕・書き出した動画をそれぞれ持つ。
  // まとめて書き出すときに1本ずつの状態が要るため。
  const [nudges, setNudges] = useState<Record<number, Nudge>>({});
  const [captions, setCaptions] = useState<Record<number, TranscriptSegment[]>>({});
  const [results, setResults] = useState<Record<number, Result>>({});
  const [withCaptions, setWithCaptions] = useState(true);
  const [cap, setCap] = useState<ClipCapability | null | undefined>(undefined);
  const [shared, setShared] = useState(-1);

  const fileRef = useRef<File | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 片付けのために、いま生きている URL を持っておく
  const urlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    loadClipLib()
      .then((m) => m.detectCapability())
      .then(setCap)
      .catch(() => setCap(null));
  }, []);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      workerRef.current?.terminate();
      abortRef.current?.abort();
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  const nudgeOf = (i: number) => nudges[i] ?? ZERO;

  const rangeOf = (i: number) => {
    const c = clips[i];
    if (!c) return { startSec: 0, endSec: 0 };
    const n = nudgeOf(i);
    const rawStart = (parseTimestamp(c.start) ?? 0) / 1000;
    const rawEnd = (parseTimestamp(c.end) ?? rawStart + 45) / 1000;
    const startSec = Math.max(0, rawStart + n.start);
    return { startSec, endSec: Math.max(startSec + 5, rawEnd + n.end) };
  };

  /** その候補の書き出し済み動画を捨てる。範囲や字幕を変えたら作り直しになるため。 */
  const dropResult = (i: number) =>
    setResults((prev) => {
      const r = prev[i];
      if (!r) return prev;
      URL.revokeObjectURL(r.url);
      urlsRef.current.delete(r.url);
      const next = { ...prev };
      delete next[i];
      return next;
    });

  /** 範囲を動かす。切り出して聴かせる音声そのものが変わるので、字幕も作り直す。 */
  const nudge = (i: number, key: keyof Nudge, delta: number) => {
    setNudges((prev) => {
      const n = prev[i] ?? ZERO;
      return { ...prev, [i]: { ...n, [key]: n[key] + delta } };
    });
    setCaptions((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    dropResult(i);
  };

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
    setNudges({});
    setCaptions({});
    for (const r of Object.values(results)) URL.revokeObjectURL(r.url);
    urlsRef.current.clear();
    setResults({});
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

  /**
   * その候補の字幕を作る。
   *
   * 「この区間の音声」だけを切り出して渡す。全編を聴かせて「12:34 から」と
   * 頼むと AI はファイルの頭から数えることになり、後ろの回ほど時刻がずれる。
   */
  const buildCaptions = async (i: number, signal: AbortSignal): Promise<TranscriptSegment[]> => {
    const existing = captions[i];
    if (existing) return existing;
    const file = fileRef.current!;
    const { startSec, endSec } = rangeOf(i);
    const { extractRangeMp3 } = await loadClipLib();
    setStatus("この区間の音声を取り出しています…");
    const rangeMp3 = await extractRangeMp3(file, startSec, endSec);
    const audio = await uploadEpisodeAudio(settings.apiKey, rangeMp3, setStatus, setProgress, signal);
    const raw = await transcribeRange({
      apiKey: settings.apiKey,
      model: settings.model,
      audio,
      startSec: 0,
      endSec: endSec - startSec,
      speakers: settings.prompt.speakers,
      glossary: settings.prompt.glossary,
      onStatus: setStatus,
      onModelChanged,
      signal,
    });
    const shifted = shiftSegments(raw, startSec);
    setCaptions((prev) => ({ ...prev, [i]: shifted }));
    return shifted;
  };

  /** 書き出す前に字幕を確認・修正できるようにする。焼き込んでからでは直せないため。 */
  const prepareCaptions = async () => {
    if (!fileRef.current || !clips[selected]) return;
    setError("");
    setPhase("captioning");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await buildCaptions(selected, controller.signal);
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

  const editCaption = (i: number, line: number, text: string) => {
    setCaptions((prev) => {
      const list = prev[i];
      if (!list) return prev;
      const next = list.slice();
      next[line] = { ...next[line], text };
      return { ...prev, [i]: next };
    });
    dropResult(i);
  };

  const removeCaption = (i: number, line: number) => {
    setCaptions((prev) => {
      const list = prev[i];
      if (!list) return prev;
      return { ...prev, [i]: list.filter((_, k) => k !== line) };
    });
    dropResult(i);
  };

  /** 1本書き出す。字幕は用意済みのものを使う(無ければその場で作る)。 */
  const renderOne = async (i: number, signal: AbortSignal) => {
    const file = fileRef.current!;
    const clip = clips[i];
    const { startSec, endSec } = rangeOf(i);
    const segments = withCaptions ? await buildCaptions(i, signal) : null;
    const { renderClip } = await loadClipLib();
    setStatus(`動画を書き出しています…(${clip.hook || `候補${i + 1}`})`);
    const blob = await renderClip({
      videoFile: file,
      startSec,
      endSec,
      hook: clip.hook,
      showName: settings.prompt.showName,
      accent: settings.accentColor,
      transcript: segments,
      onProgress: setProgress,
      signal,
      capability: cap ?? undefined,
    });
    const url = URL.createObjectURL(blob);
    urlsRef.current.add(url);
    setResults((prev) => {
      const old = prev[i];
      if (old) {
        URL.revokeObjectURL(old.url);
        urlsRef.current.delete(old.url);
      }
      return { ...prev, [i]: { blob, url } };
    });
  };

  /** 選んだ1本、または候補すべてを書き出す。 */
  const make = async (indexes: number[]) => {
    if (!fileRef.current || indexes.length === 0) return;
    setError("");
    setPhase("rendering");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for (let k = 0; k < indexes.length; k++) {
        if (indexes.length > 1) setStatus(`${k + 1}本目 / 全${indexes.length}本`);
        await renderOne(indexes[k], controller.signal);
      }
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
  const nameOf = (i: number) => `short${i + 1}.${ext}`;

  const canShare = (i: number) => {
    const r = results[i];
    return (
      typeof navigator !== "undefined" &&
      !!navigator.canShare &&
      !!r &&
      navigator.canShare({ files: [new File([r.blob], nameOf(i), { type: mime })] })
    );
  };

  const share = async (i: number) => {
    const r = results[i];
    if (!r) return;
    try {
      await navigator.share({
        files: [new File([r.blob], nameOf(i), { type: mime })],
        title: clips[i]?.hook,
      });
      setShared(i);
      setTimeout(() => setShared(-1), 2000);
    } catch {
      // 共有シートを閉じただけの場合もここに来る
    }
  };

  const busy =
    phase === "extracting" || phase === "finding" || phase === "rendering" || phase === "captioning";
  const { startSec, endSec } = rangeOf(selected);
  const lines = captions[selected];
  const doneCount = Object.keys(results).length;

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
            const r = rangeOf(i);
            return (
              <div
                key={i}
                className={`title-option${i === selected ? " chosen" : ""}`}
                onClick={() => setSelected(i)}
                style={{ display: "block" }}
              >
                <div style={{ fontWeight: 600 }}>
                  {i === selected ? "★ " : ""}
                  {results[i] ? "✅ " : ""}
                  {c.hook || "(見出しなし)"}
                </div>
                <div className="muted" style={{ marginTop: 4 }}>
                  {fmt(r.startSec)}〜{fmt(r.endSec)}({Math.round(r.endSec - r.startSec)}秒)
                  {c.why ? ` ・ ${c.why}` : ""}
                </div>
              </div>
            );
          })}

          <div className="clip-trim">
            <div className="muted">
              書き出す範囲: {fmt(startSec)} 〜 {fmt(endSec)}({Math.round(endSec - startSec)}秒)
            </div>
            <div className="row-buttons">
              <button onClick={() => nudge(selected, "start", -3)}>開始 -3秒</button>
              <button onClick={() => nudge(selected, "start", 3)}>開始 +3秒</button>
              <button onClick={() => nudge(selected, "end", -3)}>終了 -3秒</button>
              <button onClick={() => nudge(selected, "end", 3)}>終了 +3秒</button>
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

          {cap !== null && (
            <>
              {withCaptions && !lines && (
                <button onClick={prepareCaptions}>📝 先に字幕を作って確認する</button>
              )}
              <button className="primary" onClick={() => void make([selected])}>
                🎬 この範囲を縦型ショートにする
              </button>
              {clips.length > 1 && (
                <button onClick={() => void make(clips.map((_, i) => i))}>
                  📦 候補をまとめて書き出す({clips.length}本)
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* 焼き込む前に直せるようにする。動画にしてからでは直せない */}
      {lines && !busy && withCaptions && (
        <div className="card">
          <h2>📝 字幕の下書き</h2>
          <p className="muted">
            聞き間違いがあればここで直せます。直した内容がそのまま動画に焼き込まれます。
            <br />
            番組名や相方の名前をよく間違えるなら、設定の「この番組でよく出る言葉」に入れておくと次から間違えにくくなります。
          </p>
          {lines.length === 0 && <p className="muted">この区間では話し声が拾えませんでした。</p>}
          {lines.map((s, k) => (
            <div key={k} className="caption-row">
              <span className="muted caption-time">{s.time}</span>
              <input
                type="text"
                value={s.text}
                onChange={(e) => editCaption(selected, k, e.target.value)}
              />
              <button
                className="caption-del"
                onClick={() => removeCaption(selected, k)}
                title="この行を消す"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {doneCount > 0 && !busy && (
        <div className="card">
          <h2>📱 書き出した動画({doneCount}本)</h2>
          {clips.map((c, i) => {
            const r = results[i];
            if (!r) return null;
            return (
              <div key={i} className="clip-result">
                <p style={{ fontWeight: 600, margin: "0 0 6px" }}>{c.hook || `候補${i + 1}`}</p>
                <video className="card-preview" src={r.url} controls playsInline />
                {canShare(i) && (
                  <button className="primary" onClick={() => void share(i)}>
                    {shared === i ? "✓ 共有しました" : "📤 共有 / 写真に保存"}
                  </button>
                )}
                <a className="dl" href={r.url} download={nameOf(i)}>
                  ⬇️ {ext.toUpperCase()} をダウンロード({Math.round(r.blob.size / 1024 / 1024)} MB)
                </a>
              </div>
            );
          })}
        </div>
      )}

      {clips.length > 0 && !busy && (
        <div className="card">
          <button
            onClick={() => {
              setClips([]);
              setPhase("idle");
              fileRef.current = null;
              setNudges({});
              setCaptions({});
              for (const r of Object.values(results)) URL.revokeObjectURL(r.url);
              urlsRef.current.clear();
              setResults({});
            }}
          >
            別の動画にする
          </button>
        </div>
      )}
    </>
  );
}
