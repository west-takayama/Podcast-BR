import assert from "node:assert/strict";
import { createProductionAsset } from "../src/core/productionAsset";
import { selectOriginal } from "../src/core/productionSession";
import { captionRangeKey, sourceClipRange } from "../src/modules/shorts/checkpoint";
import { observeGeminiRequest, recordGeminiCache } from "../src/adapters/geminiObservability";
import { clearTimings, getTimings } from "../src/lib/timing";

const edited = createProductionAsset(new File(["synthetic"], "finished.wav", { type: "audio/wav" }));
const file = new File(["synthetic"], "source.wav", { type: "audio/wav" });
const first = selectOriginal({ id: "production-one", edited }, file);
assert.equal(first.id, "production-one");
assert.equal(first.original?.file, file);
assert.equal(first.edited, edited);
assert.equal(selectOriginal(first, file), first);
const second = selectOriginal(first, new File(["other"], "source.wav"));
assert.notEqual(second.id, first.id);
assert.equal(second.edited, undefined);
assert.notEqual(second.original?.id, first.original?.id);

const interval = sourceClipRange({ start: "27:08", end: "27:48" }, { start: -1, end: 1 }, 3600);
assert.deepEqual(interval, { startSec: 1627, endSec: 1669 });
assert.equal(captionRangeKey(interval.startSec, interval.endSec), "[1627,1669]");

clearTimings();
const response = await observeGeminiRequest({ purpose: "captions", model: "gemini-3-flash", attempt: 2, audioBytes: 42 },
  async () => Response.json({ text: "private sentence", usageMetadata: {
    promptTokenCount: 123, candidatesTokenCount: 45, thoughtsTokenCount: 6, cachedContentTokenCount: 0,
  } }));
assert.equal((await response.json()).text, "private sentence");
await assert.rejects(observeGeminiRequest({ purpose: "analysis", model: "invalid-model-with-private-content" },
  async () => { throw new TypeError("private secret"); }));
recordGeminiCache("captions");
const [generated, failed, cached] = getTimings();
assert.equal(generated.attempt, 2);
assert.deepEqual(generated.gemini, { purpose: "captions", source: "network", model: "gemini-3-flash",
  inputTokens: 123, outputTokens: 45, thinkingTokens: 6, cachedTokens: 0, audioBytes: 42 });
assert.equal(failed.errorType, "NetworkError");
assert.equal(failed.gemini?.model, "other");
assert.equal(cached.gemini?.source, "cache");
assert.doesNotMatch(JSON.stringify(getTimings()), /private/);
console.log("OK: source and edit roles, stable episode identity, original range and safe Gemini diagnostics");
