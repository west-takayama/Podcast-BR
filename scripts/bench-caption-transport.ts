// Synthetic transport comparison. Requests never leave this process.
import assert from "node:assert/strict";
import { transcribeRange, uploadEpisodeAudio, useDirectCaptionAudio } from "../src/lib/gemini";
import { withDeadline } from "../src/lib/deadline";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reply = { candidates: [{ content: { parts: [{ text: JSON.stringify({
  segments: [{ startMs: 100, endMs: 500, speaker: "A", text: "テスト", needsReview: false }],
}) }] } }] };
let requests = 0;
let bytes = 0;
class MockUpload {
  upload = {};
  status = 200;
  responseText = JSON.stringify({ file: { name: "files/test", uri: "https://test/audio", state: "PROCESSING" } });
  onload?: () => void;
  open() {}
  setRequestHeader() {}
  send(body: ArrayBuffer) {
    requests++;
    bytes += body.byteLength;
    setTimeout(() => this.onload?.(), 55);
  }
}
Object.assign(globalThis, { XMLHttpRequest: MockUpload });
globalThis.fetch = async (url, init) => {
  requests++;
  if (!String(url).includes(":generateContent")) {
    await pause(45);
    return Response.json({ state: "ACTIVE", uri: "https://test/audio" });
  }
  bytes += Buffer.byteLength(String(init?.body));
  await pause(100);
  return Response.json(reply);
};
const options = { apiKey: "fixture", model: "test", onStatus: () => {} };

async function sample(seconds: number, direct: boolean) {
  const wav = new ArrayBuffer(44 + seconds * 32_000);
  requests = bytes = 0;
  const started = performance.now();
  const audio = direct ? { wav } : await uploadEpisodeAudio(options.apiKey, wav, options.onStatus, undefined, undefined, "audio/wav");
  const result = await transcribeRange({ ...options, audio, durationMs: seconds * 1000 });
  assert.deepEqual(result, [{ startMs: 100, endMs: 500, speakerId: "A", text: "テスト", emphasis: [], needsReview: false }]);
  assert.equal(requests, direct ? 1 : 3);
  return { ms: Math.round(performance.now() - started), requests, requestBodyBytes: bytes };
}

await sample(20, false);
await sample(20, true);
const rows = [];
for (const seconds of [20, 30, 40, 60, 90]) {
  const direct = useDirectCaptionAudio(seconds * 1000);
  const baseline = [];
  const release = [];
  for (let run = 0; run < 3; run++) {
    baseline.push(await sample(seconds, false));
    release.push(await sample(seconds, direct));
  }
  rows.push({ seconds, version: "baseline", transport: "Files", ...baseline.sort((a, b) => a.ms - b.ms)[1] });
  rows.push({ seconds, version: "2.4", transport: direct ? "inline" : "Files", ...release.sort((a, b) => a.ms - b.ms)[1] });
}
console.table(rows);

const call = () => transcribeRange({ ...options, audio: { wav: new ArrayBuffer(44) }, durationMs: 30_000 });
let attempts = 0;
globalThis.fetch = async () => {
  if (++attempts === 1) return new Response("", { status: 503 });
  return Response.json(reply);
};
await call();
assert.equal(attempts, 2);
attempts = 0;
globalThis.fetch = async () => {
  attempts++;
  return new Response('{"quota":"daily"}', { status: 429 });
};
await assert.rejects(call(), /1日あたり/);
assert.equal(attempts, 1);
globalThis.fetch = async () => {
  attempts++;
  return new Response("denied", { status: 403 });
};
await assert.rejects(call(), /認証.*403/);
assert.equal(attempts, 2);
const waitForAbort = (signal: AbortSignal) => new Promise<never>((_, reject) =>
  signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
await assert.rejects(withDeadline(undefined, 10, waitForAbort), { name: "TimeoutError" });
const abort = new AbortController();
const pending = withDeadline(abort.signal, 1000, waitForAbort);
abort.abort();
await assert.rejects(pending, { name: "AbortError" });
console.log("OK: retry, quota, access error, deadline and cancellation");
