/** Local-only diagnostics. Fixed stage names and numbers; never include request/response data. */
export type TimingStage = 'upload' | 'activation' | 'generation-request' | 'retry-wait' | 'metadata-total' | 'generation-and-parsing' | 'conversion' | 'result-display';
type TimingEntry = {
  stage: TimingStage;
  durationMs: number;
  success: boolean;
  attempt?: number;
  status?: number;
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

export function recordTiming(stage: TimingStage, elapsedMs: number, success: boolean, attempt?: number, status?: number) {
  const entry: TimingEntry = {
    stage, durationMs: Math.round(elapsedMs), success,
    ...(attempt === undefined ? {} : { attempt }),
    ...(status === undefined ? {} : { status }),
  };
  entries = [...entries.slice(-59), entry];
  console.info('[AI STUDIO] stage timing', entry);
  listeners.forEach(listener => listener());
}

export async function measureStage<T>(stage: TimingStage, operation: () => Promise<T>, attempt?: number): Promise<T> {
  const started = performance.now();
  let success = false;
  let status: number | undefined;
  try {
    const result = await operation();
    status = result instanceof Response ? result.status : undefined;
    success = result instanceof Response ? result.ok : true;
    return result;
  } finally {
    recordTiming(stage, performance.now() - started, success, attempt, status);
  }
}
