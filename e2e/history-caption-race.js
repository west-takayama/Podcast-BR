// Run against Vite dev so the fixture and the app use the same IndexedDB implementation.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("playwright");

const base = process.env.HISTORY_TEST_URL || "http://localhost:4251/";
const count = Number(process.env.HISTORY_TEST_ROUNDS || 20);
const audio = readFileSync(join(__dirname, "speechlike.wav")).toString("base64");
const savedFull = "保存された全文の字幕";
const oldRange = "過去の区間字幕";
const freshFull = "更新された全文の字幕";

async function verify(browser, round, underLoad) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const requests = [];
    await context.route("**/generativelanguage.googleapis.com/**", async route => {
      requests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: { error: { message: "Fixture expects no requests" } }, status: 500 });
    });
    await page.goto(base);
    await page.evaluate(async ({ audio, oldRange }) => {
      const { saveEpisode } = await import("/src/lib/history.ts");
      const { saveProductionCheckpoint } = await import("/src/core/productionSession.ts");
      const file = new File([Uint8Array.from(atob(audio), value => value.charCodeAt(0))], "synth.wav", { type: "audio/wav" });
      const clip = { start: "00:00", end: "00:05", hook: "候補", why: "テスト" };
      await saveEpisode({ id: "test-episode", sourceRevision: "raw-one", fileName: file.name, audio: file,
        durationSec: 36, removedSec: 0, originalAudio: true, createdAt: Date.now(),
        chosenTitle: "字幕の試験", meta: { titles: ["字幕の試験"], description: "合成素材", clips: [clip], hashtags: [], chapters: [], keywords: [], showNotes: "", transcriptSummary: "" } });
      await saveProductionCheckpoint("test-episode", { revision: "raw-one", shorts: {
        captions: {}, nudges: {}, speakers: [], speakerLinks: {}, videos: {}, withCaptions: true, resolution: 720,
        ranges: [["[0,5]", [{ startMs: 800, endMs: 1800, speakerId: "B", text: oldRange, emphasis: [], needsReview: false }]]],
      } });
    }, { audio, oldRange });
    const openHistory = async () => {
      await page.getByRole("button", { name: "履歴", exact: true }).click();
      await page.locator(".history-main").filter({ hasText: "字幕の試験" }).click();
    };
    const showCaptions = async expected => {
      await page.getByRole("checkbox", { name: /字幕を入れる/ }).check();
      await page.getByRole("button", { name: /先に字幕を作って確認/ }).click();
      const field = page.getByRole("textbox", { name: "字幕 1", exact: true });
      await field.waitFor();
      assert.equal(await field.inputValue(), expected);
    };
    const saveFull = (text, concurrent) => page.evaluate(async ({ text, concurrent }) => {
      const { updateEpisode, getEpisode } = await import("/src/lib/history.ts");
      const write = updateEpisode("test-episode", { transcript: [
        { time: "00:00.8", speaker: "A", text },
        { time: "00:05.8", speaker: "A", text: "続き" },
      ] });
      const edits = concurrent ? Array.from({ length: 8 }, (_, i) =>
        updateEpisode("test-episode", { cast: `出演者${i}` })) : [];
      await Promise.all([write, ...edits]);
      const saved = await getEpisode("test-episode");
      if (saved?.transcript?.[0].text !== text) throw new Error("The transcript update was overwritten");
      if (concurrent && saved.cast !== "出演者7") throw new Error("The cast update was overwritten");
    }, { text, concurrent });
    await openHistory();
    await showCaptions(oldRange);
    await saveFull(savedFull, true); // Reproduces the original read/put race even in the single-worker run.
    await page.reload();
    await openHistory();
    await showCaptions(savedFull);
    await saveFull(freshFull, underLoad); // The mounted editor must stop showing the older draft.
    await page.getByRole("textbox", { name: "字幕 1", exact: true }).waitFor({ state: "detached" });
    await showCaptions(freshFull);
    if (round === 0) {
      await page.getByRole("button", { name: /すべてのショート動画をまとめて生成/ }).click();
      await page.getByRole("heading", { name: /書き出した動画\(1本\)/ }).waitFor({timeout: 90_000});
      assert.equal(await page.locator(".clip-result a[download]").count(), 1);
      const writer = await context.newPage();
      await writer.goto(base);
      await writer.evaluate(async () => {
        const { updateEpisode } = await import("/src/lib/history.ts");
        await updateEpisode("test-episode", { transcript: [
          { time: "00:00.8", speaker: "A", text: "別タブから更新した全文" },
          { time: "00:05.8", speaker: "A", text: "続き" },
        ] });
      });
      await page.locator(".clip-result a[download]").waitFor({ state: "detached" });
      await showCaptions("別タブから更新した全文");
      await writer.close();
    }
    assert.deepEqual(requests, [], "no Gemini requests across history restore, updates and export");
  } catch (error) {
    console.error("Round", round, underLoad, (await context.pages()[0]?.locator("body").innerText()).slice(-2400));
    throw error;
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    for (let i = 0; i < count; i++) await verify(browser, i, false);
    console.log(`単独 ${count}/${count} 通過、Gemini要求0回`);
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, worker) => (async () => {
      for (let i = worker; i < count; i += 4) await verify(browser, i, true);
    })()));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    console.log(`並行4コンテキスト ${count}/${count} 通過、Gemini要求0回`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
