import { useEffect, useRef, useState } from "react";
import { generateEpisodeMeta, type EpisodeMeta } from "./lib/gemini";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { saveEpisode, updateEpisode } from "./lib/history";
import SettingsPanel from "./components/SettingsPanel";
import ResultView from "./components/ResultView";
import HistoryPanel from "./components/HistoryPanel";

type Tab = "create" | "history" | "settings";
type Phase = "idle" | "processing" | "generating" | "done";

const STAGE_LABELS: Record<string, string> = {
  decode: "WAVを読み込み中",
  dsp: "音声を整音中",
  encode: "MP3に変換中",
};

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<Tab>(() => (loadSettings().apiKey ? "create" : "settings"));
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState("decode");
  const [percent, setPercent] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<EpisodeMeta | null>(null);
  const [episodeId, setEpisodeId] = useState("");
  const [chosenTitle, setChosenTitle] = useState("");
  const [mp3Url, setMp3Url] = useState("");
  const [fileInfo, setFileInfo] = useState("");
  const [outputName, setOutputName] = useState("episode.mp3");

  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mp3UrlRef = useRef("");

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    mp3UrlRef.current = mp3Url;
  }, [mp3Url]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      abortRef.current?.abort();
      if (mp3UrlRef.current) URL.revokeObjectURL(mp3UrlRef.current);
    };
  }, []);

  // 処理中の離脱で結果を失わないよう警告する
  useEffect(() => {
    if (phase !== "processing" && phase !== "generating") return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  const reset = () => {
    setPhase("idle");
    setError("");
    setMeta(null);
    setPercent(0);
    setEpisodeId("");
    setChosenTitle("");
    if (mp3Url) URL.revokeObjectURL(mp3Url);
    setMp3Url("");
  };

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    reset();
  };

  const handleFile = async (file: File) => {
    if (!settings.apiKey) {
      setTab("settings");
      setError("先に設定画面で Gemini API キーを入力してください(無料で発行できます)");
      return;
    }
    reset();
    setPhase("processing");
    setStage("decode");
    setFileInfo(`${file.name}(${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    setOutputName(file.name.replace(/\.wav$/i, "") + ".mp3");

    try {
      const buffer = await file.arrayBuffer();
      const result = await new Promise<{
        mp3: ArrayBuffer;
        durationSec: number;
        removedSec: number;
      }>((resolve, reject) => {
        const worker = new Worker(new URL("./lib/encoder.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === "progress") {
            setStage(msg.stage);
            setPercent(msg.percent);
          } else if (msg.type === "done") {
            resolve({ mp3: msg.mp3, durationSec: msg.durationSec, removedSec: msg.removedSec });
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          }
        };
        worker.onerror = () => reject(new Error("変換処理でエラーが発生しました"));
        worker.postMessage({ buffer, dsp: settings.dsp }, [buffer]);
      });
      workerRef.current?.terminate();
      workerRef.current = null;

      const blob = new Blob([result.mp3], { type: "audio/mpeg" });
      setMp3Url(URL.createObjectURL(blob));

      setPhase("generating");
      const controller = new AbortController();
      abortRef.current = controller;
      const generated = await generateEpisodeMeta({
        apiKey: settings.apiKey,
        model: settings.model,
        mp3: result.mp3,
        config: settings.prompt,
        onStatus: setStatusText,
        signal: controller.signal,
      });
      abortRef.current = null;

      setMeta(generated);
      setChosenTitle(generated.titles[0] ?? "");
      setPhase("done");

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
        chosenTitle: generated.titles[0] ?? "",
        audio: blob,
      }).catch(() => setError("結果は表示できましたが、履歴の保存に失敗しました(端末の空き容量をご確認ください)"));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const busy = phase === "processing" || phase === "generating";

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
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setTab("create")}
        />
      )}

      {tab === "history" && (
        <HistoryPanel
          onChooseTitle={(id, title) => {
            updateEpisode(id, { chosenTitle: title });
          }}
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

          {busy && (
            <div className="card">
              <h2>処理中: {fileInfo}</h2>
              <ul className="steps">
                <li className={phase === "processing" ? "active" : "done"}>
                  {phase === "processing"
                    ? `▶ ${STAGE_LABELS[stage] ?? "処理中"} (${percent}%)`
                    : "✓ 整音・MP3変換"}
                </li>
                <li className={phase === "generating" ? "active" : ""}>
                  {phase === "generating" ? `▶ ${statusText}` : "タイトル・説明文を生成"}
                </li>
              </ul>
              {phase === "processing" && (
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${percent}%` }} />
                </div>
              )}
              <p className="muted" style={{ marginTop: 12 }}>
                画面を閉じずにお待ちください。長いエピソードほど時間がかかります。
              </p>
              <button onClick={cancel}>キャンセル</button>
            </div>
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
