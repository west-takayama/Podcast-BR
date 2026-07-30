import { useEffect, useRef, useState } from "react";
import { generateEpisodeMeta, type EpisodeMeta } from "./lib/gemini";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { saveEpisode, updateEpisode } from "./lib/history";
import { estimateRemainingMs, overallProgress, type Stage } from "./lib/progress";
import { attachId3, buildId3Tag, toId3Chapters } from "./lib/id3";
import { renderArtworkJpeg } from "./lib/image";
import { ScreenWakeLock } from "./lib/wakeLock";
import { applyAccent } from "./lib/theme";
import SettingsPanel from "./components/SettingsPanel";
import ResultView from "./components/ResultView";
import HistoryPanel from "./components/HistoryPanel";
import ProgressPanel from "./components/ProgressPanel";

type Tab = "create" | "history" | "settings";
type Phase = "idle" | "running" | "done";

/** 仕上がりの実測値。狙い通りかを利用者に示すために持つ。 */
export interface AudioReport {
  sourceLufs: number;
  outputLufs: number;
  targetLufs: number;
  peakDbfs: number;
  channels: number;
  bitrate: number;
  removedSec: number;
  limitedSamples: number;
  sampleRate: number;
  /** リミッターの効きを見て足し戻したゲイン(dB)。0 なら補正不要だった。 */
  correctionDb: number;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<Tab>(() => (loadSettings().apiKey ? "create" : "settings"));
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<Stage>("analyze");
  const [overall, setOverall] = useState(0);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<EpisodeMeta | null>(null);
  const [episodeId, setEpisodeId] = useState("");
  const [chosenTitle, setChosenTitle] = useState("");
  const [mp3Url, setMp3Url] = useState("");
  const [fileInfo, setFileInfo] = useState("");
  const [outputName, setOutputName] = useState("episode.mp3");
  const [audioReport, setAudioReport] = useState<AudioReport | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mp3UrlRef = useRef("");
  const startedAtRef = useRef(0);
  const wakeLockRef = useRef(new ScreenWakeLock());
  // 残り時間がちらつかないよう、指数移動平均でならしてから表示する
  const smoothedRemainingRef = useRef<number | null>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    applyAccent(settings.accentColor);
  }, [settings.accentColor]);

  useEffect(() => {
    mp3UrlRef.current = mp3Url;
  }, [mp3Url]);

  useEffect(() => {
    const wakeLock = wakeLockRef.current;
    return () => {
      workerRef.current?.terminate();
      abortRef.current?.abort();
      void wakeLock.stop();
      if (mp3UrlRef.current) URL.revokeObjectURL(mp3UrlRef.current);
    };
  }, []);

  // 処理中の離脱で結果を失わないよう警告する
  useEffect(() => {
    if (phase !== "running") return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  const advance = (nextStage: Stage, fraction: number, text = "") => {
    const progress = overallProgress(nextStage, fraction);
    setStage(nextStage);
    setOverall(progress);
    setDetail(text);

    const raw = estimateRemainingMs(Date.now() - startedAtRef.current, progress);
    if (raw === null) {
      setRemainingMs(null);
      return;
    }
    const prev = smoothedRemainingRef.current;
    // 残り時間は減る方向に素早く、増える方向には緩やかに追従させる
    const next = prev === null ? raw : raw < prev ? raw * 0.6 + prev * 0.4 : raw * 0.25 + prev * 0.75;
    smoothedRemainingRef.current = next;
    setRemainingMs(next);
  };

  const reset = () => {
    setPhase("idle");
    setError("");
    setMeta(null);
    setOverall(0);
    setRemainingMs(null);
    smoothedRemainingRef.current = null;
    setEpisodeId("");
    setChosenTitle("");
    setAudioReport(null);
    if (mp3Url) URL.revokeObjectURL(mp3Url);
    setMp3Url("");
  };

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    void wakeLockRef.current.stop();
    reset();
  };

  /** MP3 に ID3 タグ(タイトル・番組名・説明・アートワーク・チャプター)を付ける。 */
  const buildTaggedMp3 = async (
    mp3: ArrayBuffer,
    generated: EpisodeMeta,
    title: string,
    durationSec: number,
  ): Promise<Blob> => {
    try {
      const artwork = await renderArtworkJpeg({
        quote: generated.imageQuote || title,
        title,
        showName: settings.prompt.showName,
        accent: settings.accentColor,
      });
      const tag = buildId3Tag({
        title,
        showName: settings.prompt.showName,
        description: generated.description,
        artwork: { data: artwork, mime: "image/jpeg" },
        chapters: toId3Chapters(generated.chapters, durationSec * 1000),
        durationMs: durationSec * 1000,
      });
      return attachId3(mp3, tag);
    } catch {
      // タグ付けに失敗しても音声そのものは渡せるようにする
      return new Blob([mp3], { type: "audio/mpeg" });
    }
  };

  const handleFile = async (file: File) => {
    if (!settings.apiKey) {
      setTab("settings");
      setError("先に設定画面で Gemini API キーを入力してください(無料で発行できます)");
      return;
    }
    reset();
    setPhase("running");
    setStage("analyze");
    startedAtRef.current = Date.now();
    setFileInfo(`${file.name}(${(file.size / 1024 / 1024).toFixed(0)} MB)`);
    setOutputName(file.name.replace(/\.wav$/i, "") + ".mp3");
    void wakeLockRef.current.start();

    try {
      const result = await new Promise<{
        mp3: ArrayBuffer;
        aiMp3: ArrayBuffer;
        durationSec: number;
        removedSec: number;
        channels: number;
        sampleRate: number;
        sourceLufs: number;
        outputLufs: number;
        targetLufs: number;
        peakDbfs: number;
        limitedSamples: number;
        correctionDb: number;
      }>((resolve, reject) => {
        const worker = new Worker(new URL("./lib/encoder.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === "progress") {
            advance(msg.stage, msg.fraction);
          } else if (msg.type === "done") {
            resolve(msg);
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          }
        };
        worker.onerror = () => reject(new Error("変換処理でエラーが発生しました"));
        worker.postMessage({
          file,
          dsp: settings.dsp,
          mono: settings.mono,
          bitrate: settings.bitrate,
        });
      });
      workerRef.current?.terminate();
      workerRef.current = null;

      setAudioReport({
        sourceLufs: result.sourceLufs,
        outputLufs: result.outputLufs,
        targetLufs: result.targetLufs,
        peakDbfs: result.peakDbfs,
        channels: result.channels,
        bitrate: settings.bitrate,
        removedSec: result.removedSec,
        limitedSamples: result.limitedSamples,
        sampleRate: result.sampleRate,
        correctionDb: result.correctionDb,
      });

      // 生成前でもダウンロードできるよう、まずタグ無しで出しておく
      setMp3Url(URL.createObjectURL(new Blob([result.mp3], { type: "audio/mpeg" })));

      advance("upload", 0);
      const controller = new AbortController();
      abortRef.current = controller;
      const generated = await generateEpisodeMeta({
        apiKey: settings.apiKey,
        model: settings.model,
        mp3: result.aiMp3,
        config: settings.prompt,
        onStatus: (text) => {
          if (text.includes("生成")) advance("generate", 0.15, text);
          else if (text.includes("解析")) advance("upload", 1, text);
        },
        onUploadProgress: (f) =>
          advance("upload", f, `${(result.aiMp3.byteLength / 1024 / 1024).toFixed(0)} MB 送信中`),
        // 廃止されたモデルから自動で切り替わったら、次回以降のために保存し直す
        onModelChanged: (m) => setSettings((s) => ({ ...s, model: m })),
        signal: controller.signal,
      });
      abortRef.current = null;
      void wakeLockRef.current.stop();

      const title = generated.titles[0] ?? "";

      // タイトルとチャプターが揃ってから ID3 タグを付ける。
      // アートワークも埋め込むので、プレイヤーで番組として正しく表示される。
      // 結果画面を出す前に差し替えないと、タグ無しの MP3 をダウンロードされうる。
      const blob = await buildTaggedMp3(result.mp3, generated, title, result.durationSec);
      setMp3Url((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });

      setMeta(generated);
      setChosenTitle(title);
      setPhase("done");
      window.scrollTo({ top: 0 });

      const id = crypto.randomUUID();
      setEpisodeId(id);
      // 履歴保存の失敗(容量不足など)で結果表示まで巻き添えにしない
      saveEpisode({
        id,
        createdAt: Date.now(),
        fileName: file.name,
        durationSec: result.durationSec,
        removedSec: result.removedSec,
        meta: generated,
        chosenTitle: title,
        audio: blob,
      }).catch(() =>
        setError(
          "結果は表示できましたが、履歴の保存に失敗しました(端末の空き容量をご確認ください)",
        ),
      );
    } catch (err) {
      void wakeLockRef.current.stop();
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  return (
    <>
      <header>
        <h1>🎙️ Podcast BR</h1>
        <nav className="tabs">
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>
            作成
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            履歴
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            設定
          </button>
        </nav>
      </header>

      {error && (
        <div className="error">
          ⚠️ {error}
          {mp3Url && phase !== "done" && (
            <a className="dl" href={mp3Url} download={outputName}>
              ⬇️ 変換済み MP3 をダウンロード
            </a>
          )}
        </div>
      )}

      {tab === "settings" && (
        <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setTab("create")} />
      )}

      {tab === "history" && (
        <HistoryPanel
          onChooseTitle={(id, title) => {
            updateEpisode(id, { chosenTitle: title });
          }}
          showName={settings.prompt.showName}
          accentColor={settings.accentColor}
          apiKey={settings.apiKey}
          imageModel={settings.imageModel || null}
        />
      )}

      {tab === "create" && (
        <>
          {phase === "idle" && (
            <label className="drop card">
              <input
                type="file"
                accept=".wav,audio/wav,audio/x-wav"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
              <p style={{ fontSize: "2rem", margin: "0 0 8px" }}>📤</p>
              <p style={{ margin: 0, fontWeight: 600 }}>収録した .WAV をここから選択</p>
              <p className="muted">整音 → 変換 → タイトル・説明文の生成まで自動で進みます</p>
            </label>
          )}

          {phase === "running" && (
            <ProgressPanel
              fileInfo={fileInfo}
              stage={stage}
              overall={overall}
              remainingMs={remainingMs}
              detail={detail}
              onCancel={cancel}
            />
          )}

          {phase === "done" && meta && (
            <>
              <ResultView
                meta={meta}
                chosenTitle={chosenTitle}
                onChooseTitle={(title) => {
                  setChosenTitle(title);
                  if (episodeId) updateEpisode(episodeId, { chosenTitle: title });
                }}
                audioUrl={mp3Url}
                fileName={outputName}
                showName={settings.prompt.showName}
                accentColor={settings.accentColor}
                apiKey={settings.apiKey}
                imageModel={settings.imageModel || null}
                audioReport={audioReport}
              />
              <button className="primary" onClick={reset}>
                次のエピソードを処理する
              </button>
            </>
          )}
        </>
      )}
    </>
  );
}
