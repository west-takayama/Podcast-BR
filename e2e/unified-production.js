const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { chromium } = require("playwright");

const port = process.argv[2] || 4218;
const answer = data => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] });
const candidates = {
  clips: [
    { start: "00:00", end: "00:05", hook: "最初の候補", why: "理由", socialPost: "ショート用の投稿文", hashtags: ["#対話"] },
    { start: "00:05", end: "00:10", hook: "次の候補", why: "理由" },
  ],
  episodeFacts: ["会話では収録機材について話した。"],
};

(async () => {
  const temp = mkdtempSync(join(tmpdir(), "studio-video-"));
  const video = join(temp, "fixture.webm");
  const browser = await chromium.launch(require("./browser-options"));
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x280:r=15",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "11",
      "-c:v", "libvpx", "-c:a", "libopus", video]);
    for (const source of ["speechlike.wav", video]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const page = await ctx.newPage();
        const errors = [];
        const uploads = [];
        const generations = [];
        page.on("pageerror", e => errors.push(e.message));
        let releaseSpotify;
        const holdSpotify = new Promise(resolve => { releaseSpotify = resolve; });
        await ctx.route("**/generativelanguage.googleapis.com/**", async route => {
          const request = route.request();
          const url = request.url();
          if (url.includes("/models?")) return route.fulfill({ json: { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] } });
          if (url.includes("/upload/")) {
            uploads.push(request.postDataBuffer());
            return route.fulfill({ json: { file: { name: "files/mock", uri: "https://mock/audio", state: "ACTIVE" } } });
          }
          if (url.includes(":generateContent")) {
            const { parts } = request.postDataJSON().contents[0];
            generations.push(parts);
            if (parts.at(-1).text.includes("Spotify掲載用")) {
              await holdSpotify;
              return route.fulfill({ json: answer({ titles: ["Spotify確認用"], description: "収録機材についての回です。" }) });
            }
            if (parts.at(-1).text.includes("segments")) {
              return route.fulfill({ json: answer({ segments: [{ time: "00:01", speaker: "A", text: "収録機材を使います", emphasis: ["機材"] }] }) });
            }
            return route.fulfill({ json: answer(candidates) });
          }
          return route.abort();
        });
        await page.goto(`http://localhost:${port}/`);
        await page.locator("input[type=password]").fill("AIzaMOCK");
        await page.getByRole("button", { name: "保存して閉じる" }).click();
        const picker = page.locator(".production-picker input[type=file]");
        await picker.waitFor({ state: "attached" });
        assert.equal(await picker.count(), 1);
        await picker.setInputFiles(source);
        await page.getByRole("heading", { name: /ショートの候補/ }).waitFor();
        await page.getByText("文章を準備中です。ショートの編集を進められます。").waitFor();
        assert.equal(await page.getByText("ショートの背景画像（任意）").count(), source === video ? 0 : 1, "the video track should be detected");
        assert.equal(uploads.length, 1);
        assert(uploads[0].subarray(0, 80).includes(Buffer.from("ID3")) || uploads[0][0] === 0xff, "only lightweight MP3 goes to Gemini");
        await page.getByRole("button", { name: "設定", exact: true }).click();
        await page.getByRole("button", { name: "作成", exact: true }).click();
        await page.getByRole("button", { name: /次の候補/ }).click();
        await page.getByRole("button", { name: /先に字幕を作って確認/ }).click();
        const speaker = page.getByRole("textbox", { name: "話者 1" });
        await speaker.fill("たそ");
        assert.equal(await speaker.inputValue(), "たそ");
        await page.getByRole("button", { name: /候補をまとめて書き出す/ }).click();
        await page.getByRole("heading", { name: /書き出した動画\(2本\)/ }).waitFor({ timeout: 90000 });
        const videos = page.locator("video.card-preview");
        assert.equal(await videos.count(), 2);
        await page.waitForFunction(() => [...document.querySelectorAll("video.card-preview")].every(v => v.videoWidth === 1080 && v.videoHeight === 1920));
        // The source video encodes a solid blue frame. Audio-only exports use a dark background.
        const center = await videos.first().evaluate(async v => {
          await new Promise(resolve => { v.addEventListener("seeked", resolve, { once: true }); v.currentTime = 0.7; });
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          context.drawImage(v, 530, 950, 16, 16, 0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        });
        assert.equal(center[2] > 100, source === video, `the video source must be used only for video input, pixel RGBA: ${center}`);
        assert.equal(uploads.length, 3, "one source upload + one per distinct caption range");
        assert.equal(generations.filter(parts => parts.at(-1).text.includes("Spotify掲載用")).length, 1);
        const copy = generations.find(parts => parts.at(-1).text.includes("Spotify掲載用"));
        assert.equal(copy.length, 1, "Spotify uses text evidence instead of reprocessing audio");
        assert.match(copy[0].text, /収録機材について話した/);
        releaseSpotify();
        await page.getByText("Spotify確認用", { exact: true }).waitFor();
        await page.getByRole("button", { name: "履歴", exact: true }).click();
        await page.locator(".history-main").filter({ hasText: "Spotify確認用" }).waitFor();
        assert.deepEqual(errors, []);
      } finally {
        await ctx.close();
      }
    }
    console.log("OK: unified audio/video picker, shared analysis, concurrent editing, captions, dual 9:16 outputs, history");
  } finally {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
