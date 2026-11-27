/** Bound a full operation, including reading the response, and preserve user cancellation. */
export async function withDeadline<T>(
  signal: AbortSignal | undefined, milliseconds: number, run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = new DOMException("Geminiの応答がタイムアウトしました。通信を確認して再試行してください。", "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeout), milliseconds);
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
