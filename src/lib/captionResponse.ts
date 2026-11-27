import type { CaptionCue } from "./video/captionAlignment";

export type SplitCaptionDraft = { parts: Map<number, CaptionCue[]>; model?: string; structured?: boolean };

export const captionSchema = {
  type: "object",
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        required: ["startMs", "endMs", "speaker", "text", "emphasis", "needsReview"],
        properties: {
          startMs: { type: ["integer", "null"] },
          endMs: { type: ["integer", "null"] },
          speaker: { type: "string" },
          text: { type: "string" },
          emphasis: { type: "array", items: { type: "string" } },
          needsReview: { type: "boolean" },
        },
      },
    },
  },
};

export type CaptionIssue = "json" | "schema" | "missing" | "truncated" | "safety" | "stopped";
export type CaptionStructure = "object" | "array" | "alias" | "fenced" | "unknown";
export class CaptionResponseError extends Error {
  constructor(readonly issue: CaptionIssue) {
    super({
      json: "Geminiの字幕JSONが壊れています。再試行してください。",
      schema: "字幕の項目・時刻・話者の形式が一致しません。再試行してください。",
      missing: "字幕が返りませんでした。発話のある区間か確認してください。",
      truncated: "Geminiの字幕出力が途中で終了しました。区間を短くしてお試しください。",
      safety: "Geminiの安全フィルタで字幕の応答が停止しました。",
      stopped: "Geminiが字幕を最後まで返せませんでした。区間を確認してください。",
    }[issue]);
  }
}

export function parseCaptionResponse(
  body: string, durationMs: number,
  diagnostic: { finish?: string; structure?: CaptionStructure; inputTokens?: number; outputTokens?: number },
): CaptionCue[] {
  let envelope;
  try { envelope = JSON.parse(body); } catch { throw new CaptionResponseError("json"); }
  const candidate = envelope?.candidates?.[0];
  const reason = candidate?.finishReason;
  const blockReason = envelope?.promptFeedback?.blockReason;
  const block = blockReason === "BLOCK_REASON_UNSPECIFIED" ? undefined : blockReason;
  const safeReason = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"];
  diagnostic.finish = safeReason.includes(reason) ? reason : safeReason.includes(block) ? block :
    ["STOP", "MAX_TOKENS"].includes(reason) ? reason : block || reason ? "OTHER" : undefined;
  const usage = envelope?.usageMetadata;
  for (const [key, count] of [["inputTokens", usage?.promptTokenCount], ["outputTokens", usage?.candidatesTokenCount]] as const) {
    if (Number.isSafeInteger(count) && count >= 0) diagnostic[key] = count;
  }
  if (block || safeReason.includes(reason)) throw new CaptionResponseError("safety");
  if (reason === "MAX_TOKENS") throw new CaptionResponseError("truncated");
  if (reason && reason !== "STOP") throw new CaptionResponseError("stopped");
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) throw new CaptionResponseError("missing");
  const text = parts.filter(part => !part?.thought && typeof part?.text === "string").map(part => part.text).join("").trim();
  if (!text) throw new CaptionResponseError("missing");
  const fence = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(text);
  const payload = fence?.[1] ?? text;
  diagnostic.structure = fence ? "fenced" : payload.startsWith("[") ? "array" : payload.startsWith("{") ? "object" : "unknown";
  let parsed;
  try { parsed = JSON.parse(payload); } catch { throw new CaptionResponseError("json"); }
  let rows = parsed;
  if (!Array.isArray(parsed)) {
    if (!parsed || typeof parsed !== "object") throw new CaptionResponseError("schema");
    const keys = ["segments", "captions", "utterances"].filter(key => Object.prototype.hasOwnProperty.call(parsed, key));
    if (keys.length !== 1) throw new CaptionResponseError("schema");
    if (keys[0] !== "segments" && !fence) diagnostic.structure = "alias";
    rows = parsed[keys[0]];
  }
  if (!Array.isArray(rows)) throw new CaptionResponseError("schema");
  if (!rows.length) throw new CaptionResponseError("missing");
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new CaptionResponseError("schema");
    const read = (...aliases: string[]) => {
      const keys = aliases.filter(key => Object.prototype.hasOwnProperty.call(row, key));
      if (keys.length > 1) throw new CaptionResponseError("schema");
      return keys.length ? row[keys[0]] : undefined;
    };
    const boundary = (value: unknown) => {
      if (value === null) return null;
      const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > durationMs) {
        throw new CaptionResponseError("schema");
      }
      return number;
    };
    const startMs = boundary(read("startMs", "start_ms"));
    const endMs = boundary(read("endMs", "end_ms"));
    const speaker = read("speaker", "speakerId", "speaker_id");
    const text = read("text", "transcript");
    const emphasis = read("emphasis");
    const review = read("needsReview", "needs_review");
    if (typeof speaker !== "string" || !/^(?:[A-Z]{1,3}|不明)$/.test(speaker.trim()) ||
        typeof text !== "string" || !text.trim() || (startMs !== null && endMs !== null && startMs >= endMs) ||
        (emphasis !== undefined && (!Array.isArray(emphasis) || emphasis.some(word => typeof word !== "string"))) ||
        (review !== undefined && typeof review !== "boolean")) throw new CaptionResponseError("schema");
    return {
      startMs, endMs, speakerId: speaker.trim(), text: text.trim(),
      emphasis: [...new Set<string>((emphasis ?? []).filter((word: string) => !!word && text.includes(word)))].slice(0, 2),
      needsReview: review !== false || startMs === null || endMs === null || speaker.trim() === "不明",
    };
  });
}

/** Slice the app's own fixed PCM WAV format without decoding again. */
export function splitCaptionWav(wav: ArrayBuffer, durationMs: number) {
  const source = new DataView(wav);
  if (source.byteLength < 44 || source.getUint32(0) !== 0x52494646 || source.getUint32(36) !== 0x64617461 ||
      source.getUint16(20, true) !== 1 || source.getUint16(22, true) !== 1 ||
      source.getUint32(24, true) !== 16000 || source.getUint16(34, true) !== 16 ||
      source.getUint32(40, true) !== source.byteLength - 44 ||
      Math.abs((source.byteLength - 44) / 32 - durationMs) > 2) throw new CaptionResponseError("truncated");
  const offset = Math.floor(durationMs / 2);
  const middle = 44 + offset * 32;
  return [[44, middle], [middle, wav.byteLength]].map(([from, to], index) => {
    const result = new Uint8Array(44 + to - from);
    result.set(new Uint8Array(wav, 0, 44));
    result.set(new Uint8Array(wav, from, to - from), 44);
    const header = new DataView(result.buffer);
    header.setUint32(4, result.byteLength - 8, true);
    header.setUint32(40, result.byteLength - 44, true);
    return { wav: result.buffer, offset: index ? offset : 0, duration: index ? durationMs - offset : offset };
  });
}
