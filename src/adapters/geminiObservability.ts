import { recordTiming } from "../lib/timing";

export type GeminiPurpose = "analysis" | "spotify" | "captions" | "metadata" | "transcript" | "topics" | "models" | "upload" | "activation";
export type GeminiUsage = {
  purpose: GeminiPurpose;
  model?: string;
  source: "network" | "cache";
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cachedTokens?: number;
  audioBytes?: number;
};

type RequestUsage = { purpose: GeminiPurpose; model?: string; attempt?: number; audioBytes?: number };
const cleanModel = (model?: string) => model && (/^gemini-\d[\w.-]{0,63}$/.test(model) ? model : "other");

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function observeGeminiRequest<T extends { status: number }>(context: RequestUsage, send: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const { purpose, attempt = 1, model, audioBytes } = context;
  const meta: GeminiUsage = { purpose, source: "network", model: cleanModel(model), audioBytes };
  const emit = (duration: number, status?: number, error?: string) =>
    recordTiming("gemini-usage", duration, status !== undefined && status >= 200 && status < 300,
      attempt, status, undefined, error, undefined, meta);
  try {
    const response = await send();
    const duration = performance.now() - started;
    if (model && response instanceof Response && response.ok) {
      // Read the fixed usage fields only; the original consumer retains validation.
      try {
        const { usageMetadata: usage } = await response.clone().json();
        meta.inputTokens = tokenCount(usage?.promptTokenCount);
        meta.outputTokens = tokenCount(usage?.candidatesTokenCount);
        meta.thinkingTokens = tokenCount(usage?.thoughtsTokenCount);
        meta.cachedTokens = tokenCount(usage?.cachedContentTokenCount);
      } catch { /* The operation's own parser reports malformed content. */ }
    }
    emit(duration, response.status);
    return response;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    emit(performance.now() - started, undefined, name === "AbortError" || name === "TimeoutError" ? name : "NetworkError");
    throw error;
  }
}

export function recordGeminiCache(purpose: "analysis" | "spotify" | "captions") {
  recordTiming("gemini-usage", 0, true, 0, undefined, undefined, undefined, undefined, { purpose, source: "cache" });
}

export const geminiFetch = (context: RequestUsage, url: string, init?: RequestInit) =>
  observeGeminiRequest(context, () => fetch(url, init));
