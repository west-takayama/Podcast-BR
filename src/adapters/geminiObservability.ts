import { recordTiming } from "../lib/timing";
import { withDeadline } from "../lib/deadline";
import { beginRequest, BudgetError, type RequestResult } from "../modules/budget/ledger";
import { tokens, type UsageCounts } from "../modules/budget/pricing";
import { cacheRequest, dropUnsentRequest, markValidationFailure, readBudget, reserveRequest, settleRequest } from "../modules/budget/store";

export type GeminiPurpose = "analysis" | "spotify" | "captions" | "metadata" | "transcript" | "topics" | "analytics" | "models" | "upload" | "activation";
export type GeminiUsage = UsageCounts & {
  purpose: GeminiPurpose;
  model?: string;
  source: "network" | "cache";
  audioBytes?: number;
};

type RequestUsage = {
  purpose: GeminiPurpose;
  model?: string;
  attempt?: number;
  audioBytes?: number;
  hasAudio?: boolean;
  usesTools?: boolean;
  episodeId?: string;
  operationId?: string;
};
const cleanModel = (model?: string) => model === undefined ? undefined : (/^gemini-\d[\w.-]{0,63}$/.test(model) ? model : "other");
const cleanEpisode = (id?: string) => id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : undefined;

function usageCounts(value: unknown): UsageCounts {
  if (!value || typeof value !== "object") return {};
  const usage = value as Record<string, unknown>;
  const audioCount = (details: unknown) => {
    if (!Array.isArray(details)) return undefined;
    const audio = (details as { modality?: string; tokenCount?: number }[])
      .filter(part => part?.modality === "AUDIO").map(part => tokens(part.tokenCount));
    return audio.length && audio.every(count => count !== undefined) ? audio.reduce<number>((sum, count) => sum + (count ?? 0), 0) : undefined;
  };
  return {
    inputTokens: tokens(usage.promptTokenCount),
    outputTokens: tokens(usage.candidatesTokenCount),
    thinkingTokens: tokens(usage.thoughtsTokenCount),
    cachedTokens: tokens(usage.cachedContentTokenCount),
    audioTokens: audioCount(usage.promptTokensDetails),
    cachedAudioTokens: audioCount(usage.cacheTokensDetails),
  };
}

export async function isPaidGeminiConfigured() {
  return typeof indexedDB !== "undefined" && (await readBudget()).settings.mode !== "free";
}

export async function checkGeminiBudget(purpose: GeminiPurpose, model: string, hasAudio: boolean) {
  if (typeof indexedDB === "undefined") return;
  // The actual request still reserves capacity atomically. This avoids preparing and uploading doomed inputs.
  const state = await readBudget();
  beginRequest(state, { purpose, model: cleanModel(model), hasAudio, attempt: 1 }, "preview", Date.now());
}

const ledgerResponses = new WeakMap<Response, string>();

export async function validateGeminiResponse<T>(response: Response, parse: () => T | Promise<T>): Promise<T> {
  try {
    return await parse();
  } catch (error) {
    const ledgerId = ledgerResponses.get(response);
    if (ledgerId) await markValidationFailure(ledgerId).catch(() => {});
    throw error;
  }
}

export async function observeGeminiRequest<T extends { status: number }>(
  context: RequestUsage, send: () => Promise<T>, signal?: AbortSignal, requestKey?: string,
): Promise<T> {
  const { purpose, attempt = 1, model, audioBytes, hasAudio, usesTools, operationId } = context;
  const meta: GeminiUsage = { purpose, source: "network", model: cleanModel(model), audioBytes };
  signal?.throwIfAborted();
  let reservation: Awaited<ReturnType<typeof reserveRequest>> | undefined;
  if (typeof indexedDB !== "undefined") {
    try {
      reservation = await reserveRequest({ purpose, attempt, model: meta.model, episodeId: cleanEpisode(context.episodeId),
        hasAudio, usesTools, operationId, requestKey });
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      throw new BudgetError("予算台帳を開けません。ブラウザーのサイトデータ設定や空き容量を確認してください。");
    }
  }
  if (reservation && (signal?.aborted || Date.now() - reservation.at >= 10 * 60_000)) {
    await dropUnsentRequest(reservation.id).catch(() => {});
    signal?.throwIfAborted();
    throw new BudgetError("予算の予約時刻が経過しました。再試行してください。");
  }
  const started = performance.now();
  const emit = async (status?: number, error?: string, billing?: RequestResult["billing"]) => {
    const elapsedMs = Math.round(performance.now() - started);
    recordTiming("gemini-usage", elapsedMs, status !== undefined && status >= 200 && status < 300 && !error,
      attempt, status, undefined, error, undefined, meta);
    if (reservation) {
      const { inputTokens, outputTokens, thinkingTokens, cachedTokens, audioTokens, cachedAudioTokens } = meta;
      // If storage fails after dispatch the original reservation remains in force.
      await settleRequest(reservation.id, { inputTokens, outputTokens, thinkingTokens, cachedTokens, audioTokens, cachedAudioTokens },
        { elapsedMs, status, error, billing }).catch(() => {});
    }
  };
  try {
    const response = await send();
    let error: string | undefined;
    let billing: RequestResult["billing"];
    if (model && response instanceof Response && response.ok) {
      try {
        const result = await response.clone().json();
        const counts = usageCounts(result?.usageMetadata);
        for (const key of Object.keys(counts) as (keyof UsageCounts)[]) {
          if (counts[key] !== undefined) meta[key] = counts[key];
        }
        const reason = result?.candidates?.[0]?.finishReason;
        const block = result?.promptFeedback?.blockReason;
        const blocked = block && block !== "BLOCK_REASON_UNSPECIFIED" && !result?.candidates?.length;
        if (blocked || (reason && reason !== "STOP")) error = "ProviderStopped";
        if (reason === "SAFETY") billing = "input-only";
        else if (blocked || (reason && !["STOP", "MAX_TOKENS", "CONTINUATION"].includes(reason))) billing = "none";
      } catch { error = "UnreadableResponse"; }
    }
    signal?.throwIfAborted();
    await emit(response.status, error, billing);
    if (reservation && response instanceof Response) ledgerResponses.set(response, reservation.id);
    return response;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    await emit(undefined, name === "AbortError" || name === "TimeoutError" ? name : "NetworkError");
    throw error;
  }
}

export function recordGeminiCache(purpose: "analysis" | "spotify" | "captions", episodeId?: string) {
  recordTiming("gemini-usage", 0, true, 0, undefined, undefined, undefined, undefined, { purpose, source: "cache" });
  if (typeof indexedDB !== "undefined") void cacheRequest(purpose, cleanEpisode(episodeId)).catch(() => {});
}

async function requestFingerprint(context: RequestUsage, body: BodyInit | null | undefined) {
  if (!context.model || typeof body !== "string" || typeof indexedDB === "undefined") return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `${cleanModel(context.model)}:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("")}`;
}

export const geminiFetch = (context: RequestUsage, url: string, init?: RequestInit) =>
  withDeadline(init?.signal ?? undefined, 120_000, async signal => {
    const fingerprint = await requestFingerprint(context, init?.body);
    return observeGeminiRequest(context, () => fetch(url, { ...init, signal }), signal, fingerprint);
  });
