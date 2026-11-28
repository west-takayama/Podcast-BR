const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const port = process.argv[2] || 4218;

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests = [];
    page.on("request", request => requests.push(new URL(request.url())));
    await page.goto(`http://localhost:${port}/`);
    assert.equal(requests.some(url => /AudioPanel-/.test(url.pathname)), false);
    await page.getByRole("button", { name: "音声", exact: true }).click();
    await page.getByRole("heading", { name: "AUDIO 音声制作" }).waitFor();
    assert.ok(requests.some(url => /AudioPanel-/.test(url.pathname)));
    assert.equal(await page.getByLabel(/完成した本編/).count(), 0, "public build cannot use the private handoff");
    const address = page.getByLabel("非公開AUDIOのURL");
    await address.fill("https://audio.invalid/?token=fixture");
    await page.getByRole("button", { name: "接続先を保存" }).click();
    await page.getByText(/認証情報やクエリを含まない/).waitFor();
    assert.equal(await page.getByRole("link", { name: "認証付きAUDIOを開く" }).count(), 0);
    await address.fill("https://audio.invalid/studio/");
    await page.getByRole("button", { name: "接続先を保存" }).click();
    const link = page.getByRole("link", { name: "認証付きAUDIOを開く" });
    assert.equal(await link.getAttribute("href"), "https://audio.invalid/studio/");
    assert.match(await link.getAttribute("rel"), /noreferrer/);
    assert.equal(requests.filter(url => url.origin !== `http://localhost:${port}`).length, 0, "launcher never prefetches the destination or calls Gemini");
    console.log("OK: lazy AUDIO entry, strict URL validation, no private import or external request in public build");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
