// Run against the Vite dev server. Synthetic late cut with known sample positions, no Gemini.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const rate = 16000;
const cut = 47 * 60 + 12.345;
const expected = [{ startMs: 430, endMs: 830 }, { startMs: 3370, endMs: 4030 }];
const duration = 5;

function createFixture(filename) {
  const frames = Math.round((cut + duration + 1) * rate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + 2 * frames, 4);
  header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(2 * frames, 40);
  const fd = fs.openSync(filename, "w");
  try {
    fs.ftruncateSync(fd, 44 + frames * 2);
    fs.writeSync(fd, header, 0, header.length, 0);
    for (const span of expected) {
      const tone = Buffer.alloc((span.endMs - span.startMs) * rate / 500);
      for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(6000 * Math.sin(i * 2 * Math.PI * 440 / rate)), i * 2);
      fs.writeSync(fd, tone, 0, tone.length, 44 + 2 * Math.round((cut + span.startMs / 1000) * rate));
    }
  } finally { fs.closeSync(fd); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caption-media-"));
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const file = path.join(tmp, "late.wav");
    createFixture(file);
    const page = await browser.newPage();
    await page.goto(`http://localhost:${process.argv[2] || 4224}/`);
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "probe";
      input.type = "file";
      document.body.append(input);
    });
    await page.locator("#probe").setInputFiles(file);
    if (process.argv[3] === "baseline") {
      const legacy = await page.evaluate(async ({cut, duration}) => {
        const { extractRangeMp3 } = await import("/src/lib/video/clip.ts");
        const file = document.getElementById("probe").files[0];
        const values = [];
        for (let i = 0; i < 3; i++) {
          const started = performance.now();
          const mp3 = await extractRangeMp3(file, cut, cut + duration);
          values.push({ elapsedMs: Math.round(performance.now() - started), bytes: mp3.byteLength });
        }
        return values;
      }, {cut, duration});
      console.log(JSON.stringify(legacy));
      return;
    }
    const results = await page.evaluate(async ({cut, duration, rate}) => {
      const { prepareCaptionAudio, createCaptionPreview } = await import("/src/lib/video/clip.ts");
      const { detectActivity } = await import("/src/lib/video/captionAlignment.ts");
      const { encodeMp3 } = await import("/src/lib/audio/mp3.ts");
      const file = document.getElementById("probe").files[0];
      const results = [];
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        const prepared = await prepareCaptionAudio(file, cut, cut + duration);
        const elapsedMs = Math.round(performance.now() - started);
        const preview = await createCaptionPreview(file, cut, cut + duration);
        const decode = async bytes => {
          const ctx = new OfflineAudioContext(1, rate, rate);
          const audio = await ctx.decodeAudioData(bytes);
          return { durationMs: Math.round(audio.duration * 1000), spans: detectActivity([audio.getChannelData(0)], rate) };
        };
        const previewBytes = await preview.arrayBuffer();
        const oldInput = await new OfflineAudioContext(1, rate, rate).decodeAudioData(previewBytes.slice(0));
        const legacyMp3 = await encodeMp3([oldInput.getChannelData(0)], rate, 32);
        const wavBytes = prepared.wav.byteLength;
        const mp3Bytes = legacyMp3.byteLength;
        results.push({ elapsedMs, activity: prepared.activity, preview: await decode(previewBytes),
          decodedWav: await decode(prepared.wav), decodedMp3: await decode(legacyMp3), mp3Bytes, wavBytes });
      }
      return results;
    }, {cut, duration, rate});
    for (const row of results) {
      assert.deepEqual(row.activity, expected);
      assert.deepEqual(row.preview, { durationMs: 5000, spans: expected });
      assert.deepEqual(row.decodedWav, row.preview);
      assert.equal(row.decodedMp3.spans.length, expected.length);
      const shifts = row.decodedMp3.spans.map((span, i) => span.startMs - expected[i].startMs);
      assert(Math.abs(shifts[1] - shifts[0]) <= 10, "MP3 conversion should not accumulate sample drift");
    }
    const gapFile = path.join(tmp, "gap.webm");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "4", "-af", "aselect='not(between(t,1,2))',asetpts=PTS+0.45/TB", "-c:a", "libopus", gapFile]);
    await page.locator("#probe").setInputFiles(gapFile);
    const timeline = await page.evaluate(async () => {
      const { openAudio } = await import("/src/lib/audio/source.ts");
      const file = document.getElementById("probe").files[0];
      const read = async keep => {
        const reader = await openAudio(file, 1, keep);
        let frames = 0;
        await reader.read((_, n) => { frames += n; });
        return { duration: reader.durationSec, sampleRate: reader.sampleRate, frames };
      };
      return { concatenated: await read(false), preserved: await read(true) };
    });
    console.log("PTS probe", JSON.stringify(timeline));
    const seconds = result => result.frames / result.sampleRate;
    assert(seconds(timeline.preserved) - seconds(timeline.concatenated) >= 1,
      "leading and internal PTS gaps must survive whole-source conversion");
    assert(Math.abs(seconds(timeline.preserved) - timeline.preserved.duration) <= 0.03);
    console.log(JSON.stringify({ results, timeline }, null, 2));
    console.log("OK: known-position late WAV cut, preview clock, and PCM vs MP3 delay measured");
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
