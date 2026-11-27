import DriveSavePanel from "./DriveSavePanel";
import { readEpisodeDraft, saveEpisodeDraft } from "../lib/video/episodeCaptionCache";
import { archivedCaptionCues } from "../lib/video/archivedCaptions";
import CaptionPreview from "./CaptionPreview";
import SpeakerAssignments from "./SpeakerAssignments";
import { alignCues, formatCueTime, type CaptionCue, type SpeechSpan } from "../lib/video/captionAlignment";
import { addSpeaker, displayCues, swapSpeakerNames, type Speaker } from "../lib/video/speakers";
import CopyButton from "./CopyButton";
import { listEpisodes, saveEpisode } from "../lib/history";
import { withDeadline } from "../lib/deadline";
import { measureStage } from "../lib/timing";
import { ShortsAudioCache } from "../lib/shortsCache";
import ClipDetails from "./ClipDetails";
import { useEffect, useRef, useState } from "react";
import { noteError } from "../lib/errorLog";
import {
  findClips,
  generateSpotifyCopy,
  type EpisodeMeta,
  type UploadedAudio,
  type TranscriptSegment,
  isAudioUsable,
  transcribeRange,
  useDirectCaptionAudio,
  uploadEpisodeAudio,
  type Clip,
} from "../lib/gemini";
import { parseTimestamp } from "../lib/id3";
import type { Settings } from "../lib/settings";
import type { ClipCapability, CoverCandidate } from "../lib/video/clip";

// エンコーダは重いので、このページを開いてから取りに行く
const loadClipLib = () => import("../lib/video/clip");

interface Props {
  settings: Settings;
  previousTitles: string[];
  onModelChanged: (model: string) => void;
  existing?: {
    file: File;
    clips: Clip[];
    durationSec: number;
    episodeId?: string;
    hasVideo: boolean;
    transcript?: TranscriptSegment[] | null;
    uploaded?: UploadedAudio | null;
    background?: ImageBitmap | null;
    previewUrl?: string;
    onClipsFound?: (clips: Clip[]) => void;
  };
}

type Phase = "idle" | "extracting" | "finding" | "ready" | "captioning" | "rendering";

interface Nudge {
  start: number;
  end: number;
}

interface Result {
  blob: Blob;
  url: string;
  filename: string;
  title: string;
  post: string;
  description: string;
  hashtags: string[];
  startMs: number;
  endMs: number;
}

interface BatchProgress {
  position: number;
  total: number;
  clipIndex: number;
  cancelling: boolean;
}

/** 表紙。フィードで最初に目に入る1枚なので、動画とは別に選んで書き出す。 */
interface Cover {
  atSec: number;
  blob: Blob;
  url: string;
}

const ZERO: Nudge = { start: 0, end: 0 };

const fmt = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * 動画から縦型ショートを作るページ。
 *
 * 収録の回とは別に、撮った動画をそのまま投げ込めるようにしている。
 * 音声だけを Gemini に聴かせて面白い区間を選ばせ、映像はその区間を
 * 端末内で切り出す。動画そのものはどこにも送らない。
 */
