const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { chromium } = require("playwright");
const base = "http://localhost:" + (process.argv[2] || 4218);
const jstDay = at => new Date(at + 32_400_000).toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const remote = [];
    const errors = [];
    const chunks = [];
    await page.route("**/*", route => {
      const url = route.request().url();
      if (url.includes("generativelanguage.googleapis.com") && url.endsWith(":generateContent")) {
        const payload = route.request().postData() ?? "";
        remote.push(url);
        assert.equal(route.request().headers()["x-goog-api-key"], "AIzaANALYTICS_MOCK");
        assert.ok(!payload.includes("mockPrivateEpisode7"));
        assert.ok(!payload.includes("inlineData"));
        assert.ok(!payload.includes("AIzaANALYTICS_MOCK"));
        return route.fulfill({ json: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "次週も同じ条件で測定する。" }] } }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12 } } });
      }
      if (!url.startsWith(base) && /^https?:/.test(url)) { remote.push(url); return route.abort(); }
      if (url.includes("AnalyticsPanel-")) chunks.push(url);
      return route.continue();
    });
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(base);
    assert.deepEqual(chunks, []);
    await page.getByRole("button", { name: "経営分析" }).click();
    await page.getByText("この媒体の指標は未取得です。").waitFor();
    assert.equal(chunks.length, 1);

    const yesterday = jstDay(Date.now() - 86400000);
    const csv = "platform,source,quality,metric,definition,start,end,acquiredAt,unit,value\n" +
      `instagram,metricool,measured,plays,IGEV05,${yesterday},${yesterday},${new Date().toISOString()},count,123`;
    const started = performance.now();
    await page.locator('input[accept*=".json"]').setInputFiles({ name: "sample.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.getByText("1件を登録・更新しました（入力1件）。").waitFor();
    const importMs = Math.round(performance.now() - started);
    assert.match(await page.locator(".analytics-series").innerText(), /123 · 実測/);
    await page.getByLabel("共通JSON・CSVを貼り付け").fill(csv);
    await page.getByRole("button", { name: "貼り付けたデータを取り込む" }).click();
    await page.getByText("0件を登録・更新しました（入力1件）。").waitFor();
    await page.getByText("手動で指標を登録").click();
    await page.getByLabel("数値（件・分。空欄は未取得）").fill("14");
    await page.getByLabel("エピソード・投稿ID（任意）").fill("mockPrivateEpisode7");
    await page.getByRole("button", { name: "指標を保存" }).click();
    await page.getByText("1件を登録・更新しました（入力1件）。").waitFor();
    await page.reload();
    await page.getByRole("button", { name: "経営分析" }).click();
    await page.locator(".analytics-series").nth(1).waitFor();
    assert.match(await page.locator(".analytics-series").nth(1).innerText(), /14 · 手動入力/);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, "mobile page overflows");

    for (const [button, ext] of [["Markdownを保存", ".md"], ["JSONを保存", ".json"]]) {
      const future = page.waitForEvent("download");
      await page.getByRole("button", { name: button }).click();
      const download = await future;
      assert.ok(download.suggestedFilename().endsWith(ext));
      const downloaded = await readFile(await download.path(), "utf8");
      if (ext === ".json") {
        const report = JSON.parse(downloaded);
        assert.equal(report.schema, "bridge-radio.analytics.weekly.v1");
        assert.equal(report.metrics.length, 2);
        assert.equal(report.finance.actualGeminiYen, null);
      } else assert.match(downloaded, /週次経営報告/);
    }
    if (process.env.ANALYTICS_SCREENSHOT) await page.screenshot({ path: process.env.ANALYTICS_SCREENSHOT, fullPage: true });
    assert.deepEqual(remote, []);
    console.log(`MOCK CSV ${Buffer.byteLength(csv)} bytes, file selection through confirmation ${importMs}ms, external requests ${remote.length}`);

    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.locator("input[type=password]").fill("AIzaANALYTICS_MOCK");
    await page.getByRole("button", { name: "保存して閉じる" }).click();
    await page.getByRole("button", { name: "経営分析" }).click();
    await page.getByText("Geminiで追加分析").click();
    assert.deepEqual(remote, []);
    await page.getByRole("button", { name: "集計値を送って分析する" }).click();
    await page.getByText("次週も同じ条件で測定する。").waitFor();
    assert.equal(remote.length, 1);
    await page.getByRole("button", { name: "予算", exact: true }).click();
    await page.getByText("経営分析", { exact: true }).last().waitFor();
    assert.deepEqual(errors, []);
    console.log("OK analytics lazy load, import, dedup, manual entry, persistence, mobile and exports");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
