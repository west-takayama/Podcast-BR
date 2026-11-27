/** Subtitle boundaries use integer milliseconds elapsed from the first sample of the clip. */
export interface CaptionCue {
  startMs: number | null;
  endMs: number | null;
  /** Gemini identifiers are local to this clip. */
  speakerId: string;
  personOverride?: string;
  text: string;
  emphasis: string[];
  needsReview: boolean;
}

export interface SpeechSpan { startMs: number; endMs: number }
export interface DisplayCue { atSec: number; endSec: number; text: string; speaker: string; speakerColor: string; emphasis: string[] }

const WINDOW_MS = 10;
const MAX_SNAP_MS = 300;
const MIN_GAP_MS = 100;

/** A local energy gate. It provides acoustic edges, not word identities. */
export function detectActivity(planes: Float32Array[], sampleRate: number): SpeechSpan[] {
  const length = planes[0]?.length ?? 0;
  const count = Math.ceil(length * 1000 / sampleRate / WINDOW_MS);
  if (!count) return [];
  const levels = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const from = Math.round(i * WINDOW_MS * sampleRate / 1000);
    const to = Math.min(length, Math.round((i + 1) * WINDOW_MS * sampleRate / 1000));
    for (const plane of planes) {
      let square = 0;
      for (let j = from; j < to; j++) square += plane[j] * plane[j];
      levels[i] = Math.max(levels[i], Math.sqrt(square / Math.max(1, to - from)));
    }
  }
  const ordered = levels.slice().sort();
  const floor = ordered[Math.floor(count * 0.15)];
  const typicalLoud = ordered[Math.floor(count * 0.95)];
  // Continuous speech or continuous loud noise has no dependable silence reference.
  if (typicalLoud <= Math.max(0.001, floor * 2.5)) return [];
  const threshold = Math.max(0.0006, floor * 2.5, typicalLoud * 0.035);
  const runs: SpeechSpan[] = [];
  let first = -1;
  let last = -1;
  const finish = () => {
    if (first < 0 || last - first < 4) return;
    runs.push({ startMs: first * WINDOW_MS, endMs: Math.min((last + 1) * WINDOW_MS, Math.round(length * 1000 / sampleRate)) });
  };
  for (let i = 0; i < count; i++) {
    if (levels[i] < threshold) continue;
    if (last >= 0 && (i - last - 1) * WINDOW_MS >= MIN_GAP_MS) {
      finish();
      first = -1;
    }
    if (first < 0) first = i;
    last = i;
  }
  finish();
  return runs;
}

/** Keep a model boundary unless there is one nearby acoustic edge and no competing edge. */
function nearbyEdge(ms: number, edges: number[]): number | null {
  const candidates = edges.filter(edge => Math.abs(edge - ms) <= MAX_SNAP_MS);
  return candidates.length === 1 ? candidates[0] : null;
}

export function alignCues(input: CaptionCue[], activity: SpeechSpan[], durationMs: number, preserveUnknown = false): CaptionCue[] {
  const cues = input.slice().sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
  const starts = activity.map(run => run.startMs);
  const ends = activity.map(run => run.endMs);
  return cues.map((cue, i) => {
    const start = cue.startMs;
    const end = cue.endMs;
    if (preserveUnknown && (start === null || end === null)) return { ...cue, needsReview: true };
    if (start === null || start < 0 || start >= durationMs) {
      return { ...cue, startMs: null, endMs: null, needsReview: true };
    }
    const previous = cues[i - 1];
    const nextStart = cues[i + 1]?.startMs ?? durationMs;
    const before = previous?.startMs ?? -1;
    const snapStart = nearbyEdge(start, starts);
    // Do not move two adjacent/overlapping utterances to the same acoustic edge.
    const startIsAnchored = snapStart !== null && snapStart > before && snapStart < nextStart &&
      (previous?.endMs == null || previous.endMs <= snapStart || previous.endMs <= start);
    const startMs = startIsAnchored ? snapStart : start;
    if (end === null || end <= start || end > durationMs) {
      const run = activity.find(span => span.startMs <= startMs && span.endMs > startMs);
      const estimated = Math.min(run?.endMs ?? Infinity, startMs + 1200, nextStart, durationMs);
      return { ...cue, startMs, endMs: estimated > startMs ? estimated : null, needsReview: true };
    }
    const snapEnd = nearbyEdge(end, ends);
    const endIsAnchored = snapEnd !== null && snapEnd > startMs && snapEnd <= Math.max(nextStart, end);
    const endMs = endIsAnchored ? snapEnd : end;
    if (endMs <= startMs) return { ...cue, needsReview: true };
    const overlapping = (previous?.endMs ?? 0) > startMs || nextStart < endMs;
    return { ...cue, startMs, endMs, needsReview: cue.needsReview || overlapping || !startIsAnchored || !endIsAnchored };
  });
}

/** Preview and the 30 fps renderer use this same clock and overlap policy. */
export function displayCueAt<T extends { atSec: number; endSec: number }>(cues: readonly T[], timeSec: number): T | undefined {
  let active: T | undefined;
  for (const cue of cues) {
    if (cue.atSec <= timeSec && timeSec < cue.endSec && (!active || cue.atSec >= active.atSec)) active = cue;
  }
  return active;
}

export function formatCueTime(ms: number | null) {
  return ms === null ? "未確定" : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
}
