// Point at Vite development servers for the baseline and the release.
// Uses only synthetic PCM generated in the browser. No requests reach Google.
const { chromium } = require("playwright");

(async () => {
  const ports = process.argv.slice(2);
  if (!ports.length) throw new Error("Pass one or more local Vite dev server ports.");
  const browser = await chromium.launch(require("./browser-options"));
  try {
    for (const port of ports) {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${port}/`);
      for (const seconds of [2, 20, 30, 40, 60, 90]) {
        const measurement = await page.evaluate(async seconds => {
          const { detectCapability, renderClip, prepareCaptionAudio } = await import("/src/lib/video/clip.ts");
          const capability = await detectCapability();
          if (!capability) throw new Error("WebCodecs unavailable");
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
            audioFile, startSec: 0, endSec: seconds, hook: "録音", showName: "BRIDGE RADIO",
            accent: "#fac421", capability,
            captionCues: [{ atSec: 0.1, endSec: 1.5, text: "テスト", speaker: "A", emphasis: [], speakerColor: "#ffffff" }],
          });
          return { format: blob.type, preparationMs: Math.round(afterPreparation - start),
            exportMs: Math.round(performance.now() - afterPreparation), wavBytes: prepared.wav.byteLength, videoBytes: blob.size };
        }, seconds);
        if (seconds !== 2) console.log(JSON.stringify({ port, seconds, ...measurement }));
      }
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
