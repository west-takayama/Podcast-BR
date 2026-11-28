const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { chromium } = require("playwright");
const base = process.env.PODCAST_TEST_URL || "http://localhost:4276/";
const mp3 = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1"]);

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "canShare", { value: value => !!value.files?.length });
      Object.defineProperty(navigator, "share", { value: async value => { window.sharedFiles = value.files.map(file => file.name); } });
    });
    const page = await context.newPage();
    const outbound = [];
    await context.route("https://**", route => { outbound.push(route.request().url()); return route.abort(); });
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    await page.goto(base);
    const episodeId = "00000000-0000-4000-8000-000000002727";
    await page.evaluate(async id => {
      const { saveProductionSource } = await import("/src/core/productionSession.ts");
      const { createProductionAsset } = await import("/src/core/productionAsset.ts");
      const { saveEpisode, saveArtwork } = await import("/src/lib/history.ts");
      const original = createProductionAsset(new File(["synthetic source"], "source.wav", { type: "audio/wav" }));
      await saveProductionSource({ id, original }, "original");
      await saveEpisode({ id, originalAudio: true, sourceRevision: original.id, audio: original.file, createdAt: Date.now(),
        fileName: original.file.name, durationSec: 3, removedSec: 0, chosenTitle: "再利用したタイトル",
        meta: { titles: ["初期案"], description: "再利用した説明文", clips: [], hashtags: [], keywords: [], chapters: [], showNotes: "", transcriptSummary: "" } });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 640;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#475880"; ctx.fillRect(0, 0, 640, 640);
      await saveArtwork(await new Promise(resolve => canvas.toBlob(resolve, "image/png")), true);
    }, episodeId);
    await page.reload();
    assert(!requests.some(u => u.includes("/podcast/PodcastPanel")));
    let operations = 0;
    const started = performance.now();
    const click = name => { operations++; return page.getByRole("button", { name, exact: true }).click(); };
    const fill = (name, value) => { operations++; return page.getByLabel(name, { exact: true }).fill(value); };
    await click("音声");
    operations++;
    await page.getByLabel(/完成した本編（MP3・WAV）/).setInputFiles({ name: "edited.mp3", mimeType: "audio/mpeg", buffer: mp3 });
    await page.getByText("本編を取り込みました。").waitFor();
    await click("本編配信");
    await page.getByText("編集済み音源 edited.mp3").waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("input")).some(input => input.value === "再利用したタイトル"));
    assert.equal(await page.getByLabel("説明文", { exact: true }).inputValue(), "再利用した説明文");
    assert.equal(await page.getByRole("link", { name: "Spotify for Creatorsを開く" }).count(), 0);
    await fill("エピソード番号", "27");
    const future = new Date(Date.now() + 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 16);
    await fill("配信予定日時（日本時間）", future);
    await click("端末の登録済み画像を使う");
    await page.getByRole("img", { name: "エピソードのカバー画像" }).waitFor();
    await click("配信準備を保存");
    await page.getByText("端末に保存しました。").waitFor();
    await fill("承認者", "合成担当");
    operations++;
    await page.getByRole("checkbox", { name: /音源・文面・カバー・番号・配信日時を確認/ }).check();
    await click("配信パッケージを承認");
    await click("承認済み素材を引き渡す");
    await page.getByRole("heading", { name: "承認済みの配信素材" }).waitFor();
    console.log(`PODCAST MOCK: ${operations} operations from Audio tab to prepared handoff, ${Math.round(performance.now() - started)} ms, external requests ${outbound.length}, source MP3 ${mp3.length} B`);
    await click("タイトルをコピー");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "再利用したタイトル");
    await click("説明文をコピー");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "再利用した説明文");
    for (const [name, expected] of [["編集済みMP3を保存", mp3], ["カバーを保存", undefined]]) {
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name, exact: true }).click()]);
      const data = readFileSync(await download.path());
      if (expected) assert.deepEqual(data, expected);
      else assert.equal(data.subarray(1, 4).toString(), "PNG");
    }
    await click("MP3を共有");
    assert.deepEqual(await page.evaluate(() => window.sharedFiles), ["edited.mp3"]);
    await click("カバーを共有");
    assert.deepEqual(await page.evaluate(() => window.sharedFiles), ["episode-cover.png"]);
    await click("MP3とカバーをまとめて共有");
    assert.deepEqual(await page.evaluate(() => window.sharedFiles), ["edited.mp3", "episode-cover.png"]);
    const creators = page.getByRole("link", { name: "Spotify for Creatorsを開く" });
    assert.equal(await creators.getAttribute("href"), "https://creators.spotify.com/");
    assert.equal(await creators.getAttribute("rel"), "noreferrer");
    if (process.env.PODCAST_SCREENSHOT) await page.screenshot({ path: process.env.PODCAST_SCREENSHOT, fullPage: true });
    await page.reload();
    await page.getByRole("button", { name: "本編配信", exact: true }).click();
    await page.getByRole("button", { name: "引き渡し済みの素材を確認する" }).click();
    await page.getByRole("link", { name: "編集済みMP3を保存" }).waitFor();
    await page.getByLabel("確認内容", { exact: true }).fill("合成試験で結果を保留");
    await page.getByRole("checkbox", { name: "Spotifyのエピソード一覧で照合しました", exact: true }).check();
    await page.getByRole("button", { name: "照合結果を記録", exact: true }).click();
    await page.getByRole("heading", { name: "配信パッケージ · 結果不明" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "承認済み素材を引き渡す" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "配信パッケージを承認" }).count(), 0);
    assert.deepEqual(outbound, []);
    console.log("OK: private AUDIO MP3 and copy reuse, original bytes, cover, approval, reload, unknown lock, no external calls");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
