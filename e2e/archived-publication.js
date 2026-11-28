const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { scores } = require("./select-episode");

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-final-"));
  const footage = join(dir, "original.webm");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=12", "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-c:v", "libvpx", "-c:a", "libopus", footage]);
  const origin = "http://localhost:" + (process.argv[2] || 4218);
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const remote = [];
    await page.route("**/*", route => {
      if (route.request().url().startsWith(origin)) return route.continue();
      remote.push(route.request().url());
      return route.abort();
    });
    await page.goto(origin);
    const audio = readFileSync("speechlike.wav").toString("base64");
    await page.evaluate(async ({ audio, scores }) => {
      const db = await new Promise(resolve => { const req = indexedDB.open("podcast-br", 3); req.onsuccess = () => resolve(req.result); });
      const tx = db.transaction("episodes", "readwrite");
      for (const [id, title] of [["old-audio", "過去の音声回"], ["old-video", "過去の動画回"]]) {
        const record = { id, createdAt: Date.now(), durationSec: 8, removedSec: 0, originalAudio: true, chosenTitle: title,
          fileName: id === "old-audio" ? "audio.wav" : "original.webm",
          meta: { titles: [title], description: "合成のみ", showNotes: "", transcriptSummary: "", keywords: [], chapters: [], hashtags: [], clips: [
            { start: "00:00", end: "00:05", hook: "合成ショート", why: "既刊検証", scores },
          ] } };
        if (id === "old-audio") record.audio = new Blob([Uint8Array.from(atob(audio), char => char.charCodeAt(0))], { type: "audio/wav" });
        tx.objectStore("episodes").put(record);
      }
      await new Promise(resolve => { tx.oncomplete = resolve; });
      db.close();
    }, { audio, scores });
    await page.reload();
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    for (const [title, first, id] of [["過去の音声回", true, "AudioFake01"], ["過去の動画回", false, "VideoFake01"]]) {
      await page.locator(".history-main").filter({ hasText: title }).click();
      if (!first) await page.getByLabel("この回の素材を選択").setInputFiles(footage);
      await page.getByRole("button", { name: "この回を動画化に選抜する" }).click({ timeout: 10000 }).catch(async error => { console.error(title, await page.locator("#root").innerText()); throw error; });
      await page.getByText("すでに公開したYouTube本編に紐づける", { exact: true }).click();
      await page.getByLabel("公開済み本編のタイトル").fill(title);
      await page.getByLabel("公開済み本編の回番号").fill(first ? "41" : "42");
      await page.getByLabel("確認した公開日時（日本時間）").fill("2026-01-02T19:00");
      await page.getByLabel("この回のYouTube本編が公開されていることを確認した").check();
      const videoId = page.getByLabel("YouTube本編のIDまたは視聴URL");
      const save = page.getByRole("button", { name: "公開済み本編を紐づける" });
      if (!first) {
        await videoId.fill("AudioFake01");
        await save.click();
        await page.getByText(/別の回に登録済み/).waitFor();
      }
      await videoId.fill(id);
      await save.click();
      await page.getByRole("link", { name: "紐づけ済みの公開本編" }).waitFor();
      await page.getByRole("checkbox", { name: /字幕を入れる/ }).uncheck();
      await page.getByRole("button", { name: "推奨ショート動画をまとめて生成" }).click();
      await page.locator(".clip-result h3").getByText("合成ショート", { exact: true }).waitFor({ timeout: 90000 });
      await page.locator(".clip-result").getByText("投稿文・ハッシュタグ").click();
      assert.match(await page.locator(".clip-result textarea").inputValue(), new RegExp(title));
      await page.locator(".history-main").filter({ hasText: title }).click();
    }
    assert.deepEqual(remote, []);
    console.log("OK past audio and reselected video, existing public parent, duplicate ID rejected, two short exports with zero network");
  } finally { await browser.close(); rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
