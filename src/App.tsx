import { useEffect, useRef, useState } from "react";
import { generateEpisodeMeta, type EpisodeMeta } from "./lib/gemini";

type Phase = "idle" | "converting" | "generating" | "done";

interface Settings {
  apiKey: string;
  model: string;
  showContext: string;
}

const SETTINGS_KEY = "podcast-br-settings";
const DEFAULT_MODEL = "gemini-2.5-flash";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { model: DEFAULT_MODEL, ...JSON.parse(raw) };
  } catch {
    /* 破損時はデフォルトに戻す */
  }
  return { apiKey: "", model: DEFAULT_MODEL, showContext: "" };
}

function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`copy-btn${copied ? " copied" : ""}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "✓ コピー済み" : label}
    </button>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(!loadSettings().apiKey);
  const [phase, setPhase] = useState<Phase>("idle");
  const [convertPercent, setConvertPercent] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<EpisodeMeta | null>(null);
  const [mp3Url, setMp3Url] = useState("");
  const [fileInfo, setFileInfo] = useState("");
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (mp3Url) URL.revokeObjectURL(mp3Url);
    };
  }, [mp3Url]);

  const reset = () => {
    setPhase("idle");
    setError("");
    setMeta(null);
    setConvertPercent(0);
    if (mp3Url) URL.revokeObjectURL(mp3Url);
    setMp3Url("");
  };

  const handleFile = async (file: File) => {
    if (!settings.apiKey) {
      setShowSettings(true);
      setError("先に設定画面で Gemini API キーを入力してください(無料で発行できます)");
      return;
    }
    reset();
    setPhase("converting");
    setFileInfo(`${file.name}(${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    try {
      const buffer = await file.arrayBuffer();
      const mp3Buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const worker = new Worker(new URL("./lib/encoder.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === "progress") setConvertPercent(msg.percent);
          else if (msg.type === "done") resolve(msg.mp3);
          else if (msg.type === "error") reject(new Error(msg.message));
        };
        worker.onerror = () => reject(new Error("変換処理でエラーが発生しました"));
        worker.postMessage({ buffer }, [buffer]);
      });
      workerRef.current?.terminate();
      workerRef.current = null;

      setMp3Url(URL.createObjectURL(new Blob([mp3Buffer], { type: "audio/mpeg" })));

      setPhase("generating");
      const result = await generateEpisodeMeta({
        apiKey: settings.apiKey,
        model: settings.model,
        mp3: mp3Buffer,
        showContext: settings.showContext,
        onStatus: setStatusText,
      });
      setMeta(result);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  return (
    <>
      <h1>
        🎙️ Podcast BR
        <button style={{ marginLeft: "auto" }} onClick={() => setShowSettings((v) => !v)}>
          ⚙️ 設定
        </button>
      </h1>

      {showSettings && (
        <div className="card">
          <h2>設定</h2>
          <label>
            Gemini API キー(必須)
            <input
              type="password"
              value={settings.apiKey}
              placeholder="AIza..."
              onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value.trim() }))}
            />
          </label>
          <p className="muted">
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              Google AI Studio
            </a>
            で無料発行できます(クレジットカード不要)。キーはこの端末にのみ保存されます。
          </p>
          <label>
            番組の背景情報(任意・生成品質が上がります)
            <textarea
              value={settings.showContext}
              placeholder="例: 番組名「◯◯ラジオ」。30代の2人が雑談形式でテックニュースを語る番組。リスナーはエンジニアが中心。"
              onChange={(e) => setSettings((s) => ({ ...s, showContext: e.target.value }))}
            />
          </label>
          <label>
            モデル
            <select
              value={settings.model}
              onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
            >
              <option value="gemini-2.5-flash">gemini-2.5-flash(推奨)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro(高品質・枠少なめ)</option>
              <option value="gemini-2.0-flash">gemini-2.0-flash(軽量)</option>
            </select>
          </label>
          <button className="primary" onClick={() => setShowSettings(false)}>
            保存して閉じる
          </button>
        </div>
      )}

      {error && (
        <div className="error">
          ⚠️ {error}
          {mp3Url && (
            <a className="dl" href={mp3Url} download="episode.mp3">
              ⬇️ 変換済み MP3 をダウンロード
            </a>
          )}
        </div>
      )}

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
          <p className="muted">変換 → タイトル・説明文の生成まで自動で進みます</p>
        </label>
      )}

      {(phase === "converting" || phase === "generating") && (
        <div className="card">
          <h2>処理中: {fileInfo}</h2>
          <ul className="steps">
            <li className={phase === "converting" ? "active" : "done"}>
              {phase === "converting" ? "▶" : "✓"} MP3へ変換・音量調整
              {phase === "converting" && ` (${convertPercent}%)`}
            </li>
            <li className={phase === "generating" ? "active" : ""}>
              {phase === "generating" ? `▶ ${statusText}` : "タイトル・説明文を生成"}
            </li>
          </ul>
          {phase === "converting" && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${convertPercent}%` }} />
            </div>
          )}
          <p className="muted" style={{ marginTop: 12 }}>
            画面を閉じずにお待ちください。長いエピソードほど時間がかかります。
          </p>
        </div>
      )}

      {phase === "done" && meta && (
        <>
          <div className="card">
            <h2>✅ 投稿素材が完成しました</h2>
            <p className="muted">
              Spotify for Creators アプリを開き、下のMP3をアップロード →
              各項目をコピーして貼り付けてください。
            </p>
            {mp3Url && (
              <a className="dl" href={mp3Url} download="episode.mp3">
                ⬇️ 変換済み MP3 をダウンロード
              </a>
            )}
          </div>

          <div className="card">
            <div className="result-block">
              <div className="result-head">
                <h2>タイトル案</h2>
              </div>
              {meta.titles.map((t) => (
                <div key={t} className="title-option">
                  <span>{t}</span>
                  <CopyButton text={t} />
                </div>
              ))}
            </div>

            <div className="result-block">
              <div className="result-head">
                <h2>説明文</h2>
                <CopyButton text={meta.description} />
              </div>
              <div className="result-body">{meta.description}</div>
            </div>

            <div className="result-block">
              <div className="result-head">
                <h2>ショーノート</h2>
                <CopyButton text={meta.showNotes} />
              </div>
              <div className="result-body">{meta.showNotes}</div>
            </div>

            {meta.chapters.length > 0 && (
              <div className="result-block">
                <div className="result-head">
                  <h2>チャプター</h2>
                  <CopyButton
                    text={meta.chapters.map((c) => `${c.time} ${c.label}`).join("\n")}
                  />
                </div>
                <div className="result-body">
                  {meta.chapters.map((c) => `${c.time} ${c.label}`).join("\n")}
                </div>
              </div>
            )}

            <div className="result-block">
              <div className="result-head">
                <h2>ハッシュタグ</h2>
                <CopyButton text={meta.hashtags.join(" ")} />
              </div>
              <div className="result-body">{meta.hashtags.join(" ")}</div>
            </div>
          </div>

          <button className="primary" onClick={reset}>
            次のエピソードを処理する
          </button>
        </>
      )}
    </>
  );
}
