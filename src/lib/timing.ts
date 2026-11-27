/** Local-only diagnostics. Fixed stage names and numbers; never include request/response data. */
export type TimingStage = 'upload' | 'activation' | 'generation-request' | 'retry-wait' | 'metadata-total' | 'generation-and-parsing' | 'conversion' | 'result-display' | 'caption-conversion' | 'caption-audio-decode' | 'caption-alignment' | 'video-export' | 'video-audio-decode' | 'drive-save' | 'video-audio-encode' | 'video-draw' | 'video-encode' | 'video-finalize' | 'video-blob' | 'caption-response';
export type VideoTimingProfile = {
  height: 1280 | 1920;
  video: "avc" | "vp8" | "vp9";
  audio: "aac" | "opus";
  seconds: number;
};
export type CaptionTiming = {
  model: string;
  structure: import("./captionResponse").CaptionStructure;
  finish?: string;
  issue?: string;
  inputTokens?: number;
  outputTokens?: number;
};
type TimingEntry = {
  stage: TimingStage;
  durationMs: number;
  success: boolean;
  attempt?: number;
  status?: number;
  videoProfile?: VideoTimingProfile;
  errorType?: string;
  caption?: CaptionTiming;
};

let entries: readonly TimingEntry[] = [];
const listeners = new Set<() => void>();

export const getTimings = () => entries;

export function subscribeToTimings(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearTimings() {
  entries = [];
  listeners.forEach(listener => listener());
}

export function recordTiming(stage: TimingStage, elapsedMs: number, success: boolean, attempt?: number, status?: number, videoProfile?: VideoTimingProfile, errorType?: string, caption?: CaptionTiming) {
  const entry: TimingEntry = {
    stage, durationMs: Math.round(elapsedMs), success,
    ...(attempt === undefined ? {} : { attempt }),
    ...(status === undefined ? {} : { status }),
    ...(videoProfile === undefined ? {} : { videoProfile }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(caption === undefined ? {} : { caption: { ...caption } }),
  };
  entries = [...entries.slice(-59), entry];
  console.info('[AI STUDIO] stage timing', entry);
  listeners.forEach(listener => listener());
}

export async function measureStage<T>(stage: TimingStage, operation: () => Promise<T>, attempt?: number, videoProfile?: VideoTimingProfile): Promise<T> {
  const started = performance.now();
  let success = false;
  let status: number | undefined;
  let errorType: string | undefined;
  try {
    const result = await operation();
    status = result instanceof Response ? result.status : undefined;
    success = result instanceof Response ? result.ok : true;
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    errorType = ["AbortError", "TimeoutError", "EncodingError", "NotSupportedError",
      "QuotaExceededError", "OperationError", "InvalidStateError", "TypeError"].includes(name) ? name : "Error";
    throw error;
  } finally {
    recordTiming(stage, performance.now() - started, success, attempt, status, videoProfile, errorType);
  }
}
