// 初回のロードにどれだけかかるか。スマホ回線と端末の遅さを模す。
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };
(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  for (const [label, net] of [
    ["速い回線", null],
    ["4G相当(9Mbps/170ms)", { downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 170 }],
    ["遅い4G(1.6Mbps/300ms)", { downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 300 }],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.route("**/generativelanguage.googleapis.com/**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) }));
    const cdp = await ctx.newCDPSession(page);
    if (net) {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...net });
    }
    // 端末の遅さも模す(iPhone は速いが、余裕を見て 4倍遅く)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    const bytes = { total: 0, files: [] };
    page.on("response", async (res) => {
      try {
        const len = Number((await res.allHeaders())["content-length"] || 0);
        if (len && new URL(res.url()).port === PORT) {
          bytes.total += len;
          bytes.files.push(`${res.url().split("/").pop()}:${(len / 1024).toFixed(0)}KB`);
        }
      } catch {}
    });

    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    // 画面の中身が出るまで
    await page.waitForSelector("nav.tabs button", { timeout: 60000 });
    const interactive = Date.now() - t0;
    const m = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      const paint = performance.getEntriesByName("first-contentful-paint")[0];
      return {
        fcp: paint ? Math.round(paint.startTime) : null,
        domContentLoaded: Math.round(n.domContentLoadedEventEnd),
        load: Math.round(n.loadEventEnd),
      };
    });
    console.log(`${label}: 操作できるまで ${interactive}ms / 最初の描画 ${m.fcp}ms / 転送 ${(bytes.total/1024).toFixed(0)}KB`);
    if (!net) console.log("   読んだもの:", bytes.files.join(" "));
    await ctx.close();
  }
  await browser.close();
})();
