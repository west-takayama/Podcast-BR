// Run against a local private-mode build with synthetic fixtures only.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const port = process.argv[2] || 4244;

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests = [];
    await page.route("**/generativelanguage.googleapis.com/**", route => {
      const request = route.request();
      requests.push(new URL(request.url()).pathname);
      if (request.url().includes("/models?")) return route.fulfill({ json: { models: [] } });
      if (request.url().includes("/upload/")) return route.fulfill({
        json: { file: { name: "files/synthetic", uri: "https://mock.invalid/synthetic", state: "ACTIVE" } },
      });
      const prompt = request.postDataJSON().contents[0].parts.at(-1).text;
      const result = prompt.includes("Spotify掲載用")
        ? { titles: ["セッションの検証"], description: "合成素材です。" }
        : { clips: [{ start: "00:00", end: "00:05", hook: "候補", why: "確認" }], episodeFacts: ["合成素材です。"] };
      return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] } });
    });
    await page.goto(`http://localhost:${port}/`);
    await page.getByRole("button", { name: "音声", exact: true }).click();
    await page.getByLabel(/完成した本編/).setInputFiles({
      name: "edited.wav", mimeType: "audio/wav", buffer: require("node:fs").readFileSync("speechlike.wav"),
    });
    await page.getByRole("button", { name: "制作画面で確認する" }).click();
    await page.getByText("編集済み本編 edited.wav", { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await page.getByRole("button", { name: "保存した制作を再開する" }).count(), 0);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.locator("input[type=password]").fill("AIzaPRIVATE_MOCK");
    await page.getByRole("button", { name: "保存して閉じる" }).click();
    await page.locator(".production-picker input[type=file]").setInputFiles("speechlike.wav");
    await page.getByText("セッションの検証", { exact: true }).waitFor();
    const stored = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("podcast-br");
      request.onerror = reject;
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["episodes", "assets"]);
        const assets = transaction.objectStore("assets").getAll();
        const episodes = transaction.objectStore("episodes").getAll();
        transaction.oncomplete = () => {
          db.close();
          resolve({ assets: assets.result.map(({ id }) => id), episodes: episodes.result.map(({ id, fileName }) => ({ id, fileName })) });
        };
      };
    }));
    assert.equal(stored.episodes.length, 1);
    const [{ id, fileName }] = stored.episodes;
    assert.equal(fileName, "speechlike.wav");
    assert(stored.assets.includes(`production:${id}:edited`));
    assert(stored.assets.includes(`production:${id}:checkpoint`));
    assert(!stored.assets.includes(`production:${id}:original`), "history owns one durable copy once complete");
    const requestCount = requests.length;
    await page.reload();
    await page.getByText("編集済み本編 edited.wav", { exact: true }).waitFor();
    await page.getByRole("button", { name: "保存した制作を再開する" }).click();
    await page.getByText("セッションの検証", { exact: true }).waitFor();
    assert.equal(requests.length, requestCount);
    console.log("OK: edited-only handoff stays local, original is selected for analysis, history owns a single copy, both roles restore");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
