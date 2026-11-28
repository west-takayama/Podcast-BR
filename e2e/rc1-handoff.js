const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const audioUrl = process.env.RC_AUDIO_URL || "https://localhost:8444";
const studioUrl = process.env.FEATURE_DEV_URL || "http://localhost:4296";
const fixture = process.env.RC_SYNTHETIC_SOURCE;
const password = process.env.BRIDGE_RC_PASSWORD;

(async () => {
  if (!fixture || !password) throw new Error("Provide a synthetic WAV and a local preview password.");
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true,
      httpCredentials: { username: "bridge", password, origin: audioUrl }, acceptDownloads: true, serviceWorkers: "block" });
    const remote = [];
    let requests = 0;
    await context.route("**/*", async route => {
      const url = route.request().url();
      if (url.startsWith(audioUrl) || url.startsWith(studioUrl)) return route.continue();
      if (url.includes("generativelanguage.googleapis.com/")) {
        requests++;
        if (url.includes("/models?")) return route.fulfill({ json: { models: [] } });
        if (url.includes("/upload/")) return route.fulfill({ json: { file: { name: "files/synthetic", uri: "https://example.invalid/synthetic", state: "ACTIVE" } } });
        const prompt = route.request().postDataJSON().contents[0].parts.at(-1).text;
        const payload = prompt.includes("Spotify掲載用") ? { titles: ["合成・ショート0本"], description: "制作フローの検証" } :
          { clips: [], episodeFacts: ["テスト用の音声素材。"] };
        return route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] } });
      }
      remote.push(url);
      return route.abort();
    });

    const audio = await context.newPage();
    let actions = 0, scriptedInteractionMs = 0, waitMs = 0;
    async function action(run) {
      const start = performance.now();
      await run();
      scriptedInteractionMs += performance.now() - start;
      actions++;
    }
    async function wait(run) {
      const start = performance.now();
      const result = await run();
      waitMs += performance.now() - start;
      return result;
    }
    await audio.goto(audioUrl);
    await audio.locator("#render").waitFor();
    await action(() => audio.locator("#selection").selectOption("call3"));
    await action(() => audio.locator("#body").setInputFiles(fixture));
    await action(() => audio.locator("#render").click());
    const save = audio.waitForEvent("download");
    await wait(() => audio.locator("#download").waitFor({ timeout: 75_000 }));
    await action(() => audio.locator("#download").click());
    const mp3 = await wait(() => save);
    assert.match(mp3.suggestedFilename(), /\.mp3$/);
    assert.equal(requests, 0);

    const studio = await context.newPage();
    const mp3Path = await mp3.path();
    await studio.goto(studioUrl);
    await studio.evaluate(async () => import("/e2e/fixture-aac.ts"));
    await action(() => studio.getByRole("button", { name: "音声", exact: true }).click());
    await action(() => studio.getByLabel(/完成した本編/).setInputFiles({ name: "edited.mp3", mimeType: "audio/mpeg",
      buffer: require("node:fs").readFileSync(mp3Path) }));
    function tab(name) { return studio.getByRole("button", { name, exact: true }); }
    await action(() => tab("設定").click());
    await action(() => studio.locator("input[type=password]").fill("AIzaRC1_SYNTHETIC"));
    await action(() => tab("保存して閉じる").click());
    await action(() => tab("作成").click());
    await action(() => studio.locator(".production-picker input[type=file]").setInputFiles(fixture));
    await wait(() => studio.getByText("合成・ショート0本", { exact: true }).waitFor().catch(async error => { console.error(await studio.locator("main, #root").first().innerText()); throw error; }));
    assert.equal(await studio.getByRole("heading", { name: "Spotify用タイトル・概要欄" }).count(), 1);
    await action(() => tab("YouTube本編").click());
    await wait(() => studio.getByText("動画化は未選抜").filter({ visible: true }).waitFor());
    assert.equal(await tab("YouTube本編を書き出す").count(), 0);
    const before = requests;
    await action(() => tab("この回を動画化に選抜する").click());
    await wait(() => studio.getByText(/推奨できるショート 0本/).filter({ visible: true }).waitFor());
    await action(() => studio.getByLabel("回番号", { exact: true }).fill("42"));
    await action(() => studio.getByLabel(/本編の配信予定/).fill("2026-12-20T18:15"));
    await action(() => tab("YouTube本編を書き出す").click());
    await wait(() => studio.locator("video").waitFor({ timeout: 60_000 }));
    assert.equal(await studio.locator('select').filter({ has: studio.locator('option[value="360"]') }).inputValue(), "360");
    assert.equal(before, requests);
    await action(() => tab("経営分析").click());
    await wait(() => studio.getByRole("heading", { name: "経営ダッシュボード" }).waitFor());
    assert.deepEqual(remote, []);
    console.log(JSON.stringify({ actions, scriptedInteractionMs: Math.round(scriptedInteractionMs), waitMs: Math.round(waitMs), mockedGeminiRequests: requests }));
    console.log("OK protected AUDIO synthetic MP3 → original-source Gemini mock → Spotify with zero Shorts → selection → 360p local video → analytics");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