export default function ShortsPanel({ settings, previousTitles, onModelChanged, existing }: Props) {
  const [phase, setPhase] = useState<Phase>(existing ? "ready" : "idle");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  /** 映像がこの端末で復号できない動画。音声と字幕だけで作ることになる。 */
  const [videoUnusable, setVideoUnusable] = useState(false);
  const [hasVideo, setHasVideo] = useState(existing?.hasVideo ?? false);
  const [background, setBackground] = useState<File | null>(null);
  const [spotify, setSpotify] = useState<Pick<EpisodeMeta, "titles" | "description"> | null>(null);
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyError, setSpotifyError] = useState("");
  const spotifyRef = useRef<AbortController | null>(null);
  const analysisRef = useRef<{ file: File; audio: UploadedAudio; facts: string[]; clips: Clip[]; durationSec: number } | null>(null);
  const [fileInfo, setFileInfo] = useState(existing?.file.name ?? "");
  const [clips, setClips] = useState<Clip[]>(existing?.clips ?? []);
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState<number[]>(existing?.clips.map((_, i) => i) ?? []);
  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const [batchSummary, setBatchSummary] = useState("");
  const [failures, setFailures] = useState<Partial<Record<number, string>>>({});
  // 候補ごとに、範囲・字幕・書き出した動画をそれぞれ持つ。
  // まとめて書き出すときに1本ずつの状態が要るため。
  const [nudges, setNudges] = useState<Record<number, Nudge>>({});
  const [captions, setCaptions] = useState<Record<number, CaptionCue[]>>({});
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speakerLinks, setSpeakerLinks] = useState<Record<number, Record<string, string>>>({});
  const captionActivity = useRef(new Map<string, SpeechSpan[]>());
  const newEpisodeId = useRef<string>();
  const rangeDrafts = useRef(new Map<string, CaptionCue[]>());
  const [results, setResults] = useState<Record<number, Result>>({});
  const [frames, setFrames] = useState<Record<number, CoverCandidate[]>>({});
  const [covers, setCovers] = useState<Record<number, Cover>>({});
  const [withCaptions, setWithCaptions] = useState(!existing || !!settings.apiKey || !!existing.transcript?.length);
  const [cap, setCap] = useState<ClipCapability | null | undefined>(undefined);
  const [shareStatus, setShareStatus] = useState("");
  const previousArchiveBackground = useRef(existing?.background);

  const fileRef = useRef<File | null>(existing?.file ?? null);
  const sourceAudioRef = useRef<{ mp3: ArrayBuffer; durationSec: number } | null>(null);
  const sourceCacheRef = useRef(new ShortsAudioCache());
  const rangeCacheRef = useRef(new ShortsAudioCache(4));
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
      spotifyRef.current?.abort();
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  const nudgeOf = (i: number) => nudges[i] ?? ZERO;

  const sourceDuration = () => existing?.durationSec ?? sourceAudioRef.current?.durationSec;

  const rangeOf = (i: number) => {
    const c = clips[i];
    if (!c) return { startSec: 0, endSec: 0 };
    const n = nudgeOf(i);
    const rawStart = (parseTimestamp(c.start) ?? 0) / 1000;
    const rawEnd = (parseTimestamp(c.end) ?? (rawStart + 45) * 1000) / 1000;
    const limit = sourceDuration() ?? rawEnd;
    const startSec = Math.min(Math.max(0, limit - 5), Math.max(0, rawStart + n.start));
    return { startSec, endSec: Math.min(limit, startSec + 90, Math.max(startSec + 5, rawEnd + n.end)) };
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

  useEffect(() => {
    if (previousArchiveBackground.current === existing?.background) return;
    previousArchiveBackground.current = existing?.background;
    if (hasVideo || background) return;
    setResults(prev => {
      for (const result of Object.values(prev)) {
        URL.revokeObjectURL(result.url);
        urlsRef.current.delete(result.url);
      }
      return {};
    });
  }, [existing?.background, hasVideo, background]);

  /** 範囲が変わると表紙の候補も別物になる。 */
  const dropCover = (i: number) => {
    setFrames((prev) => {
      if (!prev[i]) return prev;
      const next = { ...prev };
      delete next[i];
      return next;
    });
    setCovers((prev) => {
      const c = prev[i];
      if (!c) return prev;
      URL.revokeObjectURL(c.url);
      urlsRef.current.delete(c.url);
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };

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
    setSpeakerLinks(prev => ({ ...prev, [i]: {} }));
    dropResult(i);
    dropCover(i);
  };

  /** 動画から AI に聴かせる用の音声だけを取り出す(無音カットはしない)。 */
  const extractAudio = (file: File, signal: AbortSignal): Promise<{ mp3: ArrayBuffer; durationSec: number }> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL("../lib/encoder.worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("中止しました", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "progress") setProgress(msg.fraction ?? 0);
        else if (msg.type === "done") {
          cleanup();
          resolve({ mp3: msg.aiMp3, durationSec: msg.durationSec ?? 0 });
        } else if (msg.type === "error") {
          cleanup();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = () => {
        cleanup();
        reject(new Error("素材から音声を読み取れませんでした"));
      };
      worker.postMessage({
        file,
        // 配信用 MP3 も音量合わせも要らない。AI に聴かせるぶんだけ1回で作る
        // (10分の素材で 17秒 → 4秒 になる)
        purpose: "ai",
        // 無音カットを有効にすると音声と映像の時刻がずれるため、必ず切っておく
        dsp: { ...settings.dsp, trimSilence: false, highPass: false },
        mono: true,
        bitrate: settings.bitrate,
      });
    });

  const clearSpotify = () => {
    spotifyRef.current?.abort();
    spotifyRef.current = null;
    analysisRef.current = null;
    setSpotify(null);
    setSpotifyBusy(false);
    setSpotifyError("");
  };

  const makeSpotify = async (model = settings.model) => {
    const analysis = analysisRef.current;
    if (!analysis || spotifyRef.current) return;
    const controller = new AbortController();
    spotifyRef.current = controller;
    setSpotifyBusy(true);
    setSpotifyError("");
    try {
      const recent = await listEpisodes().then(rows => rows.slice(0, 8).map(row => row.chosenTitle || row.meta.titles[0]).filter(Boolean)).catch(() => previousTitles);
      controller.signal.throwIfAborted();
      const copy = await generateSpotifyCopy({
        apiKey: settings.apiKey,
        model,
        facts: analysis.facts,
        audio: analysis.audio,
        config: settings.prompt,
        previousTitles: recent,
        onModelChanged,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const id = crypto.randomUUID();
      await saveEpisode({
        id, createdAt: Date.now(), fileName: analysis.file.name,
        durationSec: analysis.durationSec, removedSec: 0, chosenTitle: copy.titles[0],
        audio: analysis.file, originalAudio: true, uploaded: analysis.audio,
        meta: { ...copy, clips: analysis.clips, showNotes: "", chapters: [], hashtags: [], transcriptSummary: "", keywords: [] },
      }).catch(() => {
        if (!controller.signal.aborted) setSpotifyError("文章を表示しました。履歴に保存できなかったため、コピーして控えてください。");
      });
      if (!controller.signal.aborted) {
        newEpisodeId.current = id;
        for (const [range, cues] of rangeDrafts.current) saveEpisodeDraft(id, range, cues);
        setSpotify(copy);
      }
    } catch (e) {
      if (!controller.signal.aborted) setSpotifyError(noteError("Spotify用文章", e, settings.model));
    } finally {
      if (spotifyRef.current === controller) {
        spotifyRef.current = null;
        setSpotifyBusy(false);
      }
    }
  };

  const handleFile = async (file: File) => {
    if (!settings.apiKey) {
      setError("先に設定画面で Gemini API キーを入力してください");
      return;
    }
    abortRef.current?.abort();
    workerRef.current?.terminate();
    clearSpotify();
    setBackground(null);
    setHasVideo(false);
    fileRef.current = file;
    sourceAudioRef.current = null;
    sourceCacheRef.current.clear();
    rangeCacheRef.current.clear();
    setClips([]);
    setSelected(0);
    setChecked([]);
    setFailures({});
    setBatchSummary("");
    setShareStatus("");
    setNudges({});
    setCaptions({});
    setSpeakers([]);
    setSpeakerLinks({});
    captionActivity.current.clear();
    rangeDrafts.current.clear();
    newEpisodeId.current = undefined;
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current.clear();
    setResults({});
    setFrames({});
    setCovers({});
    setError("");
    setFileInfo(`${file.name}(${(file.size / 1024 / 1024).toFixed(0)} MB)`);
    setPhase("extracting");
    setStatus("素材の音声を準備しています…");
    setProgress(0);
    setVideoUnusable(false);

    await findCandidates();
  };

  const findCandidates = async () => {
    const file = fileRef.current;
    if (!file) return;
    setError("");
    setPhase(sourceAudioRef.current ? "finding" : "extracting");
    setStatus(sourceAudioRef.current ? "候補の抽出を再開しています…" : "素材の音声を準備しています…");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // 映像がこの端末で復号できるかを**先に**見る。
      // 出来ないと分かるのが書き出しの瞬間だと、AI の呼び出し(無料枠)も
      // 範囲の調整も全部やり直しになる。ここで一言出しておけば選び直せる
      const { inspectVideo } = await loadClipLib();
      const { hasVideo: video, decodable } = await inspectVideo(file);
      controller.signal.throwIfAborted();
      setHasVideo(decodable);
      setVideoUnusable(video && !decodable);

      const reusable = existing?.uploaded;
      if (!isAudioUsable(reusable) && !sourceAudioRef.current) {
        sourceAudioRef.current = await measureStage("conversion", () => extractAudio(file, controller.signal));
      }
      controller.signal.throwIfAborted();
      const mp3 = sourceAudioRef.current?.mp3;
      const durationSec = sourceDuration() ?? 0;
      setPhase("finding");
      setProgress(0);
      const audio = isAudioUsable(reusable) ? reusable! : await sourceCacheRef.current.get("source", settings.apiKey,
        async () => mp3!,
        bytes => uploadEpisodeAudio(settings.apiKey, bytes, setStatus, setProgress, controller.signal));
      controller.signal.throwIfAborted();
      let facts: string[] = [];
      let model = settings.model;
      const found = await findClips({
        audio,
        apiKey: settings.apiKey,
        model: settings.model,
        mp3,
        durationSec,
        onStatus: setStatus,
        onUploadProgress: setProgress,
        onEpisodeFacts: existing ? undefined : (value) => { facts = value; },
        onModelChanged: value => { model = value; onModelChanged(value); },
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      analysisRef.current = { file, audio, facts, clips: found, durationSec };
      setClips(found);
      existing?.onClipsFound?.(found);
      setChecked(found.map((_, i) => i));
      setPhase("ready");
      setStatus("");
      if (!existing) void makeSpotify(model);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(noteError("ショート", e, settings.model));
      setPhase(clips.length > 0 ? "ready" : "idle");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  /**
   * その候補の字幕を作る。
   *
   * 「この区間の音声」だけを切り出して渡す。全編を聴かせて「12:34 から」と
   * 頼むと AI はファイルの頭から数えることになり、後ろの回ほど時刻がずれる。
   */
  const buildCaptions = async (i: number, signal: AbortSignal): Promise<CaptionCue[]> => {
    const draft = captions[i];
    if (draft) return draft;
    const file = fileRef.current!;
    const { startSec, endSec } = rangeOf(i);
    const durationMs = Math.round((endSec - startSec) * 1000);
    const rangeKey = JSON.stringify([startSec, endSec]);
    const cached = rangeDrafts.current.get(rangeKey);
    if (cached) {
      // Local edits and speaker assignments remain scoped to each candidate.
      setCaptions(prev => ({ ...prev, [i]: cached }));
      return cached;
    }
    const { prepareCaptionAudio, captionActivityForRange } = await loadClipLib();
    const archived = archivedCaptionCues(existing?.transcript, startSec, endSec, sourceDuration() ?? endSec);
    if (archived) {
      setStatus("保存済み字幕を音声に合わせています…");
      const activity = await measureStage("caption-audio-decode", () => captionActivityForRange(file, startSec, endSec, signal));
      signal.throwIfAborted();
      const aligned = await measureStage("caption-alignment", async () => alignCues(archived, activity, durationMs));
      rangeDrafts.current.set(rangeKey, aligned);
      if (rangeDrafts.current.size > 4) rangeDrafts.current.delete(rangeDrafts.current.keys().next().value!);
      setCaptions(prev => ({ ...prev, [i]: aligned }));
      return aligned;
    }
    const episodeId = existing?.episodeId ?? newEpisodeId.current;
    const sharedDraft = episodeId ? readEpisodeDraft(episodeId, rangeKey) : undefined;
    if (sharedDraft) {
      setCaptions(prev => ({ ...prev, [i]: sharedDraft }));
      return sharedDraft;
    }
    if (!settings.apiKey) throw new Error("保存済みの字幕が区間全体にありません。Gemini APIキーを設定するか、字幕をオフにしてください。");
    setStatus("この区間の音声を取り出しています…");
    const extract = async () => {
      const prepared = await measureStage("caption-conversion", () => prepareCaptionAudio(file, startSec, endSec, signal));
      signal.throwIfAborted();
      captionActivity.current.set(rangeKey, prepared.activity);
      if (captionActivity.current.size > 4) {
        const oldest = captionActivity.current.keys().next().value;
        if (oldest !== undefined) captionActivity.current.delete(oldest);
      }
      return prepared.wav;
    };
    const audio = useDirectCaptionAudio(durationMs)
      ? { wav: await rangeCacheRef.current.getBytes(rangeKey, extract) }
      : await rangeCacheRef.current.get(rangeKey, settings.apiKey, extract, bytes =>
        withDeadline(signal, 45_000, deadline => uploadEpisodeAudio(settings.apiKey, bytes, setStatus, undefined, deadline, "audio/wav")));
    signal.throwIfAborted();
    const raw = await transcribeRange({
      apiKey: settings.apiKey,
      model: settings.model,
      audio,
      durationMs,
      glossary: settings.prompt.glossary,
      onStatus: setStatus,
      onModelChanged,
      signal,
    });
    signal.throwIfAborted();
    setStatus("字幕を調整しています…");
    const aligned = await measureStage("caption-alignment", async () => alignCues(raw, captionActivity.current.get(rangeKey) ?? [], durationMs));
    rangeDrafts.current.set(rangeKey, aligned);
    const savedId = existing?.episodeId ?? newEpisodeId.current;
    if (savedId) saveEpisodeDraft(savedId, rangeKey, aligned);
    if (rangeDrafts.current.size > 4) {
      const oldest = rangeDrafts.current.keys().next().value;
      if (oldest !== undefined) rangeDrafts.current.delete(oldest);
    }
    setCaptions(prev => ({ ...prev, [i]: aligned }));
    return aligned;
  };

  /** 書き出す前に字幕を確認・修正できるようにする。焼き込んでからでは直せないため。 */
  const prepareCaptions = async () => {
    if (!fileRef.current || !clips[selected] || abortRef.current) return;
    setError("");
    setPhase("captioning");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await buildCaptions(selected, controller.signal);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(noteError("ショート", e, settings.model));
      }
    } finally {
      setPhase("ready");
      setStatus("");
      abortRef.current = null;
    }
  };

  const editCaption = (i: number, line: number, patch: Partial<Pick<CaptionCue, "text" | "speakerId" | "personOverride" | "startMs" | "endMs">>) => {
    setCaptions((prev) => {
      const list = prev[i];
      if (!list) return prev;
      const next = list.slice();
      next[line] = { ...next[line], ...patch };
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
    const segments = withCaptions ? await buildCaptions(i, signal) : [];
    signal.throwIfAborted();
    const captionCues = displayCues(segments, speakers, speakerLinks[i] ?? {}, Math.round((endSec - startSec) * 1000));
    const { renderClip } = await loadClipLib();
    setStatus(`動画を書き出しています…(${clip.hook || `候補${i + 1}`})`);
    const [bitmap, logo] = await Promise.all([
      background ? createImageBitmap(background).catch(() => null) : null,
      hasVideo ? null : fetch(new URL("icon-192.png", document.baseURI))
        .then(response => response.ok ? response.blob() : Promise.reject())
        .then(blob => createImageBitmap(blob)).catch(() => null),
    ]);
    let blob: Blob;
    try {
      signal.throwIfAborted();
      blob = await measureStage("video-export", () => renderClip({
        ...(hasVideo ? { videoFile: file } : { audioFile: file }),
        background: bitmap ?? existing?.background ?? undefined,
        logo: logo ?? undefined,
        startSec,
        endSec,
        hook: clip.hook,
        showName: settings.prompt.showName || "BRIDGE RADIO",
        accent: settings.accentColor,
        captionCues,
        signal,
        capability: cap ?? undefined,
      }));
    } finally {
      bitmap?.close();
      logo?.close();
    }
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    urlsRef.current.add(url);
    setResults((prev) => {
      const old = prev[i];
      if (old) {
        URL.revokeObjectURL(old.url);
        urlsRef.current.delete(old.url);
      }
      const extension = blob.type === "video/mp4" ? "mp4" : "webm";
      const title = clip.hook || `候補${i + 1}`;
      const post = [clip.socialPost, clip.hashtags?.join(" ")].filter(Boolean).join("\n\n");
      return { ...prev, [i]: {
        blob, url, filename: `short${i + 1}.${extension}`, title, post,
        description: clip.socialPost ?? "", hashtags: clip.hashtags ?? [],
        startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000),
      } };
    });
  };

  /** One decoder/encoder at a time. Commit each result before starting the next candidate. */
  const make = async (indexes: number[]) => {
    if (!fileRef.current || indexes.length === 0 || abortRef.current || !cap) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setBatchSummary("");
    setPhase("rendering");
    let completed = 0;
    let failed = 0;
    try {
      for (const [index, clipIndex] of indexes.entries()) {
        if (controller.signal.aborted) break;
        setBatch({ position: index + 1, total: indexes.length, clipIndex, cancelling: false });
        setProgress(0);
        setStatus("動画の生成を準備しています…");
        try {
          await renderOne(clipIndex, controller.signal);
          completed++;
          setFailures(prev => {
            const next = { ...prev };
            delete next[clipIndex];
            return next;
          });
        } catch (e) {
          if (controller.signal.aborted) break;
          failed++;
          const message = noteError("ショート書き出し", e, settings.model);
          setFailures(prev => ({ ...prev, [clipIndex]: message }));
        }
      }
    } finally {
      const remaining = indexes.length - completed - failed;
      setBatchSummary([
        controller.signal.aborted ? "生成を中断しました。" : "",
        `完了 ${completed}本`, `失敗 ${failed}本`,
        remaining ? `未完了 ${remaining}本` : "",
      ].filter(Boolean).join(" / "));
      abortRef.current = null;
      setBatch(null);
      setPhase("ready");
      setStatus("");
    }
  };

  /**
   * 表紙の候補になるコマを取り出す。
   * フィードで最初に目に入るのは1枚の絵なので、先頭のコマ任せにしない。
   */
  const pickFrames = async () => {
    const file = fileRef.current;
    if (!file) return;
    setError("");
    setPhase("rendering");
    setStatus("表紙の候補を取り出しています…");
    setProgress(0);
    try {
      const { sampleCoverFrames } = await loadClipLib();
      const { startSec, endSec } = rangeOf(selected);
      const found = await sampleCoverFrames(file, startSec, endSec);
      if (found.length === 0) setError("この動画からはコマを取り出せませんでした");
      setFrames((prev) => ({ ...prev, [selected]: found }));
    } catch (e) {
      setError(noteError("ショート", e, settings.model));
    } finally {
      setPhase("ready");
      setStatus("");
    }
  };

  const chooseCover = async (atSec: number) => {
    const file = fileRef.current;
    const clip = clips[selected];
    if (!file || !clip) return;
    setError("");
    setPhase("rendering");
    setStatus("表紙を書き出しています…");
    try {
      const { renderCover } = await loadClipLib();
      const blob = await renderCover({
        videoFile: file,
        atSec,
        hook: clip.hook,
        showName: settings.prompt.showName,
        accent: settings.accentColor,
      });
      const url = URL.createObjectURL(blob);
      urlsRef.current.add(url);
      setCovers((prev) => {
        const old = prev[selected];
        if (old) {
          URL.revokeObjectURL(old.url);
          urlsRef.current.delete(old.url);
        }
        return { ...prev, [selected]: { atSec, blob, url } };
      });
    } catch (e) {
      setError(noteError("ショート", e, settings.model));
    } finally {
      setPhase("ready");
      setStatus("");
    }
  };

  const completedVideos = Object.entries(results).map(([key, result]) => ({
    index: Number(key), ...result,
  }));
  const readyToShare = (videos: Result[]) => {
    if (!videos.length || typeof navigator.canShare !== "function" || typeof navigator.share !== "function") return false;
    try {
      return navigator.canShare({ files: videos.map(video => new File([video.blob], video.filename, { type: video.blob.type })) });
    } catch {
      return false;
    }
  };
  const shareVideos = async (videos: Result[]) => {
    try {
      await navigator.share({
        files: videos.map(video => new File([video.blob], video.filename, { type: video.blob.type })),
        title: videos.length === 1 ? videos[0].title : "AI STUDIO ショート動画",
      });
      setShareStatus(videos.length === 1 ? "動画を共有しました。" : "動画をまとめて共有しました。");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setShareStatus("共有できませんでした。個別のダウンロードをお試しください。");
    }
  };

  const busy =
    phase === "extracting" || phase === "finding" || phase === "rendering" || phase === "captioning";
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    setElapsedSeconds(0);
    if (!busy) return;
    const start = performance.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((performance.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const { startSec, endSec } = rangeOf(selected);
  const lines = captions[selected];
  const localSpeakerIds = [...new Set(lines?.map(cue => cue.speakerId))].sort();
  const refreshExportsForNames = (...ids: string[]) => {
    clips.forEach((_, i) => {
      const linked = Object.values(speakerLinks[i] ?? {}).some(id => ids.includes(id));
      const overridden = captions[i]?.some(cue => cue.personOverride && ids.includes(cue.personOverride));
      if (linked || overridden) dropResult(i);
    });
  };
  const durationMs = Math.round((endSec - startSec) * 1000);
  const selectedLinks = speakerLinks[selected] ?? {};
  const doneCount = completedVideos.length;
  const batchTargets = checked.filter(i => !results[i] || failures[i]).sort((a, b) => a - b);
  const allTargets = clips.flatMap((_, i) => !results[i] || failures[i] ? [i] : []);
  const failedIndexes = Object.keys(failures).map(Number);
  const overallProgress = batch ? (batch.position - 1 + progress) / batch.total : progress;

  return (
    <>
      {error && <div className="error">⚠️ {error}</div>}

      {videoUnusable && (
        <div className="notice">
          ⚠️ <strong>この動画の映像は、この端末では再生できない形式です。</strong>
          <br />
          音声と字幕は使えるので、<strong>単色の背景で縦型ショートを作れます</strong>
          (元の映像は入りません)。映像も入れたい場合は、スマホのカメラで撮った動画や、
          MP4(H.264)で書き出した動画をお使いください。
          <br />
          <span className="muted">
            パソコンの画面録画やブラウザの録画機能で作った動画で起きやすい形式の食い違いです。
          </span>
        </div>
      )}

      {!existing && phase === "idle" && clips.length === 0 && fileRef.current && (
        <div className="card">
          <p className="muted">{fileInfo} — 完了した音声処理・有効な送信済み音声を再利用します。</p>
          <button className="primary" onClick={() => void findCandidates()}>候補の抽出を再開する</button>
        </div>
      )}
      {!existing && phase === "idle" && clips.length === 0 && (
        <label className="drop card production-picker">
          <input
            type="file"
            aria-label="音声または動画を選択"
            accept="audio/*,video/*,.wav,.mp3,.m4a,.aac,.mp4,.mov,.m4v,.webm,.flac,.opus,.ogg,.caf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          <p style={{ fontSize: "2rem", margin: "0 0 8px" }}>🎬</p>
          <p style={{ margin: 0, fontWeight: 600 }}>音声または動画を選択</p>
          <p className="muted">
            MP4 / MOV / WAV / MP3 など。素材を一度選ぶと、ショート候補とSpotify用の文章を作ります。
            <br />
            動画そのものは端末から出ません(送るのは音声だけです)
          </p>
        </label>
      )}

      {busy && (
        <div className="card">
          <h2>⏳ {batch?.cancelling ? "中断しています…" : status || "処理中…"}</h2>
          {batch && <p role="status">
            {batch.position}本目 / 全{batch.total}本 · {clips[batch.clipIndex].hook || `候補${batch.clipIndex + 1}`}

          </p>}
          <p>経過 {elapsedSeconds}秒</p>
          <p className="muted">{fileInfo}</p>
          {phase === "extracting" && <div className="progress-track" role="progressbar" aria-label={batch ? "生成全体の進捗" : "進捗"}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overallProgress * 100)}>
            <div className="progress-fill" style={{ width: `${Math.round(overallProgress * 100)}%` }} />
          </div>}
          {(batch || abortRef.current) && <button
            type="button"
            disabled={batch?.cancelling}
            onClick={() => {
              abortRef.current?.abort();
              if (batch) {
                setBatch({ ...batch, cancelling: true });
              } else {
                setPhase(clips.length > 0 ? "ready" : "idle");
              }
            }}
          >
            {batch ? "生成を中断" : "やめる"}
          </button>}
        </div>
      )}

      {existing && !busy && !clips.length && <section className="card">
        <h2>ショートの候補</h2>
        <button type="button" className="primary" disabled={!settings.apiKey} onClick={() => void findCandidates()}>この素材から候補を作る</button>
        {!settings.apiKey && <p>候補を作るにはGemini APIキーを設定してください。</p>}
      </section>}
      {batchSummary && <p role="status" className="card">{batchSummary}</p>}
      {clips.length > 0 && !busy && (
        <div className="card">
          <h2>✂️ ショートの候補</h2>
          <button type="button" className="primary shorts-all-generate" disabled={!cap || !allTargets.length}
            onClick={() => { setChecked(clips.map((_, i) => i)); void make(allTargets); }}>
            すべてのショート動画をまとめて生成
          </button>
          <p className="muted">{fileInfo}</p>
          <div className="row-buttons">
            <button type="button" disabled={checked.length === clips.length} onClick={() => setChecked(clips.map((_, i) => i))}>全選択</button>
            <button type="button" disabled={!checked.length} onClick={() => setChecked([])}>全解除</button>
          </div>
          <p>{checked.length}本を選択 · {batchTargets.length}本を生成</p>

          {clips.map((c, i) => {
            const r = rangeOf(i);
            return (
              <div
                key={i}
                className={`title-option${i === selected ? " chosen" : ""}`}
                style={{ display: "block" }}
              >
                <label className="check">
                  <input type="checkbox" checked={checked.includes(i)} onChange={event => {
                    const enabled = event.currentTarget.checked;
                    setChecked(prev => enabled ? [...prev, i] : prev.filter(index => index !== i));
                  }} />
                  {c.hook || `候補${i + 1}`}を一括生成に含める
                </label>
                <button type="button" aria-pressed={i === selected} onClick={() => setSelected(i)}>
                  {i === selected ? "★ " : ""}
                  {results[i] ? "✅ " : ""}
                  {c.hook || "(見出しなし)"}
                </button>
                <div className="muted" style={{ marginTop: 4 }}>
                  {fmt(r.startSec)}〜{fmt(r.endSec)}({Math.round(r.endSec - r.startSec)}秒)
                  {c.why ? ` ・ ${c.why}` : ""}
                </div>
                {failures[i] && <div className="error">
                  <p>{failures[i]}</p>
                  <button type="button" disabled={!cap} onClick={() => void make([i])}>候補{i + 1}を再試行</button>
                </div>}
                <ClipDetails clip={c} />
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

          {existing?.previewUrl && <audio controls preload="none"
            src={`${existing.previewUrl}#t=${startSec},${endSec}`} style={{ width: "100%" }} />}

          {!hasVideo && (
            <label>
              ショートの背景画像（任意）
              <input type="file" className="shorts-asset-picker" accept="image/*" onChange={e => {
                setBackground(e.target.files?.[0] ?? null);
                clips.forEach((_, i) => dropResult(i));
              }} />
            </label>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={withCaptions}
              onChange={(e) => {
                setWithCaptions(e.target.checked);
                clips.forEach((_, i) => dropResult(i));
              }}
            />
            <span>
              字幕を入れる
              <br />
              <span className="muted">
                {existing?.transcript?.length ? "区間をカバーする保存済みの書き起こしを使い、不足時は区間だけ生成します。" : "選んだ区間だけを書き起こします。"}
              </span>
            </span>
          </label>

          {cap === null && (
            <p className="muted">
              この端末では動画を書き出せません(WebCodecs 非対応)。ブラウザを更新するか、パソコンでお試しください。
            </p>
          )}
          {cap && <p className="muted">{cap.mp4 ? "出力形式 MP4（H.264 / AAC）" : "出力形式 WebM。SNS投稿用のMP4は対応する端末で書き出してください。"}</p>}

          {cap && (
            <>
              {withCaptions && !lines && (
                <button onClick={prepareCaptions}>📝 先に字幕を作って確認する</button>
              )}
              <button className="primary" onClick={() => void make([selected])}>
                🎬 この範囲を縦型ショートにする
              </button>
              <button type="button" className="primary" disabled={!batchTargets.length} onClick={() => void make(batchTargets)}>
                選択した動画をまとめて生成
              </button>
              {failedIndexes.length > 0 && (
                <button type="button" onClick={() => void make(failedIndexes)}>失敗した動画だけ再試行</button>
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
          {lines.length > 0 && (
            <>
              <CaptionPreview
                key={`${selected}:${startSec}:${endSec}`}
                cues={displayCues(lines, speakers, selectedLinks, durationMs)}
                load={async () => (await loadClipLib()).createCaptionPreview(fileRef.current!, startSec, endSec)}
              />
              <SpeakerAssignments
                localIds={localSpeakerIds}
                speakers={speakers}
                links={selectedLinks}
                onName={(id, name) => {
                  setSpeakers(prev => prev.map(person => person.id === id ? { ...person, name } : person));
                  refreshExportsForNames(id);
                }}
                onAdd={localId => {
                  const next = addSpeaker(speakers);
                  setSpeakers(next);
                  if (localId) {
                    setSpeakerLinks(prev => ({ ...prev, [selected]: { ...prev[selected], [localId]: next[next.length - 1].id } }));
                    dropResult(selected);
                  }
                }}
                onLink={(localId, id) => {
                  setSpeakerLinks(prev => ({ ...prev, [selected]: { ...prev[selected], [localId]: id } }));
                  dropResult(selected);
                }}
                onSwap={(a, b) => {
                  setSpeakers(prev => swapSpeakerNames(prev, a, b));
                  refreshExportsForNames(a, b);
                }}
              />
              {lines.map((cue, k) => (
                <div key={k} className="caption-edit">
                  <p className="muted">{formatCueTime(cue.startMs)} – {formatCueTime(cue.endMs)} {cue.needsReview && "・要確認"}</p>
                  <div className="caption-row">
                    <select aria-label={`話者 ${k + 1}`} value={cue.personOverride ?? cue.speakerId}
                      onChange={e => {
                        const id = e.target.value;
                        editCaption(selected, k, id.startsWith("person-") ? { personOverride: id }
                          : { speakerId: id, personOverride: undefined });
                      }}>
                      <optgroup label="候補内の話者">
                        {[...new Set([...localSpeakerIds, "不明"])].map(id => <option key={id}>{id}</option>)}
                      </optgroup>
                      {speakers.length > 0 && <optgroup label="出演者を直接指定">
                        {speakers.map((person, i) => <option key={person.id} value={person.id}>
                          {person.name.trim() || `出演者 ${i + 1}`}
                        </option>)}
                      </optgroup>}
                    </select>
                    <input aria-label={`字幕 ${k + 1}`} value={cue.text}
                      onChange={e => editCaption(selected, k, { text: e.target.value })} />
                    <button type="button" className="caption-del" onClick={() => removeCaption(selected, k)} aria-label={`字幕 ${k + 1} を削除`}>✕</button>
                  </div>
                  <details className="fold">
                    <summary>時刻を調整（秒）</summary>
                    <div className="row-buttons">
                      {(["startMs", "endMs"] as const).map(field => {
                        const label = field === "startMs" ? "開始" : "終了";
                        return <label key={field}>{label}
                          <input aria-label={`字幕 ${k + 1} の${label}秒`} type="number" min={0}
                            max={durationMs / 1000} step="0.001" inputMode="decimal"
                            value={cue[field] === null ? "" : cue[field]! / 1000}
                            onChange={e => {
                              const n = e.currentTarget.valueAsNumber;
                              editCaption(selected, k, { [field]: Number.isFinite(n) ? Math.round(n * 1000) : null });
                            }} />
                        </label>;
                      })}
                    </div>
                    {(cue.startMs === null || cue.endMs === null || cue.startMs >= cue.endMs || cue.startMs < 0 || cue.endMs > durationMs) &&
                      <p className="muted">開始・終了が確定するまで、この字幕は表示されません。</p>}
                  </details>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* 表紙。フィードで最初に目に入る1枚なので、先頭のコマ任せにしない */}
      {hasVideo && clips.length > 0 && !busy && cap !== null && (
        <div className="card">
          <h2>🖼 表紙(カバー画像)</h2>
          <p className="muted">
            フィードで最初に目に入るのは動画ではなく<strong>1枚の絵</strong>です。先頭のコマが
            たまたま目を閉じていたり見切れていたりすると、それだけで見られなくなります。
            <br />
            区間の中から選んで、見出し入りの 1080×1920 で書き出します。Instagram も YouTube も
            表紙だけ別の画像を上げられます(動画そのものには手を入れないので、音とのずれは出ません)。
          </p>

          {!frames[selected] && (
            <button onClick={pickFrames}>🎞 この区間から表紙の候補を出す</button>
          )}

          {frames[selected] && frames[selected].length > 0 && (
            <div className="cover-strip">
              {frames[selected].map((f) => (
                <button
                  key={f.atSec}
                  className={`cover-thumb${covers[selected]?.atSec === f.atSec ? " chosen" : ""}`}
                  onClick={() => void chooseCover(f.atSec)}
                >
                  <img src={f.thumb} alt="" />
                  <span className="muted">{fmt(f.atSec)}</span>
                </button>
              ))}
            </div>
          )}

          {covers[selected] && (
            <>
              <img className="card-preview" src={covers[selected].url} alt="表紙" />
              <a
                className="dl"
                href={covers[selected].url}
                download={`cover${selected + 1}.jpg`}
              >
                ⬇️ 表紙をダウンロード({Math.round(covers[selected].blob.size / 1024)} KB)
              </a>
            </>
          )}
        </div>
      )}

      {doneCount > 0 && (
        <section className="card">
          <h2>📱 書き出した動画({doneCount}本)</h2>
          {!busy && doneCount > 1 && readyToShare(completedVideos) && (
            <button type="button" onClick={() => void shareVideos(completedVideos)}>完成動画をまとめて共有・保存</button>
          )}
          {shareStatus && <p role="status">{shareStatus}</p>}
          {completedVideos.map(video => (
            <div key={video.index} className="clip-result">
              <h3>{video.title}</h3>
              {!busy && <video className="card-preview" src={video.url} controls playsInline preload="none" />}
              <a className="dl" href={video.url} download={video.filename}>
                ⬇️ {video.filename} を保存（{(video.blob.size / 1024 / 1024).toFixed(1)} MB）
              </a>
              {!busy && readyToShare([video]) && (
                <button type="button" onClick={() => void shareVideos([video])}>共有・保存</button>
              )}
              <details className="fold">
                <summary>投稿文・ハッシュタグ</summary>
                <label>投稿文（{video.title}）
                  <textarea value={video.description} disabled={busy} onChange={event => {
                    const description = event.target.value;
                    setClips(previous => previous.map((clip, index) => index === video.index ? { ...clip, socialPost: description } : clip));
                    setResults(previous => {
                      const result = previous[video.index];
                      if (!result || result.url !== video.url) return previous;
                      const post = [description, result.hashtags.join(" ")].filter(Boolean).join("\n\n");
                      return { ...previous, [video.index]: { ...result, description, post } };
                    });
                  }} />
                </label>
                {video.hashtags.length > 0 && <p>{video.hashtags.join(" ")}</p>}
                {video.post && <CopyButton text={video.post} label="投稿文とハッシュタグをコピー" />}
              </details>
            </div>
          ))}
        </section>
      )}

      {doneCount > 0 && fileRef.current && (
        <DriveSavePanel videos={completedVideos} source={fileRef.current} encoding={busy} />
      )}

      {!existing && clips.length > 0 && (
        <section className="card">
          <h2>Spotify用タイトル・概要欄</h2>
          {spotifyBusy && <p role="status">文章を準備中です。ショートの編集を進められます。</p>}
          {spotifyError && <p role="alert">{spotifyError}</p>}
          {!spotify && !spotifyBusy && <button type="button" onClick={() => void makeSpotify()}>Spotify用文章を再試行</button>}
          {spotify?.titles.map(title => <div className="title-option" key={title}><span>{title}</span><CopyButton text={title} /></div>)}
          {spotify && <><p className="result-body">{spotify.description}</p><CopyButton text={spotify.description} label="概要欄をコピー" /></>}
        </section>
      )}

      {!existing && clips.length > 0 && !busy && (
        <div className="card">
          <button
            onClick={() => {
              setClips([]);
              setChecked([]);
              setFailures({});
              setBatchSummary("");
              setShareStatus("");
              setPhase("idle");
              clearSpotify();
              sourceAudioRef.current = null;
              sourceCacheRef.current.clear();
              rangeCacheRef.current.clear();
              fileRef.current = null;
              setNudges({});
              setCaptions({});
              setSpeakers([]);
              setSpeakerLinks({});
              captionActivity.current.clear();
              rangeDrafts.current.clear();
              newEpisodeId.current = undefined;
              for (const u of urlsRef.current) URL.revokeObjectURL(u);
              urlsRef.current.clear();
              setResults({});
              setFrames({});
              setCovers({});
            }}
          >
            別の素材にする
          </button>
        </div>
      )}
    </>
  );
}
