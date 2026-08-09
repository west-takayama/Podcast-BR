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
import {
  clearPending,
  listEpisodes,
  clearArtwork,
  loadPending,
  patchPending,
  saveEpisode,
  savePending,
  updateEpisode,
  formatDate,
  formatDuration,
  type PendingConversion,
} from "./lib/history";
import { estimateRemainingMs, overallProgress, type Stage } from "./lib/progress";
import type { Finding } from "./lib/audio/diagnostics";
import type { AudioReport } from "./lib/audio/report";
import type { TrackInfo } from "./lib/encoder.worker";
import { attachId3, buildId3Tag, toId3Chapters } from "./lib/id3";
import { renderArtworkJpeg } from "./lib/image";
import { ScreenWakeLock } from "./lib/wakeLock";
import { applyAccent } from "./lib/theme";
import SettingsPanel from "./components/SettingsPanel";
import ResultView from "./components/ResultView";
import HistoryPanel from "./components/HistoryPanel";
import InsightsPanel from "./components/InsightsPanel";
import ProgressPanel from "./components/ProgressPanel";
import ShortsPanel from "./components/ShortsPanel";
import TrackPicker from "./components/TrackPicker";

type Tab = "create" | "shorts" | "next" | "history" | "settings";
type Phase = "idle" | "running" | "done";

