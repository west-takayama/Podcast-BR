// Point at Vite development servers for the baseline and the release.
// Uses only synthetic PCM generated in the browser. No requests reach Google.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const ports = process.argv.slice(2);
  if (!ports.length) throw new Error("Pass one or more local Vite dev server ports.");
  const key = ({ port, resolution, seconds, run }) => `${port}:${resolution}:${seconds}:${run}`;
  const prior = process.env.BENCH_RESUME ? fs.readFileSync(process.env.BENCH_RESUME, "utf8").trim() : "";
  const seen = new Set(prior ? prior.split("\n").map(line => key(JSON.parse(line))) : []);
  const sampleDir = process.env.BENCH_SAMPLE_DIR;
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const variants = ports.length === 2
      ? [{ port: ports[0], resolution: 1080 }, { port: ports[1], resolution: 1080 }, { port: ports[1], resolution: 720 }]
      : [{ port: ports[0], resolution: 1080 }];
    for (const variant of variants) {
      variant.page = await browser.newPage();
      await variant.page.goto(`http://localhost:${variant.port}/`);
    }
    const measure = async ({ page, port, resolution }, seconds, run) => {
      if (seen.has(key({ port, resolution, seconds, run }))) return;
      const capture = Boolean(sampleDir && seconds === 30 && run === 0);
      const measurement = await page.evaluate(async ({ seconds, resolution, capture }) => {
        const { detectCapability, renderClip, prepareCaptionAudio } = await import("/src/lib/video/clip.ts");
        const { clearTimings, getTimings } = await import("/src/lib/timing.ts");
        const capability = await detectCapability();
        if (!capability) throw new Error("WebCodecs unavailable");
        clearTimings();
        const rate = 32000;
        const size = rate * seconds;
        const buffer = new ArrayBuffer(44 + size * 2);
        const view = new DataView(buffer);
        function tag(offset, label) {
          [...label].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
        }
        tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE");
        tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        tag(36, "data"); view.setUint32(40, size * 2, true);
        for (let index = 0; index < size; index++) view.setInt16(44 + index * 2, Math.sin(index / rate * 1400) * 1200, true);
        const audioFile = new Blob([buffer], { type: "audio/wav" });
        const start = performance.now();
        const prepared = await prepareCaptionAudio(audioFile, 0, seconds);
        const afterPreparation = performance.now();
        const blob = await renderClip({
          audioFile, resolution, startSec: 0, endSec: seconds, hook: "録音", showName: "BRIDGE RADIO",
          accent: "#fac421", capability,
          captionCues: [{ atSec: 0.1, endSec: 1.5, text: "テスト", speaker: "A", emphasis: [], speakerColor: "#ffffff" }],
        });
        const exportMs = Math.round(performance.now() - afterPreparation);
        return { format: blob.type, preparationMs: Math.round(afterPreparation - start),
          exportMs, wavBytes: prepared.wav.byteLength, videoBytes: blob.size,
          sample: capture ? Array.from(new Uint8Array(await blob.arrayBuffer())) : undefined,
          stages: Object.fromEntries(getTimings().map(({ stage, durationMs }) => [stage, durationMs])) };
      }, { seconds, resolution, capture });
      const { sample, ...metrics } = measurement;
      if (sample) fs.writeFileSync(path.join(sampleDir, `${port}-${resolution}.${metrics.format.split("/")[1]}`), Buffer.from(sample));
      if (run >= 0) console.log(JSON.stringify({ port, resolution, seconds, run, ...metrics }));
    };
    for (const variant of variants) await measure(variant, 2, -1);
    for (const seconds of [20, 30, 40]) {
      for (let run = 0; run < 5; run++) {
        for (let index = 0; index < variants.length; index++) {
          await measure(variants[(run + index) % variants.length], seconds, run);
        }
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
