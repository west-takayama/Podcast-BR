const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const port = process.argv[2] || 4218;
const answer = value => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
const candidates = {
  clips: Array.from({ length: 5 }, (_, i) => ({
    start: i * 6, end: i * 6 + 5, hook: `候補${i + 1}`, why: "検証用",
    socialPost: `投稿文${i + 1}`, hashtags: [`#タグ${i + 1}`],
  })),
  episodeFacts: ["作業を確認した。"],
};

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
      window.probe = { started: 0, active: 0, maxActive: 0, failed: false, revoked: [], shared: [] };
      const Encoder = window.VideoEncoder;
      if (Encoder) {
        window.VideoEncoder = class extends Encoder {
          constructor(options) {
            super(options);
            this.ordinal = ++window.probe.started;
            window.probe.maxActive = Math.max(window.probe.maxActive, ++window.probe.active);
          }
          encode(frame, options) {
            if (this.ordinal === 2 && !window.probe.failed) {
              window.probe.failed = true;
              throw new Error("mock encoder failure");
            }
            super.encode(frame, options);
          }
          close() {
            if (this.state !== "closed") {
              super.close();
              window.probe.active--;
            }
          }
        };
      }
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.probe.revoked.push(url); revoke(url); };
      Object.defineProperty(navigator, "canShare", { value: ({ files }) => files?.length > 0 });
      Object.defineProperty(navigator, "share", { value: async ({ files }) => {
        window.probe.shared.push(files.map(file => file.name));
      } });
    });
    const uploads = [];
    const transcriptions = [];
    let clipRequests = 0;
    let inlineRequests = 0;
    let useThirtySecondCandidate = false;
    let hold;
    const blocked = new Promise(resolve => { hold = resolve; });
    let markRequestStarted;
    const requestStarted = new Promise(resolve => { markRequestStarted = resolve; });

    await page.route("**/generativelanguage.googleapis.com/**", async route => {
      const req = route.request();
      if (req.url().includes("/models?")) {
        return route.fulfill({ json: { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] } });
      }
      if (req.url().includes("/upload/")) {
        uploads.push(req.headers()["content-type"]);
        return route.fulfill({ json: { file: { name: `files/${uploads.length}`, uri: `https://mock/audio/${uploads.length}`, state: "ACTIVE" } } });
      }
      if (!req.url().includes(":generateContent")) return route.abort();
      const { parts } = req.postDataJSON().contents[0];
      const prompt = parts.at(-1).text;
      if (prompt.includes("Spotify掲載用")) return route.fulfill({ json: answer({ titles: ["確認用"], description: "検証。" }) });
      if (!prompt.includes("segments")) {
        clipRequests++;
        return route.fulfill({ json: answer(useThirtySecondCandidate ? { ...candidates, clips: [{ ...candidates.clips[0], end: 30 }] } : candidates) });
      }
      if (parts[0].inline_data) {
        inlineRequests++;
        assert.equal(req.headers()["x-goog-api-key"], "AIzaMOCK");
        assert.equal(parts[0].inline_data.mime_type, "audio/wav");
        const wav = Buffer.from(parts[0].inline_data.data, "base64");
        assert.equal(wav.toString("ascii", 0, 4), "RIFF");
        assert.equal(wav.length, 960044);
        return route.fulfill({ json: answer({ segments: [
          { startMs: 500, endMs: 1400, text: "インライン字幕", speaker: "A", needsReview: false },
        ] }) });
      }
      const id = Number(parts[0].file_data.file_uri.split("/").at(-1));
      transcriptions.push(id);
      if (id === 5 && transcriptions.filter(x => x === id).length === 1) {
        markRequestStarted();
        await blocked;
        return route.abort().catch(() => {});
      }
      return route.fulfill({ json: answer({ segments: [
        { startMs: 500, endMs: 1400, text: "これで確認します", speaker: "A", emphasis: ["確認"], needsReview: false },
      ] }) });
    });

    await page.goto(`http://localhost:${port}/`);
    await page.locator("input[type=password]").fill("AIzaMOCK");
    await page.getByRole("button", { name: "保存して閉じる" }).click();
    await page.locator(".production-picker input").setInputFiles("speechlike.wav");
    const box = i => page.getByRole("checkbox", { name: `候補${i}を一括生成に含める`, exact: true });
    const start = page.getByRole("button", { name: "選択した動画をまとめて生成" });
    const outputs = page.locator(".clip-result");
    await box(5).waitFor();
    await page.getByRole("button", { name: "全解除" }).click();
    assert(await start.isDisabled());
    assert.equal(await page.getByRole("checkbox", { name: /一括生成に含める/, checked: true }).count(), 0);
    await page.getByRole("button", { name: "全選択" }).click();
    assert.equal(await page.getByRole("checkbox", { name: /一括生成に含める/, checked: true }).count(), 5);
    await box(4).uncheck();
    await box(5).uncheck();
    await start.click();
    await page.getByText(/1本目 \/ 全3本/).waitFor();
    await page.getByText(/完了 2本 \/ 失敗 1本/).waitFor({ timeout: 90000 });
    assert.deepEqual(await outputs.locator("h3").allTextContents(), ["候補1", "候補3"]);
    const firstUrl = await outputs.first().locator("a[download]").getAttribute("href");
    await outputs.first().getByText("投稿文・ハッシュタグ", { exact: true }).click();
    await outputs.first().getByText(/投稿文1.*#タグ1/s).waitFor();
    await page.getByRole("button", { name: "失敗した動画だけ再試行" }).click();
    await page.getByText(/完了 1本 \/ 失敗 0本/).waitFor({ timeout: 90000 });
    assert.deepEqual(await outputs.locator("h3").allTextContents(), ["候補1", "候補2", "候補3"]);
    assert.equal(await outputs.first().locator("a[download]").getAttribute("href"), firstUrl);
    assert.equal(uploads.length, 4);
    assert.equal(transcriptions.length, 3, "retrying an encoder failure reuses successful captions");

    await box(4).check();
    await box(5).check();
    await start.click();
    await page.getByText(/1本目 \/ 全2本/).waitFor();
    await page.getByRole("heading", { name: /Geminiの字幕応答を待っています/ }).waitFor();
    await page.getByText(/経過 \d+秒/).waitFor();
    assert.equal(await page.getByRole("progressbar").count(), 0, "Gemini wait must not show a percentage");
    await requestStarted;
    assert.equal(transcriptions.at(-1), 5);
    assert.equal(await outputs.count(), 3, "completed files stay accessible while processing");
    assert.equal(await outputs.locator("video").count(), 0, "preview decoders release during batch rendering");
    await page.getByRole("button", { name: "生成を中断" }).click();
    await page.getByText(/生成を中断しました.*未完了 2本/).waitFor();
    hold();
    assert.equal(uploads.length, 5, "no next candidate starts after abort");
    assert.equal(await outputs.first().locator("a[download]").getAttribute("href"), firstUrl);
    await start.click();
    await page.getByText(/完了 2本 \/ 失敗 0本/).waitFor({ timeout: 90000 });
    assert.equal(await outputs.count(), 5);
    assert.equal(uploads.length, 6);
    assert.deepEqual(transcriptions, [2, 3, 4, 5, 5, 6], "resume reuses the uploaded audio and retries only interrupted work");
    assert.equal(clipRequests, 1, "full-episode analysis remains reused");

    const names = await outputs.locator("a[download]").evaluateAll(links => links.map(link => link.download));
    await outputs.first().getByRole("button", { name: "共有・保存", exact: true }).click();
    await page.getByRole("button", { name: "完成動画をまとめて共有・保存" }).click();
    const stats = await page.evaluate(() => window.probe);
    assert(stats.failed);
    assert.equal(stats.maxActive, 1, "encoders are created serially");
    assert.equal(stats.active, 0, "encoder resources close after both success and failure");
    assert.deepEqual(stats.shared, [[names[0]], names]);
    const urls = await outputs.locator("a[download]").evaluateAll(links => links.map(link => link.href));
    await page.getByRole("button", { name: "別の素材にする" }).click();
    assert.equal(await outputs.count(), 0);
    assert((await page.evaluate(() => window.probe.revoked)).filter(url => urls.includes(url)).length === 5);

    useThirtySecondCandidate = true;
    await page.locator(".production-picker input").setInputFiles("speechlike.wav");
    await page.getByRole("button", { name: "先に字幕を作って確認する" }).click();
    await page.getByRole("textbox", { name: "字幕 1", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "字幕 1", exact: true }).inputValue(), "インライン字幕");
    assert.equal(inlineRequests, 1);
    assert.equal(uploads.length, 7, "only the episode upload is needed with inline captions");
    console.log("OK: serial export, retry, cancellation, captions reused and 30-second inline transport");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
