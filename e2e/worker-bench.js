// Local synthetic audio only. Run against Vite dev: node e2e/worker-bench.js 4220
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch(require('./browser-options'));
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${process.argv[2] || 4220}/`);
    const samples = [];
    const bytes = fs.readFileSync(path.join(__dirname, 'speechlike.wav')).toString('base64');
    for (let i = 0; i < 3; i++) {
      for (const purpose of ['publish', 'ai']) {
        samples.push(await page.evaluate(async ({ bytes, purpose }) => {
          const worker = new Worker('/src/lib/encoder.worker.ts?worker_file&type=module', { type: 'module' });
          const started = performance.now();
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Worker timed out')); }, 180000);
            worker.onerror = (e) => { clearTimeout(timeout); worker.terminate(); reject(new Error(e.message)); };
            worker.onmessage = ({ data }) => {
              if (data.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(data.message)); }
              if (data.type !== 'done') return;
              clearTimeout(timeout);
              resolve({ purpose, ms: Math.round(performance.now() - started), aiBytes: data.aiMp3.byteLength, publishBytes: data.mp3?.byteLength || 0, durationSec: data.durationSec });
              worker.terminate();
            };
            worker.postMessage({ file: new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], 'synthetic.wav', { type: 'audio/wav' }), purpose,
              dsp: { highPass: purpose !== 'ai', noiseReduction: true, trimSilence: false, perChannelNoise: false, levelSpeech: true }, mono: true, bitrate: 96 });
          });
        }, { bytes, purpose }));
        console.log(JSON.stringify(samples.at(-1)));
      }
    }
    for (const purpose of ['publish', 'ai']) {
      const values = samples.filter(s => s.purpose === purpose).map(s => s.ms).sort((a,b) => a-b);
      console.log(`${purpose}: n=3 median=${values[1]}ms min=${values[0]}ms max=${values[2]}ms`);
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
