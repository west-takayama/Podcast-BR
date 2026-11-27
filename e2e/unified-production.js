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
            uploads.push({ bytes: request.postDataBuffer(), mime: request.headers()["content-type"] });
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
              return route.fulfill({ json: answer({ segments: [
                { startMs: 700, endMs: 1200, speaker: "A", text: "収録機材を使います", emphasis: ["機材"], needsReview: false },
                { startMs: 1500, endMs: 1950, speaker: "B", text: "はい", needsReview: false },
                { startMs: 2250, endMs: 2750, speaker: "C", text: "そうですね", needsReview: false },
                { startMs: 3000, endMs: 3600, speaker: "A", text: "説明します", needsReview: false },
              ] }) });
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
        assert(uploads[0].mime === "audio/mpeg" && (uploads[0].bytes.subarray(0, 80).includes(Buffer.from("ID3")) || uploads[0].bytes[0] === 0xff), "only lightweight MP3 goes to Gemini");
        await page.getByRole("button", { name: "設定", exact: true }).click();
        await page.getByRole("button", { name: "作成", exact: true }).click();
        await page.getByRole("button", { name: /次の候補/ }).click();
        await page.getByRole("button", { name: /先に字幕を作って確認/ }).click();
        const person = number => page.getByRole("textbox", { name: `出演者 ${number} の名前` });
        const link = id => page.getByRole("combobox", { name: `話者 ${id} の割り当て` });
        const previewAtFirst = async () => {
          await page.getByRole("button", { name: "字幕と音声を試聴" }).click();
          await page.waitForFunction(() => document.querySelector(".caption-preview audio")?.readyState >= 1);
          const start = await page.getByRole("textbox", { name: "字幕 1", exact: true }).inputValue();
          assert.equal(start, "収録機材を使います");
          await page.locator(".caption-preview audio").evaluate(audio => { audio.currentTime = 0.95; });
        };
        const namesAtStart = page.getByLabel("表示中の字幕");
        const requestCount = () => uploads.length + generations.length;
        await link("A").waitFor();
        const beforeNames = requestCount();
        for (const [idx, id, name] of [[1, "A", "たそ"], [2, "B", "ゲスト"], [3, "C", "進行"]]) {
          await page.getByRole("button", { name: `${id}を新しい出演者に割り当て` }).click();
          await person(idx).fill(name);
        }
        await previewAtFirst();
        await namesAtStart.getByText("たそ", { exact: true }).waitFor();
        const speakerColor = await namesAtStart.evaluate(el => getComputedStyle(el).color);
        await page.getByText("出演者名を入れ替える", { exact: true }).click();
        await page.getByRole("combobox", { name: "入れ替える出演者 1" }).selectOption("person-1");
        await page.getByRole("combobox", { name: "入れ替える出演者 2" }).selectOption("person-2");
        await page.getByRole("button", { name: "名前を入れ替える" }).click();
        await namesAtStart.getByText("ゲスト", { exact: true }).waitFor();
        assert.equal(await namesAtStart.evaluate(el => getComputedStyle(el).color), speakerColor);
        await page.getByRole("combobox", { name: "話者 1", exact: true }).selectOption("person-3");
        await namesAtStart.getByText("進行", { exact: true }).waitFor();
        assert.equal(requestCount(), beforeNames, "episode names, swaps and individual correction stay local");
        await page.getByRole("button", { name: /最初の候補/ }).click();
        await page.getByRole("button", { name: /先に字幕を作って確認/ }).click();
        await link("A").waitFor();
        assert.equal(await link("A").inputValue(), "", "A in another clip starts unassigned");
        assert.equal(await person(2).inputValue(), "たそ", "episode names are shared");
        const beforeLink = requestCount();
        await link("A").selectOption("person-2");
        await previewAtFirst();
        await namesAtStart.getByText("たそ", { exact: true }).waitFor();
        assert.equal(requestCount(), beforeLink);
        await page.getByRole("button", { name: /すべてのショート動画をまとめて生成/ }).click();
        await page.getByRole("heading", { name: /書き出した動画\(2本\)/ }).waitFor({ timeout: 90000 });
        const videos = page.locator("video.card-preview");
        assert.equal(await videos.count(), 2);
        await videos.evaluateAll(elements => elements.forEach(video => { video.preload = "metadata"; video.load(); }));
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
        for (const [index, rgba] of [[0, [255, 188, 223]], [1, [187, 245, 162]]]) {
          const matchingPixels = await videos.nth(index).evaluate(async (video, color) => {
            await new Promise(resolve => {
              video.addEventListener("seeked", resolve, { once: true });
              video.currentTime = 0.96;
            });
            const canvas = document.createElement("canvas");
            canvas.width = 1080; canvas.height = 200;
            const context = canvas.getContext("2d");
            context.drawImage(video, 0, 1090, 1080, 200, 0, 0, 1080, 200);
            const pixels = context.getImageData(0, 0, 1080, 200).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (color.every((value, channel) => Math.abs(pixels[i + channel] - value) <= 24)) count++;
            }
            return count;
          }, rgba);
          assert(matchingPixels > 25, `export must contain the assigned speaker color for clip ${index + 1}: ${matchingPixels}`);
        }
        assert.equal(uploads.length, 3, "one source upload + one per distinct caption range");
        for (const upload of uploads.slice(1)) {
          assert.equal(upload.mime, "audio/wav");
          assert.equal(upload.bytes.toString("ascii", 0, 4), "RIFF");
          assert.equal(upload.bytes.readUInt32LE(24), 16000);
        }
        for (const parts of generations.filter(parts => parts.at(-1).text.includes("segments"))) {
          assert.equal(parts[0].file_data.mime_type, "audio/wav");
        }
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
    console.log("OK: unified audio/video picker, shared analysis, concurrent editing, captions, bulk speaker names, swap/color, per-clip linking, 9:16 outputs, history");
  } finally {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
