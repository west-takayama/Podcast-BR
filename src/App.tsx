import { BudgetNotice } from "./modules/budget/BudgetNotice";
import { restoreProductionSession, saveProductionSource, selectOriginal, type ProductionSession } from "./core/productionSession";
import { createProductionAsset } from "./core/productionAsset";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
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
import { castLine } from "./lib/cast";
import { clearPlan, loadPlan, planAsText, type Plan } from "./lib/plan";
import { noteError } from "./lib/errorLog";
import { measureStage, recordTiming } from "./lib/timing";
import type { Finding } from "./lib/audio/diagnostics";
import type { AudioReport } from "./lib/audio/report";
import type { TrackInfo } from "./lib/encoder.worker";
import { attachId3, buildId3Tag, toId3Chapters } from "./lib/id3";
import { renderArtworkJpeg } from "./lib/image";
import { loadArtwork } from "./lib/history";
import { ScreenWakeLock } from "./lib/wakeLock";
import { applyAccent } from "./lib/theme";
import CopyButton from "./components/CopyButton";
import ProgressPanel from "./components/ProgressPanel";
// 設定は、キーを入れていない人が**最初に見る画面**。ここだけは遅延させない。
// 分けると「読み込み中…」が一瞬挟まる。大きさも 3.6kB(gzip)しかない
import SettingsPanel from "./components/SettingsPanel";
import DriveSettings from "./components/DriveSettings";
import { DriveConnectionProvider } from "./components/DriveConnection";

// 画面ごとに分けて、開いたときに読む。
//
// 起動時に全部読むと、その解析と実行のぶんだけ最初の描画が遅れる。
// キャッシュから出しているときでも、この時間は毎回かかる。
// 最初に要るのは「音声を選ぶ」ところだけで、残りは押されてからで間に合う。
const ResultView = lazy(() => import("./components/ResultView"));
const AudioPanel = lazy(() => import("./modules/audio/AudioPanel"));
const HistoryPanel = lazy(() => import("./components/HistoryPanel"));
const InsightsPanel = lazy(() => import("./components/InsightsPanel"));
const ShortsPanel = lazy(() => import("./components/ShortsPanel"));
const PodcastPanel = lazy(() => import("./modules/publisher/podcast/PodcastPanel"));
const PublisherPanel = lazy(() => import("./modules/publisher/PublisherPanel"));
const BudgetPanel = lazy(() => import("./modules/budget/BudgetPanel"));
const TrackPicker = lazy(() => import("./components/TrackPicker"));

/** 読み込み中の置き場所。一瞬で終わるので、飛び跳ねない高さだけ確保する。 */
function Loading() {
  return <div className="card muted">読み込み中…</div>;
}

type Tab = "audio" | "create" | "legacy" | "next" | "history" | "settings" | "budget" | "publisher" | "podcast";
type Phase = "idle" | "running" | "done";

export type { AudioReport };