export type { AudioReport };

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
  /** 複数トラックを選んだ直後。音量を合わせる画面を出している間ここに入る。 */
  const [pickingTracks, setPickingTracks] = useState<File[] | null>(null);
  const [uploaded, setUploaded] = useState<UploadedAudio | null>(null);
  const [pauses, setPauses] = useState<number[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[] | null>(null);
  const [busyText, setBusyText] = useState("");
  const [chapterNote, setChapterNote] = useState("");
  const [previousTitles, setPreviousTitles] = useState<string[]>([]);
  // 変換だけ終わって文章が未完成のまま中断された回。開き直したときに続けられる。
  const [pending, setPending] = useState<PendingConversion | null>(null);
  const [pendingUrl, setPendingUrl] = useState("");
  // 新しい版が届いたときに押してもらう。勝手に切り替えると処理中の回が壊れる
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

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

  // Service Worker が新しい版を用意したら知らせる(切り替えは利用者の操作で)
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const apply = (e as CustomEvent<() => void>).detail;
      setApplyUpdate(() => apply);
    };
    window.addEventListener("sw-update", onUpdate);
    return () => window.removeEventListener("sw-update", onUpdate);
  }, []);

  // 中断された変換が残っていれば拾う。復帰を促すのは起動直後だけでよい
  useEffect(() => {
    loadPending()
      .then(setPending)
      .catch(() => setPending(null));
  }, []);

  // 「MP3 だけ取り出す」用の URL。描画のたびに作ると解放できず溜まる
  useEffect(() => {
    if (!pending) {
      setPendingUrl("");
      return;
    }
    const url = URL.createObjectURL(pending.mp3);
    setPendingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);

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
    // 次の回に進む/やめる時点で、中断復帰用の控えは意味を失う
    setPending(null);
    void clearPending().catch(() => {});
    // 写真はその回の情景を写したものなので、次の回へは持ち越さない
    void clearArtwork().catch(() => {});
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
    background?: ImageBitmap | null,
  ): Promise<Blob> => {
    try {
      const artwork = await renderArtworkJpeg({
        quote: generated.imageQuote || title,
        title,
        showName: settings.prompt.showName,
        accent: settings.accentColor,
        background: background ?? undefined,
        template: "band",
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
   * 告知画像で取り込んだ写真を、MP3 に埋め込むカバーにも反映する。
   *
   * タグ付けは生成直後に走るため、その時点ではまだ写真が無い。
   * 告知画像だけ立派で、配信側のカバーは単色のまま、という状態を避ける。
   */
  const applyArtwork = async (bitmap: ImageBitmap | null) => {
    const converted = convertedRef.current;
    if (!converted || !meta) return;
    setBusyText("MP3 のカバーを付け直しています…");
    try {
      const blob = await buildTaggedMp3(
        converted.mp3,
        meta,
        chosenTitle || meta.titles[0] || "",
        converted.durationSec,
        bitmap,
      );
      setMp3Url((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      if (episodeId) await updateEpisode(episodeId, { audio: blob });
    } catch {
      // カバーの差し替えに失敗しても、元の MP3 はそのまま使える
    } finally {
      setBusyText("");
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

  const handleFile = async (
    input: File | File[],
    manualDb: number[] = [],
    measured?: TrackInfo[],
  ) => {
    const files = Array.isArray(input) ? input : [input];
    const file = files[0];
    if (!settings.apiKey) {
      setTab("settings");
      setError("先に設定画面で Gemini API キーを入力してください(無料で発行できます)");
      return;
    }
    reset();
    setPhase("running");
    setStage("analyze");
    startedAtRef.current = Date.now();
    const totalMb = files.reduce((n, f) => n + f.size, 0) / 1024 / 1024;
    setFileInfo(
      files.length > 1
        ? `${files.length}トラック(${totalMb.toFixed(0)} MB)`
        : `${file.name}(${totalMb.toFixed(0)} MB)`,
    );
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
        tracks?: TrackInfo[];
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
          files,
          manualDb,
          measured,
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

      const report: AudioReport = {
        tracks: result.tracks,
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
      };
      setAudioReport(report);

      // 生成前でもダウンロードできるよう、まずタグ無しで出しておく
      const publishBlob = new Blob([result.mp3], { type: "audio/mpeg" });
      setMp3Url(URL.createObjectURL(publishBlob));

      // ここから先(送信・生成)で中断されても変換をやり直さずに済むよう、
      // 端末に置いておく。60分の回では変換だけで数分かかる。
      const outName = file.name.replace(/\.[a-z0-9]+$/i, "") + ".mp3";
      const record = {
        createdAt: Date.now(),
        fileName: file.name,
        outputName: outName,
        fileInfo: `${file.name}(${(file.size / 1024 / 1024).toFixed(0)} MB)`,
        durationSec: result.durationSec,
        removedSec: result.removedSec,
        pauses: result.pauses,
        mp3: publishBlob,
        aiMp3: new Blob([result.aiMp3], { type: "audio/mpeg" }),
        report,
      };
      // 保存できなくても処理は続ける(空き容量が無い端末でも生成は通す)
      await savePending(record).catch(() => {});

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
  const runGeneration = async (already: UploadedAudio | null = uploaded) => {
    const converted = convertedRef.current;
    if (!converted) throw new Error("変換結果がありません。もう一度アップロードしてください。");

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      let uploadedAudio: UploadedAudio | null = already;
      const raw = await generateEpisodeMeta({
        apiKey: settings.apiKey,
        model: settings.model,
        mp3: converted.aiMp3,
        audio: already ?? undefined,
        config: settings.prompt,
        context: {
          pauses: converted.pauses,
          durationSec: converted.durationSec,
          previousTitles,
        },
        onStatus: (text) => {
          if (text.includes("生成中") || text.includes("モデル")) advance("generate", 0.15, text);
          else if (text.includes("解析")) advance("upload", 1, text);
          // 混雑の待機など、進捗は変わらないが状況は伝えたいもの
          else setDetail(text);
        },
        onUploadProgress: (f) =>
          advance("upload", f, `${(converted.aiMp3.byteLength / 1024 / 1024).toFixed(0)} MB 送信中`),
        // 廃止されたモデルから自動で切り替わったら、次回以降のために保存し直す
        onModelChanged: (m) => setSettings((s) => ({ ...s, model: m })),
        onUploaded: (a) => {
          uploadedAudio = a;
          setUploaded(a);
          // 送信済みの参照も残す。ここで落ちても復帰時に送信を省ける
          void patchPending({ uploaded: a }).catch(() => {});
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
      })
        .then(() => {
          // 履歴に入ったので、中断復帰用の控えは用済み
          setPending(null);
          return clearPending();
        })
        .catch(() =>
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

  /**
   * 中断された回を、保存してある変換結果から続ける。
   * ブラウザに処理を止められたり、アプリを閉じてしまったりしても、
   * 数分かけた変換をやり直さずに文章の生成だけ進められる。
   */
  const resumePending = async () => {
    const saved = pending;
    if (!saved) return;
    setError("");
    setPhase("running");
    setStage("upload");
    startedAtRef.current = Date.now();
    smoothedRemainingRef.current = null;
    setFileInfo(saved.fileInfo);
    setOutputName(saved.outputName);
    setAudioReport(saved.report);
    setUploaded(saved.uploaded ?? null);
    void wakeLockRef.current.start();

    try {
      convertedRef.current = {
        mp3: await saved.mp3.arrayBuffer(),
        aiMp3: await saved.aiMp3.arrayBuffer(),
        durationSec: saved.durationSec,
        removedSec: saved.removedSec,
        pauses: saved.pauses,
        fileName: saved.fileName,
      };
      setMp3Url((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(saved.mp3);
      });
      advance("upload", 0);
      // uploaded は setState 直後で反映されていないため、直接渡して送信を省く
      await runGeneration(saved.uploaded ?? null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  /** 中断された回を捨てる。音声の控えも消して容量を戻す。 */
  const discardPending = () => {
    setPending(null);
    void clearPending().catch(() => {});
  };

  return (
    <>
      <header>
        <h1>🎙️ Podcast BR</h1>
        <nav className="tabs">
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>
            作成
          </button>
          <button className={tab === "shorts" ? "active" : ""} onClick={() => setTab("shorts")}>
            ショート
          </button>
          <button className={tab === "next" ? "active" : ""} onClick={() => setTab("next")}>
            次の回
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            履歴
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            設定
          </button>
        </nav>
      </header>

      {applyUpdate && (
        <div className="update">
          🎉 新しい版があります
          <button
            className="primary"
            onClick={() => {
              setApplyUpdate(null);
              applyUpdate();
            }}
            disabled={phase === "running"}
          >
            {phase === "running" ? "処理が終わってから更新できます" : "更新する"}
          </button>
        </div>
      )}

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

      {tab === "shorts" && (
        <ShortsPanel
          settings={settings}
          onModelChanged={(m) => setSettings((prev) => ({ ...prev, model: m }))}
        />
      )}

      {tab === "next" && (
        <InsightsPanel
          settings={settings}
          onModelChanged={(m) => setSettings((s) => ({ ...s, model: m }))}
        />
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
          {/* 前回の変換が生き残っている場合。変換をやり直させないのが目的 */}
          {phase === "idle" && !meta && pending && (
            <div className="card resume">
              <h2>🗂 中断された回が残っています</h2>
              <p className="muted" style={{ margin: "0 0 10px" }}>
                {pending.fileName} / {formatDuration(pending.durationSec)} /{" "}
                {formatDate(pending.createdAt)}
                <br />
                変換は完了しています
                {isAudioUsable(pending.uploaded) ? "(送信も済み)" : ""}。
                文章の生成から続けられます。
                <br />
                音声の控えに {(pending.mp3.size + pending.aiMp3.size) / 1024 / 1024 < 1
                  ? "1 MB 未満"
                  : `${Math.round((pending.mp3.size + pending.aiMp3.size) / 1024 / 1024)} MB`}{" "}
                使っています(破棄すると戻ります)。
              </p>
              <button className="primary" onClick={resumePending}>
                ▶️ 文章の生成から続ける
              </button>
              <div className="row-buttons">
                {pendingUrl && (
                  <a
                    className="dl"
                    style={{ margin: 0, flex: 1 }}
                    href={pendingUrl}
                    download={pending.outputName}
                  >
                    ⬇️ MP3 だけ取り出す
                  </a>
                )}
                <button onClick={discardPending}>破棄</button>
              </div>
            </div>
          )}

          {phase === "idle" && pickingTracks && (
            <TrackPicker
              files={pickingTracks}
              settings={settings}
              onStart={(files, manualDb, measured) => {
                setPickingTracks(null);
                void handleFile(files, manualDb, measured);
              }}
              onCancel={() => setPickingTracks(null)}
            />
          )}

          {phase === "idle" && !pickingTracks && (
            <label className="drop card">
              <input
                type="file"
                multiple
                accept="audio/*,.wav,.mp3,.m4a,.aac,.mp4,.ogg,.opus,.flac,.caf"
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (picked.length === 0) return;
                  // 人ごとに分かれているなら、先に音量を合わせる画面を出す
                  if (picked.length > 1) setPickingTracks(picked);
                  else void handleFile(picked[0]);
                }}
              />
              <p style={{ fontSize: "2rem", margin: "0 0 8px" }}>📤</p>
              <p style={{ margin: 0, fontWeight: 600 }}>収録した音声をここから選択</p>
              <p className="muted">
                WAV / MP3 / M4A / AAC など。通話録音もそのまま使えます。
                <br />
                整音 → 変換 → タイトル・説明文の生成まで自動で進みます
                <br />
                <strong>人ごとに分かれている場合はまとめて選べます。</strong>
                それぞれの音量を測って揃えてから1本にします
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
                speakers={settings.prompt.speakers}
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
                onBackgroundChange={(b) => void applyArtwork(b)}
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
