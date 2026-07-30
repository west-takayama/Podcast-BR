import { useEffect, useRef, useState } from "react";
import {
  generateEpisodeMeta,
  generateTranscript,
  isAudioUsable,
  snapChapters,
  type EpisodeMeta,
  type TranscriptSegment,
  type UploadedAudio,
} from "./lib/gemini";
import { loadSettings, saveSettings, type Settings } from "./lib/settings";
import { listEpisodes, saveEpisode, updateEpisode } from "./lib/history";
import { estimateRemainingMs, overallProgress, type Stage } from "./lib/progress";
import type { Finding } from "./lib/audio/diagnostics";
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
  /** 入力ファイルの形式(表示用)。 */
  inputFormat: string;
  /** 収録そのものの問題。 */
  findings: Finding[];
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
  const [uploaded, setUploaded] = useState<UploadedAudio | null>(null);
  const [pauses, setPauses] = useState<number[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[] | null>(null);
  const [busyText, setBusyText] = useState("");
  const [chapterNote, setChapterNote] = useState("");
  const [previousTitles, setPreviousTitles] = useState<string[]>([]);

  // 生成が失敗しても変換をやり直さずに済むよう、変換結果を保持しておく。
  // 60分の回では変換だけで数分かかるため、レート制限のたびに捨てるのは損が大きい。
  const convertedRef = useRef<{
    mp3: ArrayBuffer;
    aiMp3: ArrayBuffer;
    durationSec: number;
    removedSec: number;
    pauses: number[];
    fileName: string;
  } | null>(null);
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

  // 直近の回のタイトルを持っておき、番号付けや切り口の重複を避けるために渡す
  useEffect(() => {
    listEpisodes()
      .then((all) =>
        setPreviousTitles(
          all
            .map((r) => r.chosenTitle || r.meta.titles[0])
            .filter(Boolean)
            .slice(0, 8),
        ),
      )
      .catch(() => setPreviousTitles([]));
  }, [phase]);

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
    setUploaded(null);
    setPauses([]);
    setTranscript(null);
    setChapterNote("");
    setBusyText("");
    convertedRef.current = null;
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

  /**
   * 音声を送り直さずに文章だけ作り直す。
   * トーンや文字数の設定を変えて試したいときに、変換とアップロードを繰り返さずに済む。
   */
  const regenerate = async () => {
    if (!isAudioUsable(uploaded) || !meta) return;
    setBusyText("文章を作り直しています…");
    setError("");
    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const raw = await generateEpisodeMeta({
        apiKey: settings.apiKey,
        model: settings.model,
        audio: uploaded!,
        config: settings.prompt,
        context: { pauses, previousTitles },
        onStatus: setBusyText,
        onModelChanged: (m) => setSettings((s) => ({ ...s, model: m })),
        signal: controller.signal,
      });
      abortRef.current = null;
      const snap = snapChapters(raw.chapters, pauses);
      const next: EpisodeMeta = { ...raw, chapters: snap.chapters };
      const title = next.titles[0] ?? "";
      setMeta(next);
      setChosenTitle(title);
      setChapterNote(
        snap.movedCount > 0
          ? `${snap.movedCount}件のチャプター時刻を、実際の話の切り替わり位置に合わせました。`
          : "",
      );
      if (episodeId) updateEpisode(episodeId, { meta: next, chosenTitle: title });
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyText("");
    }
  };

  /** 全文書き起こしを作る。メタデータとは別の呼び出しなので必要なときだけ。 */
  const makeTranscript = async () => {
    if (!isAudioUsable(uploaded)) return;
    setBusyText("書き起こし中…");
    setError("");
    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const segments = await generateTranscript({
        apiKey: settings.apiKey,
        model: settings.model,
        audio: uploaded!,
        speakers: settings.prompt.speakers,
        onStatus: setBusyText,
        onModelChanged: (m) => setSettings((s) => ({ ...s, model: m })),
        signal: controller.signal,
      });
      abortRef.current = null;
      setTranscript(segments);
      if (episodeId) updateEpisode(episodeId, { transcript: segments });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyText("");
    }
  };

  /** 履歴側の編集。保存済みの meta に差分を当てる。 */
  const listEpisodeAndPatch = async (
    id: string,
    patch: Partial<EpisodeMeta>,
  ): Promise<void> => {
    const all = await listEpisodes();
    const target = all.find((r) => r.id === id);
    if (!target) return;
    await updateEpisode(id, { meta: { ...target.meta, ...patch } });
  };

  /** 編集した本文を履歴に残す。投稿前の手直しを次回以降も参照できるようにする。 */
  const editMeta = (patch: Partial<EpisodeMeta>) => {
    setMeta((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (episodeId) updateEpisode(episodeId, { meta: next });
      return next;
    });
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
    setOutputName(file.name.replace(/\.[a-z0-9]+$/i, "") + ".mp3");
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
        pauses: number[];
        inputFormat: string;
        findings: Finding[];
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

      convertedRef.current = {
        mp3: result.mp3,
        aiMp3: result.aiMp3,
        durationSec: result.durationSec,
        removedSec: result.removedSec,
        pauses: result.pauses,
        fileName: file.name,
      };

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
        inputFormat: result.inputFormat,
        findings: result.findings,
      });

      // 生成前でもダウンロードできるよう、まずタグ無しで出しておく
      setMp3Url(URL.createObjectURL(new Blob([result.mp3], { type: "audio/mpeg" })));

      advance("upload", 0);
      await runGeneration();
    } catch (err) {
      void wakeLockRef.current.stop();
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  /**
   * 変換済みの音声から生成だけを行う。失敗しても変換をやり直さずに再試行できる。
   * すでにアップロード済みなら送信も省く。
   */
  const runGeneration = async () => {
    const converted = convertedRef.current;
    if (!converted) throw new Error("変換結果がありません。もう一度アップロードしてください。");

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      let uploadedAudio: UploadedAudio | null = uploaded;
      const raw = await generateEpisodeMeta({
        apiKey: settings.apiKey,
        model: settings.model,
        mp3: converted.aiMp3,
        audio: uploaded ?? undefined,
        config: settings.prompt,
        context: {
          pauses: converted.pauses,
          durationSec: converted.durationSec,
          previousTitles,
        },
        onStatus: (text) => {
          if (text.includes("生成") || text.includes("モデル")) advance("generate", 0.15, text);
          else if (text.includes("解析")) advance("upload", 1, text);
        },
        onUploadProgress: (f) =>
          advance("upload", f, `${(converted.aiMp3.byteLength / 1024 / 1024).toFixed(0)} MB 送信中`),
        // 廃止されたモデルから自動で切り替わったら、次回以降のために保存し直す
        onModelChanged: (m) => setSettings((s) => ({ ...s, model: m })),
        onUploaded: (a) => {
          uploadedAudio = a;
          setUploaded(a);
        },
        signal: controller.signal,
      });
      abortRef.current = null;
      void wakeLockRef.current.stop();

      // AI の推定時刻を、端末側で検出した実際の切り替わり位置へ寄せる
      const snap = snapChapters(raw.chapters, converted.pauses);
      const generated: EpisodeMeta = { ...raw, chapters: snap.chapters };
      setPauses(converted.pauses);
      setTranscript(null);
      setChapterNote(
        snap.movedCount > 0
          ? `${snap.movedCount}件のチャプター時刻を、実際の話の切り替わり位置に合わせました(最大 ${Math.round(snap.maxMoveSec)}秒の補正)。`
          : "",
      );

      const title = generated.titles[0] ?? "";

      // タイトルとチャプターが揃ってから ID3 タグを付ける。
      // アートワークも埋め込むので、プレイヤーで番組として正しく表示される。
      // 結果画面を出す前に差し替えないと、タグ無しの MP3 をダウンロードされうる。
      const blob = await buildTaggedMp3(
        converted.mp3,
        generated,
        title,
        converted.durationSec,
      );
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
        fileName: converted.fileName,
        durationSec: converted.durationSec,
        removedSec: converted.removedSec,
        meta: generated,
        chosenTitle: title,
        audio: blob,
        uploaded: uploadedAudio ?? undefined,
        pauses: converted.pauses,
      }).catch(() =>
        setError(
          "結果は表示できましたが、履歴の保存に失敗しました(端末の空き容量をご確認ください)",
        ),
      );
    } finally {
      abortRef.current = null;
      void wakeLockRef.current.stop();
    }
  };

  /**
   * 生成だけをやり直す。変換は済んでいるので数十秒で終わる。
   * 無料枠ではレート制限(429)に当たることがあり、そのたびに数分かけた変換を
   * 捨てるのは損が大きいため、この経路を用意している。
   */
  const retryGeneration = async () => {
    setError("");
    setPhase("running");
    startedAtRef.current = Date.now();
    smoothedRemainingRef.current = null;
    advance("upload", 0);
    void wakeLockRef.current.start();
    try {
      await runGeneration();
    } catch (err) {
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
          {/* 変換は済んでいるので、生成だけやり直せば数十秒で終わる */}
          {convertedRef.current && phase === "idle" && (
            <>
              <button className="primary" onClick={retryGeneration}>
                {isAudioUsable(uploaded)
                  ? "🔄 生成だけやり直す(変換済み・送信も不要)"
                  : "🔄 生成だけやり直す(変換はやり直しません)"}
              </button>
              {mp3Url && (
                <a className="dl" href={mp3Url} download={outputName}>
                  ⬇️ 変換済み MP3 をダウンロード
                </a>
              )}
            </>
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
          onEditMeta={(id, patch) => {
            void listEpisodeAndPatch(id, patch);
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
                accept="audio/*,.wav,.mp3,.m4a,.aac,.mp4,.ogg,.opus,.flac,.caf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
              <p style={{ fontSize: "2rem", margin: "0 0 8px" }}>📤</p>
              <p style={{ margin: 0, fontWeight: 600 }}>収録した音声をここから選択</p>
              <p className="muted">
                WAV / MP3 / M4A / AAC など。通話録音もそのまま使えます。
                <br />
                整音 → 変換 → タイトル・説明文の生成まで自動で進みます
              </p>
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
                chapterNote={chapterNote}
                transcript={transcript}
                canReuseAudio={isAudioUsable(uploaded)}
                busyText={busyText}
                onRegenerate={regenerate}
                onMakeTranscript={makeTranscript}
                onEdit={editMeta}
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