export default function App() {
  const [production, setProduction] = useState<ProductionSession>();
  const productionRef = useRef<ProductionSession>();
  const [productionError, setProductionError] = useState("");
  const sourceWrites = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    void restoreProductionSession().then(saved => {
      if (active && !productionRef.current && saved) {
        productionRef.current = saved;
        setProduction(saved);
      }
    }).catch(() => { if (active) setProductionError("端末に保存した制作を読み出せませんでした。"); });
    return () => { active = false; };
  }, []);

  const changeProductionSource = (file: File, role: "original" | "edited") => {
    const current = productionRef.current;
    const next = role === "original" ? selectOriginal(current, file)
      : { ...current, id: current?.id ?? crypto.randomUUID(), edited: createProductionAsset(file) };
    if (next !== current) {
      productionRef.current = next;
      setProduction(next);
      setProductionError("");
      sourceWrites.current = sourceWrites.current.then(() => saveProductionSource(next, role)).catch(() => {
        setProductionError("素材を端末に保存できませんでした。この画面が開いている間は制作を続けられます。");
      });
    }
    return { session: next, saved: sourceWrites.current };
  };
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [driveSetupShortcut, setDriveSetupShortcut] = useState(false);
  const [settingsReturnTab, setSettingsReturnTab] = useState<Tab>("create");
  const [tab, setTab] = useState<Tab>(() => (loadSettings().apiKey ? "create" : "settings"));
  const [studioVisited, setStudioVisited] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<Stage>("analyze");
  const [overall, setOverall] = useState(0);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<EpisodeMeta | null>(null);
  const [episodeId, setEpisodeId] = useState("");
  const [chosenTitle, setChosenTitle] = useState("");
  const [shortsSource, setShortsSource] = useState<Blob>();
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
  // 今回の出演者。回ごとに変わるので設定ではなく、その都度打ち込む。
  // 前回の値を初期値にして、同じ顔ぶれが続くときに打ち直さずに済むようにする
  const [cast, setCast] = useState<string>(() => loadSettings().lastCast ?? "");
  // 「次の回」で決めたお題。収録の直前に見えないと意味がない
  const [plan, setPlan] = useState<Plan | null>(() => loadPlan());
  // 変換だけ終わって文章が未完成のまま中断された回。開き直したときに続けられる。
  const [pending, setPending] = useState<PendingConversion | null>(null);
  const [pendingUrl, setPendingUrl] = useState("");
  // 新しい版が届いたときに押してもらう。勝手に切り替えると処理中の回が壊れる
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  // 生成が失敗しても変換をやり直さずに済むよう、変換結果を保持しておく。
  // 60分の回では変換だけで数分かかるため、レート制限のたびに捨てるのは損が大きい。
  const convertedRef = useRef<{
    episodeId: string;
    mp3: ArrayBuffer;
    originalAudio?: Blob;
    aiMp3: ArrayBuffer;
    durationSec: number;
    removedSec: number;
    pauses: number[];
    fileName: string;
  } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const cancelConversionRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mp3UrlRef = useRef("");
  const startedAtRef = useRef(0);
  const resultReadyAtRef = useRef(0);
  const wakeLockRef = useRef(new ScreenWakeLock());
  // 残り時間がちらつかないよう、指数移動平均でならしてから表示する
  const smoothedRemainingRef = useRef<number | null>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const onResultDisplayed = useCallback(() => {
    if (!resultReadyAtRef.current) return;
    recordTiming("result-display", performance.now() - resultReadyAtRef.current, true);
    resultReadyAtRef.current = 0;
  }, []);

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

  // お題は別のタブで決める。作成画面に戻ってきた時点で拾い直す
  useEffect(() => {
    if (tab === "create") setStudioVisited(true);
    if (tab === "create" || tab === "legacy") setPlan(loadPlan());
  }, [tab]);

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
      cancelConversionRef.current?.();
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
    resultReadyAtRef.current = 0;
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
    setShortsSource(undefined);
    // 次の回に進む/やめる時点で、中断復帰用の控えは意味を失う
    setPending(null);
    void clearPending().catch(() => {});
    // 写真はその回の情景を写したものなので、次の回へは持ち越さない
    void clearArtwork().catch(() => {});
  };

  const cancel = () => {
    cancelConversionRef.current?.();
    cancelConversionRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    void wakeLockRef.current.stop();
    reset();
  };

  /**
   * カバーの絵を描く。
   *
   * 写真は **IndexedDB の控えだけを見る**。以前は取り込んだ ImageBitmap を
   * App 側で持ち続けていたが、写真の部品は自分が作った bitmap を画面から
   * 外れた時点で閉じる。持ち主が2人いる状態で、閉じられたものを使って
   * 描こうとして失敗していた(下の「タグを付け直す」で実害が出ていた)。
   * 毎回控えから作り直せば、古い回の写真が次の回に残ることもない。
   */
  const renderCover = async (title: string): Promise<Uint8Array> => {
    const saved = await loadArtwork().catch(() => null);
    const bitmap = saved ? await createImageBitmap(saved.blob) : null;
    try {
      return await renderArtworkJpeg({
        title,
        showName: settings.prompt.showName,
        accent: settings.accentColor,
        background: bitmap ?? undefined,
      });
    } finally {
      bitmap?.close();
    }
  };

  /**
   * MP3 に ID3 タグ(タイトル・番組名・説明・アートワーク・チャプター)を付ける。
   *
   * **絵で失敗しても、題名とチャプターは必ず入れる。** 以前はひとつの
   * try で囲んでいたため、カバーが描けなかっただけでタグが丸ごと落ちていた。
   * 配信側から見て、絵が単色なのと題名が空なのとでは重さが違う。
   */
  const buildTaggedMp3 = async (
    mp3: ArrayBuffer,
    generated: EpisodeMeta,
    title: string,
    durationSec: number,
  ): Promise<Blob> => {
    let artwork: Uint8Array | null = null;
    try {
      artwork = await renderCover(title);
    } catch {
      // 絵は諦める。文字の情報だけでも入れる
    }
    try {
      const tag = buildId3Tag({
        title,
        showName: settings.prompt.showName,
        description: generated.description,
        artwork: artwork ? { data: artwork, mime: "image/jpeg" } : undefined,
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
   * いま画面に出ている内容で MP3 のタグを付け直す。
   *
   * タイトルを選び直したりチャプターを直したりしても、以前は
   * **ファイルの中身は変換した瞬間のまま**だった。画面と配信する物が
   * 食い違っていて、しかも気づけない。編集のたびに揃え直す。
   */
  const retagMp3 = async (nextMeta: EpisodeMeta, title: string, busy: string) => {
    const converted = convertedRef.current;
    if (!converted || converted.originalAudio) return;
    setBusyText(busy);
    try {
      const blob = converted.originalAudio ?? await buildTaggedMp3(
        converted.mp3,
        nextMeta,
        title,
        converted.durationSec,
      );
      setMp3Url((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      if (episodeId) await updateEpisode(episodeId, { audio: blob }, true);
    } catch {
      // 付け直しに失敗しても、元の MP3 はそのまま使える
    } finally {
      setBusyText("");
    }
  };

  /**
   * 写真を入れ替えたら、MP3 のカバーも入れ替える。
   *
   * タグ付けは生成直後に走るため、その時点ではまだ写真が無い。
   * 写真を入れたのに配信側のカバーが単色のまま、という状態を避ける。
   */
  const applyArtwork = async () => {
    if (!meta) return;
    await retagMp3(meta, chosenTitle || meta.titles[0] || "", "MP3 のカバーを付け直しています…");
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
        episodeId,
        apiKey: settings.apiKey,
        model: settings.model,
        audio: uploaded!,
        config: settings.prompt,
        context: { pauses, previousTitles, cast },
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
        setError(noteError("文章の作り直し", err, settings.model));
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
        episodeId,
        apiKey: settings.apiKey,
        model: settings.model,
        audio: uploaded!,
        speakers: settings.prompt.speakers,
        onStatus: setBusyText,
        onModelChanged: (m) => setSettings((s) => ({ ...s, model: m })),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (episodeId) await updateEpisode(episodeId, { transcript: segments });
      controller.signal.throwIfAborted();
      if (abortRef.current === controller) abortRef.current = null;
      setTranscript(segments);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(noteError("書き起こし", err, settings.model));
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
    await updateEpisode(id, current => ({ meta: { ...current.meta, ...patch } }));
  };

  /** 編集した本文を履歴に残す。投稿前の手直しを次回以降も参照できるようにする。 */
  const editMeta = (patch: Partial<EpisodeMeta>) => {
    setMeta((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (episodeId) updateEpisode(episodeId, { meta: next });
      // チャプターと説明は MP3 の中にも入っている。直したら揃え直す
      if (patch.chapters || patch.description) {
        void retagMp3(next, chosenTitle || next.titles[0] || "", "MP3 の中身を直しています…");
      }
      return next;
    });
  };

  const handleFile = async (
    input: File | File[],
    manualDb: number[] = [],
    measured?: TrackInfo[],
    matchTone = true,
  ) => {
    const files = Array.isArray(input) ? input : [input];
    const file = files[0];
    if (!settings.apiKey) {
      setTab("settings");
      setError("先に設定画面で Gemini API キーを入力してください(無料で発行できます)");
      return;
    }
    reset();
    const original = files.length === 1;
    setPhase("running");
    setStage("analyze");
    startedAtRef.current = Date.now();
    const totalMb = files.reduce((n, f) => n + f.size, 0) / 1024 / 1024;
    setFileInfo(
      files.length > 1
        ? `${files.length}トラック(${totalMb.toFixed(0)} MB)`
        : `${file.name}(${totalMb.toFixed(0)} MB)`,
    );
    setOutputName(original ? file.name : file.name.replace(/\.[a-z0-9]+$/i, "") + ".mp3");
    void wakeLockRef.current.start();

    try {
      const result = await measureStage("conversion", () => new Promise<{
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
        cancelConversionRef.current = () => reject(new DOMException("中止しました", "AbortError"));
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
          purpose: original ? "ai" : undefined,
          file,
          files,
          manualDb,
          measured,
          matchTone,
          dsp: original ? { ...settings.dsp, highPass: false } : settings.dsp,
          mono: settings.mono,
          bitrate: settings.bitrate,
        });
      }));
      cancelConversionRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;

      const id = crypto.randomUUID();
      convertedRef.current = {
        episodeId: id,
        originalAudio: original ? file : undefined,
        mp3: original ? new ArrayBuffer(0) : result.mp3,
        aiMp3: result.aiMp3,
        durationSec: result.durationSec,
        removedSec: result.removedSec ?? 0,
        pauses: result.pauses ?? [],
        fileName: file.name,
      };

      const report: AudioReport | null = original ? null : {
        tracks: result.tracks,
        sourceLufs: result.sourceLufs,
        outputLufs: result.outputLufs,
        targetLufs: result.targetLufs,
        peakDbfs: result.peakDbfs,
        channels: result.channels,
        bitrate: settings.bitrate,
        removedSec: result.removedSec ?? 0,
        limitedSamples: result.limitedSamples,
        sampleRate: result.sampleRate,
        correctionDb: result.correctionDb,
        inputFormat: result.inputFormat,
        findings: result.findings,
      };
      setAudioReport(report);

      // 生成前でもダウンロードできるよう、まずタグ無しで出しておく
      const publishBlob = original ? file : new Blob([result.mp3], { type: "audio/mpeg" });
      setMp3Url(URL.createObjectURL(publishBlob));

      // ここから先(送信・生成)で中断されても変換をやり直さずに済むよう、
      // 端末に置いておく。60分の回では変換だけで数分かかる。
      const outName = original ? file.name : file.name.replace(/\.[a-z0-9]+$/i, "") + ".mp3";
      const record = {
        episodeId: id,
        createdAt: Date.now(),
        fileName: file.name,
        outputName: outName,
        fileInfo: `${file.name}(${(file.size / 1024 / 1024).toFixed(0)} MB)`,
        durationSec: result.durationSec,
        removedSec: result.removedSec ?? 0,
        pauses: result.pauses ?? [],
        mp3: publishBlob,
        originalAudio: original,
        aiMp3: new Blob([result.aiMp3], { type: "audio/mpeg" }),
        report,
        cast: cast.trim() || undefined,
      };
      // 保存できなくても処理は続ける(空き容量が無い端末でも生成は通す)
      await savePending(record).catch(() => {});

      advance("upload", 0);
      await runGeneration(null);
    } catch (err) {
      workerRef.current?.terminate();
      workerRef.current = null;
      cancelConversionRef.current = null;
      void wakeLockRef.current.stop();
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(noteError("変換と生成", err, settings.model));
      setPhase("idle");
    }
  };

  /**
   * 変換済みの音声から生成だけを行う。失敗しても変換をやり直さずに再試行できる。
   * すでにアップロード済みなら送信も省く。
   */
  const runGeneration = async (already: UploadedAudio | null = uploaded, episodeCast = cast) => {
    const converted = convertedRef.current;
    if (!converted) throw new Error("変換結果がありません。もう一度アップロードしてください。");

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      let uploadedAudio: UploadedAudio | null = already;
      const id = converted.episodeId;
      const raw = await generateEpisodeMeta({
        episodeId: id,
        apiKey: settings.apiKey,
        model: settings.model,
        mp3: converted.aiMp3,
        audio: already ?? undefined,
        config: settings.prompt,
        context: {
          pauses: converted.pauses,
          durationSec: converted.durationSec,
          previousTitles,
          cast: episodeCast,
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

      // 通常制作は元音声をそのまま使い、タグやカバーの描画を待たない。
      // 従来の合成結果だけタグ付けを維持する。
      const blob = converted.originalAudio ?? await buildTaggedMp3(
        converted.mp3,
        generated,
        title,
        converted.durationSec,
      );
      setMp3Url((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });

      setShortsSource(blob);
      resultReadyAtRef.current = performance.now();
      setMeta(generated);
      setChosenTitle(title);
      setPhase("done");
      window.scrollTo({ top: 0 });

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
        originalAudio: !!converted.originalAudio,
        uploaded: uploadedAudio ?? undefined,
        pauses: converted.pauses,
        cast: episodeCast.trim() || undefined,
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
      setError(noteError("生成のやり直し", err, settings.model));
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
    // 変換前に打ち込んだ出演者を戻す。打ち直させない
    setCast(saved.cast ?? "");
    void wakeLockRef.current.start();

    try {
      const id = saved.episodeId ?? crypto.randomUUID();
      if (!saved.episodeId) await patchPending({ episodeId: id }).catch(() => {});
      convertedRef.current = {
        episodeId: id,
        mp3: saved.originalAudio ? new ArrayBuffer(0) : await saved.mp3.arrayBuffer(),
        originalAudio: saved.originalAudio ? saved.mp3 : undefined,
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
      await runGeneration(saved.uploaded ?? null, saved.cast ?? "");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(noteError("中断からの復帰", err, settings.model));
      setPhase("idle");
    }
  };

  /** 中断された回を捨てる。音声の控えも消して容量を戻す。 */
  const discardPending = () => {
    setPending(null);
    void clearPending().catch(() => {});
  };

  const openSettings = (fromDrive = false) => {
    if (tab !== "settings") setSettingsReturnTab(fromDrive ? tab : "create");
    setDriveSetupShortcut(fromDrive);
    setTab("settings");
  };

  return (
    <DriveConnectionProvider openSettings={() => openSettings(true)}>
      <header>
        <h1>🎙️ AI STUDIO 3.0 β2</h1>
        <nav className="tabs">
          <button className={tab === "audio" ? "active" : ""} onClick={() => setTab("audio")}>音声</button>
          <button className={tab === "create" || tab === "legacy" ? "active" : ""} onClick={() => setTab("create")}>
            作成
          </button>
          <button className={tab === "next" ? "active" : ""} onClick={() => setTab("next")}>
            次の回
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            履歴
          </button>
          <button className={tab === "podcast" ? "active" : ""} onClick={() => setTab("podcast")}>本編配信</button>
          <button className={tab === "publisher" ? "active" : ""} onClick={() => setTab("publisher")}>投稿</button>
          <button className={tab === "budget" ? "active" : ""} onClick={() => setTab("budget")}>予算</button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => openSettings()}>
            設定
          </button>
        </nav>
      </header>

      {tab !== "budget" && <BudgetNotice open={() => setTab("budget")} />}

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
          {/* 消せないと、次に開いたときも失敗したままに見える */}
          <button
            className="error-close"
            aria-label="このお知らせを閉じる"
            onClick={() => setError("")}
          >
            ✕
          </button>
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
                  ⬇️ 音声をダウンロード
                </a>
              )}
            </>
          )}
        </div>
      )}

      <Suspense fallback={<Loading />}>
      {tab === "budget" && <BudgetPanel />}
      {tab === "publisher" && <PublisherPanel />}
      {tab === "podcast" && <PodcastPanel session={production} openAudio={() => setTab("audio")} />}
      {tab === "settings" && (
        <>
          <DriveSettings focusHeading={driveSetupShortcut} />
          <SettingsPanel checkModels={!driveSetupShortcut} settings={settings} onChange={setSettings} onClose={() => setTab(settingsReturnTab)} />
        </>
      )}

      {productionError && (tab === "audio" || tab === "create") && <p role="status">{productionError}</p>}

      {tab === "audio" && <AudioPanel original={production?.original} edited={production?.edited}
        onImport={file => changeProductionSource(file, "edited")}
        onCreate={() => setTab("create")} />}

      {(tab === "create" || studioVisited) && <div hidden={tab !== "create"}>
        <ShortsPanel
          production={production}
          onProductionFile={file => changeProductionSource(file, "original")}
          settings={settings}
          previousTitles={previousTitles}
          onModelChanged={(m) => setSettings((prev) => ({ ...prev, model: m }))}
        />
        <details className="card fold">
          <summary>従来の制作・中断した回</summary>
          <button type="button" onClick={() => setTab("legacy")}>従来の制作を開く</button>
        </details>
      </div>}

      {tab === "next" && (
        <InsightsPanel
          settings={settings}
          onModelChanged={(m) => setSettings((s) => ({ ...s, model: m }))}
        />
      )}

      {(tab === "history" || (tab === "settings" && settingsReturnTab === "history")) && (
        <div hidden={tab !== "history"}>
        <HistoryPanel
          onChooseTitle={(id, title) => {
            updateEpisode(id, { chosenTitle: title });
          }}
          onEditMeta={(id, patch) => {
            void listEpisodeAndPatch(id, patch);
          }}
          onCastEdit={(id, next) => {
            void updateEpisode(id, { cast: next || undefined });
          }}
          // 控えから設定を戻したら、動いているアプリにも反映する。
          // 反映しないと、次に何か触った拍子に古い設定で上書きされる
          onSettingsRestored={() => {
            const restored = loadSettings();
            setSettings(restored);
            setCast(restored.lastCast ?? "");
          }}
          showName={settings.prompt.showName}
          accentColor={settings.accentColor}
          promptConfig={settings.prompt}
          apiKey={settings.apiKey}
          model={settings.model}
          captionModel={settings.captionModel}
          onModelChanged={(m) => setSettings((prev) => ({ ...prev, model: m }))}
        />
        </div>
      )}

      {(tab === "legacy" || (tab === "settings" && settingsReturnTab === "legacy")) && (
        <div className="legacy-production" hidden={tab !== "legacy"}>
          <button type="button" onClick={() => setTab("create")}>素材選択に戻る</button>
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
                    ⬇️ 音声だけ取り出す
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
              onStart={(files, manualDb, measured, matchTone) => {
                setPickingTracks(null);
                void handleFile(files, manualDb, measured, matchTone);
              }}
              onCancel={() => setPickingTracks(null)}
            />
          )}

          {phase === "idle" && !pickingTracks && (
            <>
            {/* 「次の回」で決めたお題。収録の直前に探し直さなくて済むように */}
            {plan && (
              <div className="card plan-card">
                <div className="result-head">
                  <h2>📌 今日話すと決めたこと</h2>
                  <div className="head-actions">
                    <CopyButton text={planAsText(plan)} />
                    <button
                      className="copy-btn"
                      onClick={() => {
                        clearPlan();
                        setPlan(null);
                      }}
                    >
                      消す
                    </button>
                  </div>
                </div>
                <p className="plan-title">{plan.title}</p>
                {plan.hook && <p className="idea-hook">「{plan.hook}」</p>}
                {plan.angles.length > 0 && (
                  <ul className="idea-angles">
                    {plan.angles.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
                <p className="muted">
                  「次の回」で選んだお題です。収録が終わったら消してください。
                </p>
              </div>
            )}

            {/* 今回のパーソナリティ。聞く前に誰の回か分かるよう説明文の頭に出す */}
            <div className="card cast-card">
              <label htmlFor="cast-input" style={{ marginBottom: 4, fontWeight: 600 }}>
                🎤 今回の出演者
              </label>
              <input
                id="cast-input"
                type="text"
                value={cast}
                placeholder="例: たかやま・にし、ゲスト 山田さん"
                onChange={(e) => {
                  setCast(e.target.value);
                  setSettings((prev) => ({ ...prev, lastCast: e.target.value }));
                }}
              />
              <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
                {castLine(cast) ? (
                  <>
                    説明文の頭に <strong>「{castLine(cast)}」</strong> と入ります。
                    Spotify の一覧では再生前にここが見えるので、今回誰の回かが分かります。
                  </>
                ) : (
                  <>
                    入れておくと説明文の頭に「出演: ◯◯・△△」と入り、
                    <strong>聞く前に今回のパーソナリティが分かります</strong>。あとから足せます。
                  </>
                )}
              </p>
            </div>

            <label className="drop card">
              <input
                type="file"
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
                AI用に軽量化 → タイトル・説明文を生成します。元音声は加工しません
                <br />
                Geminiに送るのは32kbpsのモノラル音声だけです
              </p>
            </label>
            <details className="card fold">
              <summary>従来の複数トラック合成（任意）</summary>
              <p className="muted">人ごとの録音を整音・合成して配信用MP3を作ります。通常の制作では不要です。</p>
              <input aria-label="合成する音声" type="file" multiple accept="audio/*" style={{ minHeight: 44, maxWidth: "100%" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length > 1) setPickingTracks(files);
                  else if (files.length === 1) void handleFile(files[0]);
                }} />
            </details>
            </>
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
                onDisplayed={onResultDisplayed}
                chosenTitle={chosenTitle}
                onChooseTitle={(title) => {
                  setChosenTitle(title);
                  if (episodeId) updateEpisode(episodeId, { chosenTitle: title });
                  // 選んだタイトルを MP3 の中にも入れ直す
                  if (meta) void retagMp3(meta, title, "MP3 のタイトルを入れ直しています…");
                }}
                audioUrl={mp3Url}
                shortsSource={shortsSource}
                shortsEpisodeId={episodeId}
                shortsUploaded={uploaded}
                shortsDuration={convertedRef.current?.durationSec}
                fileName={outputName}
                showName={settings.prompt.showName}
                accentColor={settings.accentColor}
                promptConfig={settings.prompt}
                apiKey={settings.apiKey}
                model={settings.model}
                captionModel={settings.captionModel}
                onModelChanged={(m) => setSettings((prev) => ({ ...prev, model: m }))}
                audioReport={audioReport}
                originalAudio={!!convertedRef.current?.originalAudio}
                chapterNote={chapterNote}
                transcript={transcript}
                canReuseAudio={isAudioUsable(uploaded)}
                busyText={busyText}
                onRegenerate={regenerate}
                onMakeTranscript={makeTranscript}
                onEdit={editMeta}
                onBackgroundChange={() => void applyArtwork()}
                cast={cast}
                onCastChange={(next) => {
                  setCast(next);
                  setSettings((prev) => ({ ...prev, lastCast: next }));
                  if (episodeId) updateEpisode(episodeId, { cast: next.trim() || undefined });
                }}
              />
              <button className="primary" onClick={reset}>
                次のエピソードを処理する
              </button>
            </>
          )}
        </div>
      )}
      </Suspense>
    </DriveConnectionProvider>
  );
}
