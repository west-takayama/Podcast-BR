import assert from "node:assert/strict";
import { createProductionAsset, validateAudioOutput } from "../src/core/productionAsset";
import { parseAudioEntry } from "../src/modules/audio/entry";

const host = "https://studio.invalid";
assert.equal(parseAudioEntry("https://protected.invalid/audio/", host), "https://protected.invalid/audio/");
assert.equal(parseAudioEntry("http://127.0.0.1:4304/", host), "http://127.0.0.1:4304/");
for (const url of [
  "https://studio.invalid/audio/", "http://protected.invalid/", "https://protected.invalid/?key=fixture",
  "https://user:pass@protected.invalid/", "https://protected.invalid/#fixture", "javascript:alert(1)",
]) assert.equal(parseAudioEntry(url, host), null);
const output = new File(["synthetic"], "episode.mp3", { type: "audio/mpeg" });
assert.equal(validateAudioOutput(output), true);
assert.equal(validateAudioOutput(new File([], "empty.wav")), false);
assert.equal(validateAudioOutput(new File(["a"], "video.mp4", { type: "video/mp4" })), false);
assert.strictEqual(createProductionAsset(output).file, output);
console.log("alpha-core: OK (private entry validation and original File reuse)");
