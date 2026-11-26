/** Local-only diagnostics. Fixed stage names and numbers; never include request/response data. */
export type TimingStage = 'upload' | 'activation' | 'generation-request' | 'retry-wait' | 'metadata-total' | 'conversion' | 'result-display';
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
    console.info('[AI STUDIO] stage timing', {
      stage, durationMs: Math.round(performance.now() - started), success,
      ...(attempt === undefined ? {} : { attempt }),
      ...(status === undefined ? {} : { status }),
    });
  }
}
