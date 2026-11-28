const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");

const base = process.env.FEATURE_DEV_URL || "http://localhost:4292";
const audio = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "4", "-c:a", "libmp3lame", "-f", "mp3", "pipe:1"]);

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: "block" });
    const remote = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (route.request().url().startsWith(base)) return route.continue();
      remote.push(route.request().url()); return route.abort();
    });
    await page.goto(base);
    await page.getByRole("button", { name: "音声", exact: true }).click();
    await page.getByLabel(/完成した本編/).setInputFiles({ name: "edited.mp3", mimeType: "audio/mpeg", buffer: audio });
    await page.getByText("本編を取り込みました。").waitFor();
    await page.getByRole("button", { name: "YouTube本編", exact: true }).click();
    await page.getByText("動画化は未選抜").waitFor();
    assert.equal(await page.getByRole("button", { name: "YouTube本編を書き出す" }).count(), 0);
    await page.getByRole("button", { name: "この回を動画化に選抜する" }).click();
    await page.getByText("推奨できるショート 0本", { exact: false }).waitFor();
    await page.getByRole("button", { name: "動画化から除外する" }).click();
    await page.getByText("動画化は未選抜").waitFor();
    await page.getByRole("button", { name: "この回を動画化に選抜する" }).click();
    await page.getByLabel("本編タイトル", { exact: true }).fill("合成音声・選抜した回");
    await page.getByLabel("回番号", { exact: true }).fill("42");
    await page.getByLabel(/本編の配信予定/).fill("2026-12-20T18:15");
    await page.getByRole("button", { name: "YouTube本編を書き出す" }).click();
    await page.locator("video").waitFor({ timeout: 45_000 });
    const symbol = page.getByRole("button", { name: "この本編動画を承認" });
    assert.ok(await symbol.isDisabled());
    if (process.env.FEATURE_SCREENSHOT) await page.screenshot({ path: process.env.FEATURE_SCREENSHOT, fullPage: true });
    await page.getByRole("checkbox", { name: /音声・カバー・タイトルと回番号/ }).check();
    await symbol.click();
    await page.getByRole("button", { name: "承認済み本編の引き渡しを記録する" }).click();
    await page.getByRole("link", { name: "承認済み本編を保存" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "YouTube本編", exact: true }).click();
    const confirmed = page.getByRole("link", { name: "承認済み本編を保存" });
    await confirmed.waitFor();
    const awaited = page.waitForEvent("download");
    await confirmed.click();
    assert.equal((await awaited).suggestedFilename(), "BRIDGE-RADIO-42.mp4");
    await page.getByRole("button", { name: "結果不明を記録" }).click();
    await page.getByText(/要照合・ショートの引き渡し保留/).waitFor();
    await page.getByLabel("YouTube動画IDまたは視聴URL").fill("MockVideo01");
    const publish = page.getByRole("button", { name: "公開を確認しショート保留を解除" });
    assert.ok(await publish.isDisabled());
    await page.getByRole("checkbox", { name: /実際に本編が一般公開/ }).check();
    await publish.click();
    await page.getByRole("link", { name: "YouTube本編を確認" }).waitFor();
    await page.getByText("Shortsの関連動画を設定").click();
    await page.getByLabel("設定を確認したShortの動画ID").fill("MockShort01");
    await page.getByRole("button", { name: "関連動画の設定確認を記録" }).click();
    await page.getByText("MockShort01", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.deepEqual(remote, []);
    assert.deepEqual(errors, []);
    console.log("OK selected/unselected, zero shorts, edited-only MP4, approval, resume, unknown, public confirmation, related-video record, mobile, no API");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
