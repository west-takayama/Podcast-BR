import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { transcribeRange, useDirectCaptionAudio } from "../src/lib/gemini";
import { clearTimings, getTimings } from "../src/lib/timing";
import { alignCues } from "../src/lib/video/captionAlignment";
import type { SplitCaptionDraft } from "../src/lib/captionResponse";

const cue = { startMs: 50, endMs: 500, speaker: "A", text: "検証用の発話", emphasis: ["検証"], needsReview: false };
const jitter = () => new Promise(resolve => setTimeout(resolve, 15));
const envelope = (text: string, finishReason = "STOP") => Response.json({
  candidates: [{ content: { parts: [{ thought: true, text: "private-test-thought" }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 42 },
});
const json = (value: unknown) => JSON.stringify(value);
const valid = () => envelope(json({ segments: [cue] }));
const cases = [
  { name: "object", response: valid, requests: 1, accepted: true },
  { name: "array", response: () => envelope(json([cue])), requests: 1, accepted: true },
  { name: "alias", response: () => envelope(json({ utterances: [{ ...cue, startMs: undefined, start_ms: 50 }] })), requests: 1, accepted: true },
  { name: "fenced", response: () => envelope(["```json", json({ segments: [cue] }), "```"].join("\n")), requests: 1, accepted: true },
  { name: "string-ms", response: () => envelope(json({ segments: [{ ...cue, startMs: "50" }] })), requests: 1, accepted: true },
  { name: "optional", response: () => envelope(json({ segments: [{ ...cue, emphasis: undefined, needsReview: undefined }] })), requests: 1, accepted: true },
  { name: "null-ms", response: () => envelope(json({ segments: [{ ...cue, endMs: null }] })), requests: 1, accepted: true },
  { name: "repair-once", response: (n: number) => n === 1 ? envelope('{"different":[]}') : valid(), requests: 2, accepted: true },
  { name: "missing-core", response: () => envelope(json({ segments: [cue, { ...cue, speaker: undefined }] })), requests: 2, issue: "schema" },
  { name: "wrong-unit", response: () => envelope(json({ segments: [{ ...cue, start: 0.05, startMs: undefined }] })), requests: 2, issue: "schema" },
  { name: "broken", response: () => envelope('{"segments":[' + json(cue)), requests: 2, issue: "json" },
  { name: "empty", response: () => envelope(""), requests: 2, issue: "missing" },
  { name: "empty-array", response: () => envelope('{"segments":[]}'), requests: 2, issue: "missing" },
  { name: "safety", response: () => envelope(json({ segments: [cue] }), "SAFETY"), requests: 1, issue: "safety" },
  { name: "limit-split", response: (n: number) => n === 1 ? envelope(json({ segments: [cue] }), "MAX_TOKENS") : valid(), requests: 3, accepted: true },
  { name: "quota", response: () => new Response('{"limit":"per-day"}', { status: 429 }), requests: 1, issue: "daily-quota" },
  { name: "unsupported", response: (n: number) => n === 1 ? new Response('{"message":"responseJsonSchema is not supported"}', { status: 400 }) : valid(), requests: 2, accepted: true },
] as const;

function pcm(seconds: number) {
  const bytes = new Uint8Array(44 + seconds * 32_000);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("data"), 36);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint16(34, 16, true); view.setUint32(40, bytes.length - 44, true);
  return bytes.buffer;
}
const baselinePath = process.argv[2];
const baseline = baselinePath ? (await import(pathToFileURL(baselinePath).href)).transcribeRange as typeof transcribeRange : undefined;
const original = globalThis.fetch;
try {
  for (const [version, generate] of [["old", baseline], ["2.4.1", transcribeRange]] as const) {
    if (!generate) continue;
    for (const seconds of [20, 30, 40, 60]) {
      const wav = pcm(seconds);
      const opts = { apiKey: "private-test-key", model: "gemini-3.5-flash-lite", durationMs: seconds * 1000,
        audio: useDirectCaptionAudio(seconds * 1000) ? { wav } : { uri: "https://fixture/audio", name: "fixture", expiresAt: 10, bytes: 10 },
        getWav: async () => wav, onStatus: () => {} };
      let first = 0;
      let recovered = 0;
      let incorrectlyAccepted = 0;
      const durations = [];
      for (const fixture of cases) {
        let requests = 0;
        clearTimings();
        globalThis.fetch = async (_, init) => {
          ++requests;
          if (version === "2.4.1") {
            const body = JSON.parse(String(init?.body));
            const config = body.generationConfig;
            const structured = !(fixture.name === "unsupported" && requests === 2);
            assert.equal(config.responseMimeType, structured ? "application/json" : undefined);
            assert.equal(Boolean(config.responseJsonSchema), structured);
            assert.ok(config.maxOutputTokens <= 8192);
          }
          await jitter();
          return fixture.response(requests);
        };
        let result;
        let failed = false;
        const start = performance.now();
        try { result = await generate(opts); } catch { failed = true; }
        const elapsed = Math.round(performance.now() - start);
        const expectedSuccess = "accepted" in fixture;
        if (fixture.name === "object") durations.push(elapsed);
        if (expectedSuccess) {
          const correct = fixture.name === "limit-split"
            ? result?.length === 2 && result[1].startMs === seconds * 500 + 50
            : result?.length === 1 && result[0].text === cue.text && result[0].startMs === cue.startMs &&
              result[0].endMs === (fixture.name === "null-ms" ? null : cue.endMs) && result[0].speakerId === cue.speaker;
          if (correct && requests === 1) first++;
          if (correct) recovered++;
          if (version === "2.4.1") assert.ok(correct, fixture.name);
        } else {
          if (!failed) incorrectlyAccepted++;
          if (version === "2.4.1") {
            assert.ok(failed, fixture.name);
            assert.equal(getTimings().at(-1)?.caption?.issue, fixture.issue);
          }
        }
        if (version === "2.4.1") {
          assert.equal(requests, fixture.requests, fixture.name);
          const diagnostics = json(getTimings());
          for (const privateValue of [opts.apiKey, cue.text, "fixture/audio", "private-test-thought"]) assert.ok(!diagnostics.includes(privateValue));
        }
      }
      console.log(`CAPTION_RESULT ${json({ version, seconds, first, recovered, expectedSuccess: 10, incorrectlyAccepted, expectedReject: cases.length - 10, normalMs: durations[0] })}`);
    }
  }

  const wav = pcm(40);
  const splitDrafts: SplitCaptionDraft = { parts: new Map() };
  const opts = { apiKey: "key", model: "gemini-3.5-flash", audio: { wav }, durationMs: 40_000,
    onStatus: () => {}, splitDrafts };
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) return envelope("partial", "MAX_TOKENS");
    if (requests === 3) return envelope("");
    return valid();
  };
  await assert.rejects(transcribeRange(opts), /字幕が返りません/);
  assert.equal(splitDrafts.parts.size, 1);
  const resumed = await transcribeRange(opts);
  assert.equal(requests, 4);
  assert.deepEqual(resumed.map(c => [c.startMs, c.speakerId, c.needsReview]), [[50, "1:A", true], [20050, "2:A", true]]);
  const missingEnd = { ...resumed[0], endMs: null };
  assert.equal(alignCues([missingEnd], [], 40_000, true)[0].endMs, null);
  globalThis.fetch = async () => new Response("busy", { status: 503 });
  await assert.rejects(transcribeRange({ ...opts, splitDrafts: undefined }), /503/);
  assert.equal(getTimings().at(-1)?.caption?.issue, "server");
  const controller = new AbortController();
  globalThis.fetch = async (_, init) => new Promise((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  const pending = transcribeRange({ ...opts, splitDrafts: undefined, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getTimings().at(-1)?.caption?.issue, "cancelled");
  console.log("caption-stability: OK");
} finally { globalThis.fetch = original; }
