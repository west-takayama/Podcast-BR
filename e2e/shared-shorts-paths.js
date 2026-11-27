const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { openLegacy } = require("./legacy-production");

const port = process.argv[2] || 4218;
const clips = [
  { start: "00:00", end: "00:05", hook: "冒頭の候補", why: "確認用", socialPost: "最初の投稿", hashtags: ["#冒頭"] },
  { start: "00:05", end: "00:10", hook: "二番目の候補", why: "確認用", socialPost: "二番目の投稿", hashtags: ["#二番目"] },
];
const meta = { titles: ["共有フローの回"], description: "テスト用", chapters: [], clips };
const response = data => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] });

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const uploads = [];
    const generations = [];
    await page.route("**/generativelanguage.googleapis.com/**", async route => {
      const request = route.request();
      const url = request.url();
      if (url.includes("/models?")) return route.fulfill({ json: { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] } });
      if (url.includes("/upload/")) {
        uploads.push(request.headers()["content-type"]);
        return route.fulfill({ json: { file: { name: `files/${uploads.length}`, uri: `https://mock/audio/${uploads.length}`, state: "ACTIVE" } } });
      }
      if (!url.includes(":generateContent")) return route.abort();
      const parts = request.postDataJSON().contents[0].parts;
      const prompt = parts.at(-1).text;
      const file = parts[0].file_data;
      if (file?.mime_type === "audio/wav") {
        generations.push("range");
        return route.fulfill({ json: response({ segments: [
          { startMs: 650, endMs: 1800, speaker: "A", text: "区間字幕", needsReview: false },
        ] }) });
      }
      if (prompt.startsWith("添付の音声を聴いて、縦型ショート動画")) {
        generations.push(`candidates:${file?.file_uri}`);
        return route.fulfill({ json: response({ clips }) });
      }
      if (prompt.includes('"segments"')) {
        generations.push("transcript");
        return route.fulfill({ json: response({ segments: [
          { time: "00:00.8", speaker: "A", text: "履歴の字幕その一" },
          { time: "00:05.8", speaker: "B", text: "履歴の字幕その二" },
          { time: "00:10.3", speaker: "A", text: "続きです" },
        ] }) });
      }
      generations.push("metadata");
      return route.fulfill({ json: response(meta) });
    });

    await page.goto(`http://localhost:${port}/`);
    await page.locator("input[type=password]").fill("AIzaMOCK");
    await page.getByRole("button", { name: "保存して閉じる" }).click();
    await openLegacy(page);
    await page.locator(".legacy-production .drop input").setInputFiles("speechlike.wav");

    const all = () => page.getByRole("button", { name: "すべてのショート動画をまとめて生成" });
    const verifyTopButton = async () => {
      await page.getByRole("checkbox", { name: "冒頭の候補を一括生成に含める" }).waitFor();
      await all().waitFor();
      const position = await all().evaluate(button => {
        const card = button.closest(".card");
        return {
          color: getComputedStyle(button).backgroundColor,
          aboveCandidates: button.getBoundingClientRect().bottom < card.querySelector(".title-option").getBoundingClientRect().top,
        };
      });
      assert.deepEqual(position, { color: "rgb(255, 212, 0)", aboveCandidates: true });
    };
    const checkExports = async () => {
      await page.getByRole("heading", { name: /書き出した動画\(2本\)/ }).waitFor({ timeout: 90000 });
      assert.deepEqual(await page.locator(".clip-result h3:visible").allTextContents(), ["冒頭の候補", "二番目の候補"]);
      assert.equal(await page.locator(".clip-result a[download]:visible").count(), 2);
    };

    await page.getByRole("button", { name: /先に字幕を作って確認/ }).click();
    await page.getByRole("button", { name: "Aを新しい出演者に割り当て" }).click();
    await page.getByRole("textbox", { name: "出演者 1 の名前" }).fill("たそ");
    await page.getByRole("button", { name: "字幕と音声を試聴" }).click();
    const preview = page.locator(".caption-preview audio:visible");
    await preview.evaluate(audio => { audio.currentTime = 1; });
    await page.getByLabel("表示中の字幕").getByText("たそ").waitFor();
    await verifyTopButton();
    await all().click();
    await checkExports();
    assert.deepEqual(uploads, ["audio/mpeg", "audio/wav", "audio/wav"], "legacy uses its already picked source and only sends needed ranges");
    assert.deepEqual(generations, ["metadata", "range", "range"]);

    await page.getByRole("button", { name: "履歴", exact: true }).click();
    await page.locator(".history-main").filter({ hasText: "共有フローの回" }).click();
    await all().click();
    await checkExports();
    assert.equal(uploads.length, 3, "switching from legacy to history reuses the same episode's drafts");
    assert.equal(generations.length, 3);

    await page.getByRole("button", { name: "作成", exact: true }).click();
    await openLegacy(page);
    await page.getByRole("button", { name: "書き起こしを作る" }).click();
    await page.waitForFunction(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open("podcast-br"); req.onsuccess = () => resolve(req.result); });
      const records = await new Promise(resolve => {
        const req = db.transaction("episodes").objectStore("episodes").getAll();
        req.onsuccess = () => resolve(req.result);
      });
      db.close();
      return records.some(record => record.transcript?.length >= 3);
    });
    await page.reload();
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    await page.locator(".history-main").filter({ hasText: "共有フローの回" }).click();
    await verifyTopButton();
    await page.getByRole("button", { name: /先に字幕を作って確認/ }).click();
    await page.getByRole("textbox", { name: "字幕 1", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "字幕 1", exact: true }).inputValue(), "履歴の字幕その一");
    await page.getByRole("button", { name: "Aを新しい出演者に割り当て" }).click();
    await page.getByRole("textbox", { name: "出演者 1 の名前" }).fill("主宰者");
    await all().click();
    await checkExports();
    assert.equal(uploads.length, 3, "saved audio and transcript require no new uploads");
    assert.deepEqual(generations, ["metadata", "range", "range", "transcript"], "saved transcript requires no new generation");

    // An older history can have playable media and a usable upload, but no saved candidates.
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open("podcast-br"); req.onsuccess = () => resolve(req.result); });
      const records = await new Promise(resolve => {
        const req = db.transaction("episodes").objectStore("episodes").getAll();
        req.onsuccess = () => resolve(req.result);
      });
      const tx = db.transaction("episodes", "readwrite");
      tx.objectStore("episodes").put({
        ...records[0], id: "archived-without-clips", chosenTitle: "候補のない回",
        meta: { ...records[0].meta, clips: undefined },
      });
      await new Promise(resolve => { tx.oncomplete = resolve; });
      db.close();
    });
    await page.reload();
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    await page.locator(".history-main").filter({ hasText: "候補のない回" }).click();
    await page.getByRole("button", { name: "この素材から候補を作る" }).click();
    await verifyTopButton();
    assert.equal(uploads.length, 3);
    assert.equal(generations.at(-1), "candidates:https://mock/audio/1");
    await page.waitForFunction(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open("podcast-br"); req.onsuccess = () => resolve(req.result); });
      const record = await new Promise(resolve => {
        const req = db.transaction("episodes").objectStore("episodes").get("archived-without-clips");
        req.onsuccess = () => resolve(req.result);
      });
      db.close();
      return record?.meta.clips?.length === 2;
    });
    await all().click();
    await checkExports();
    assert.equal(uploads.length, 3);
    assert.equal(generations.length, 5);
    console.log("OK: shared legacy/history batch, local source, archived captions, no redundant uploads, recovered missing clips");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
