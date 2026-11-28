const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { chromium } = require("playwright");

const url = process.env.FEATURE_DEV_URL || "http://localhost:4292";
const seconds = (process.env.FEATURE_SECONDS || "4").split(",").map(Number);
const rounds = Number(process.env.FEATURE_ROUNDS || 1);
const heights = (process.env.FEATURE_HEIGHTS || "720").split(",").map(Number);
const media = mkdtempSync(join(tmpdir(), "beta4-feature-"));
async function chromiumRss(session) {
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const rss = processInfo.reduce((sum, { id }) => {
    try { return sum + Number(readFileSync(`/proc/${id}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0); }
    catch { return sum; }
  }, 0);
  return { rss, cpuSeconds: processInfo.reduce((sum, process) => sum + process.cpuTime, 0) };
}
const execute = (program, args) => {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 2 ** 24 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

(async () => {
  for (const duration of seconds) {
    const fixture = join(media, duration + ".mp3");
    execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", String(duration),
      "-ac", "1", "-b:a", "64k", fixture]);
    for (let round = 1; round <= rounds; round++) for (const height of heights) {
      const browser = await chromium.launch(require("./browser-options"));
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: "block" });
        const external = [];
        await page.route("**/*", route => {
          if (route.request().url().startsWith(url)) return route.continue();
          external.push(route.request().url());
          return route.abort();
        });
        await page.goto(url);
        if (process.env.FEATURE_TEST_CODEC === "1") {
          await page.evaluate(async () => import("/e2e/fixture-aac.ts"));
        }
        await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "fixture"; document.body.append(input); });
        await page.locator("#fixture").setInputFiles(fixture);
        const cdp = await browser.newBrowserCDPSession();
        const before = await chromiumRss(cdp);
        let peak = before.rss;
        let cpu = before.cpuSeconds;
        const collect = setInterval(() => { void chromiumRss(cdp).then(measurement => { peak = Math.max(peak, measurement.rss); cpu = Math.max(cpu, measurement.cpuSeconds); }).catch(() => {}); }, 500);
        let result;
        try {
          result = await page.evaluate(async height => {
            const { generateLongVideo } = await import("/src/modules/video/longVideo.ts");
            const file = document.querySelector("#fixture").files[0];
            const started = performance.now();
            const output = await generateLongVideo({ file, title: "合成音声の書き出し試験", number: "42", height,
              signal: new AbortController().signal, onProgress() {} });
            window.output = output.file;
            return { ms: Math.round(performance.now() - started), bytes: output.file.size,
              duration: output.duration, nativeAac: output.nativeAac };
          }, height);
        } finally { clearInterval(collect); }
        const opened = page.waitForEvent("download");
        await page.evaluate(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(window.output); a.download = "feature.mp4"; a.click(); });
        const download = await opened;
        const path = await download.path();
        const { streams } = JSON.parse(execute("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]));
        const video = streams.find(stream => stream.codec_type === "video");
        const audio = streams.find(stream => stream.codec_type === "audio");
        assert.equal(video.height, height);
        assert.equal(video.width, height === 480 ? 854 : height * 16 / 9);
        assert.equal(video.codec_name, "h264");
        assert.equal(audio.codec_name, "aac");
        assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) < 0.12);
        assert.ok(Math.abs(duration - Number(audio.duration)) < 0.12);
        const at = Math.max(0, duration - 2);
        const inspectRms = (path, position) => {
          const sample = spawnSync("ffmpeg", ["-v", "error", "-ss", String(position), "-i", path, "-vn", "-t", "1", "-ac", "1", "-f", "s16le", "pipe:1"]);
          assert.equal(sample.status, 0);
          assert.ok(sample.stdout.length > 80_000);
          let squares = 0;
          for (let offset = 0; offset < sample.stdout.length; offset += 2) squares += sample.stdout.readInt16LE(offset) ** 2;
          return Math.sqrt(squares / (sample.stdout.length / 2));
        };
        const audioDeltaDb = [0.5, at].map(position => 20 * Math.log10(inspectRms(path, position) / inspectRms(fixture, position)));
        assert.ok(audioDeltaDb.every(delta => Math.abs(delta) < 0.5));
        if (process.env.FEATURE_STILLS) execute("ffmpeg", ["-v", "error", "-y", "-i", path, "-vf", "scale=1920:1080",
          "-frames:v", "1", join(process.env.FEATURE_STILLS, `${duration}s-${height}p.png`)]);
        assert.deepEqual(external, []);
        console.log(JSON.stringify({ round, seconds: duration, height, ...result, sourceBytes: readFileSync(fixture).length,
          audioDeltaDb: audioDeltaDb.map(value => Number(value.toFixed(2))), audioDuration: Number(audio.duration), videoDuration: Number(video.duration), rssBaselineKiB: before.rss, rssPeakKiB: peak, cpuSeconds: Math.round((cpu - before.cpuSeconds) * 100) / 100, externalRequests: external.length }));
      } finally { await browser.close(); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(media, { recursive: true, force: true }));
