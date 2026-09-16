// 画面の長さと、消す操作の安全さを測る。
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";
const META = {
  titles: ["ねぎ塩だれを作りすぎた回", "別案"], description: "説明文です。", showNotes: "- x",
  chapters: [{ time: "00:00", label: "オープニング" }, { time: "00:12", label: "本題" }],
  hashtags: ["#雑談"], transcriptSummary: "要約", keywords: ["ねぎ塩"],
  clips: [{ start: "00:02", end: "00:20", hook: "ここが山場", why: "笑い" }],
};
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const fails = [];
  await page.route("**/generativelanguage.googleapis.com/**", (r) => {
    const u = r.request().url();
    if (u.includes("/v1beta/models?"))
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
    if (u.includes("/upload/v1beta/files"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ file: { name: "files/m", uri: "https://mock/f", state: "ACTIVE" } }) });
    if (u.includes(":generateContent"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(META) }] } }] }) });
    return r.fulfill({ status: 404, body: "no" });
  });
  await page.goto(`http://localhost:${PORT}/`);
  const h = () => page.evaluate(() => document.documentElement.scrollHeight);
  const screens = (px) => (px / 844).toFixed(1);
  console.log(`設定(初回): ${await h()}px = ${screens(await h())}画面`);
  await page.fill("input[type=password]", "AIzaMOCK");
  await page.waitForTimeout(1200);
  await page.click("button:has-text('保存して閉じる')");
  await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
  await page.waitForSelector("h2:has-text('投稿素材が完成しました')", { timeout: 300000 });
  const rh = await h();
  console.log(`結果画面: ${rh}px = ${screens(rh)}画面`);

  console.log("\n=== 履歴を1件消す ===");
  await page.click("nav button:has-text('履歴')");
  await page.waitForTimeout(800);
  const before = await page.locator(".history-head").count();
  await page.locator(".icon-btn").first().click();
  await page.waitForTimeout(400);
  const asked = await page.locator(".confirm:has-text('削除します')").count();
  const still = await page.locator(".history-head").count();
  console.log(`  🗑 を押した直後: 確認 ${asked ? "出る" : "出ない"} / 残り ${still}件(押す前 ${before}件)`);
  if (!asked) fails.push("消す前に確認していない");
  if (still !== before) fails.push("確認せずに消えた");
  const text = await page.locator(".confirm").first().innerText();
  console.log("  確認の文:", text.replace(/\s+/g, " ").slice(0, 70));
  if (!text.includes("戻せません")) fails.push("戻せないことを伝えていない");
  await page.click(".confirm button:has-text('やめる')");
  await page.waitForTimeout(300);
  console.log("  やめたあと:", await page.locator(".history-head").count(), "件");
  if ((await page.locator(".history-head").count()) !== before) fails.push("やめても消えた");
  await page.locator(".icon-btn").first().click();
  await page.waitForTimeout(300);
  await page.click(".confirm button:has-text('削除する')");
  await page.waitForTimeout(800);
  const after = await page.locator(".history-head").count();
  console.log("  削除するを押したあと:", after, "件");
  if (after !== before - 1) fails.push(`削除できていない(${after}件)`);
  await b.close();
  console.log(fails.length ? "\nFAIL:\n- " + fails.join("\n- ") : "\nOK");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
