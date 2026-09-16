// 控えの取り回しを確かめる。
//
//  A) 控えを取ったあとに手直しし、その古い控えを戻したとき、手直しは残るか
//     (「新しいほうを残す」と書いてあるが、比べているのは作成日時なので
//      同じ回では必ず同じ値になり、判定が効いていないのではないか)
//  B) 控えに設定(番組名・背景・想定聴き手など)は入っているか
//     入っていなければ、端末を替えたとき書き直しになる
//  C) APIキーが控えに混ざっていないか(メールや Drive に載せる物なので)
const fs = require("fs");
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";

const META = {
  titles: ["元のタイトル", "別案"], description: "説明", showNotes: "- x",
  chapters: [{ time: "00:00", label: "オープニング" }],
  hashtags: ["#t"], transcriptSummary: "要約", keywords: ["k"],
};
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
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
  if (await page.locator("input[type=password]").count()) {
    await page.fill("input[type=password]", "AIzaSECRET-KEY-1234");
    await page.waitForTimeout(1200);
  }
  // 番組の設定を書き込む(手で書いた、作り直せない類いのもの)
  const nameBox = page.locator("input[type=text]").first();
  if (await nameBox.count()) await nameBox.fill("ブリッジラジオ");
  const areas = page.locator("textarea");
  if (await areas.count()) await areas.first().fill("30代2人の雑談番組。西武ライオンズの話が多い");
  await page.waitForTimeout(300);
  await page.click("button:has-text('保存して閉じる')");

  console.log("=== 1回作って、控えを取る ===");
  await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
  await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
  if (await page.locator(".error").count()) throw new Error(await page.textContent(".error"));

  await page.click("nav button:has-text('履歴')");
  await page.waitForTimeout(700);
  const dl = page.waitForEvent("download", { timeout: 20000 });
  await page.click("button:has-text('控えを書き出す')");
  const file = await dl;
  const path = "backup.json";
  await file.saveAs(path);
  const raw = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  console.log("  書き出した:", file.suggestedFilename(), `${(raw.length / 1024).toFixed(1)} KB`);

  console.log("\n=== B) 設定が控えに入っているか ===");
  const hasSettings = !!parsed.settings;
  console.log("  設定:", hasSettings ? "入っている" : "入っていない");
  console.log("  含まれる項目:", Object.keys(parsed).join(", "));
  if (!hasSettings) fails.push("B: 設定が控えに入っていない(端末を替えると書き直しになる)");
  else {
    const t = JSON.stringify(parsed.settings);
    if (!t.includes("ブリッジラジオ")) fails.push("B: 番組名が入っていない");
    if (!t.includes("西武ライオンズ")) fails.push("B: 番組の背景が入っていない");
  }

  console.log("\n=== C) APIキーが混ざっていないか ===");
  const leaked = raw.includes("AIzaSECRET-KEY-1234");
  console.log("  APIキー:", leaked ? "⚠️ 混ざっている" : "入っていない");
  if (leaked) fails.push("C: APIキーが控えに書き出されている");

  console.log("\n=== A) 控えを取ったあとの手直しは守られるか ===");
  await page.click("nav button:has-text('履歴')");
  await page.waitForTimeout(600);
  await page.locator(".history-main").first().click();
  await page.waitForTimeout(1000);
  // 採用タイトルを別案に変える(= 控えより新しい状態)
  await page.locator(".title-option").nth(1).click();
  await page.waitForTimeout(1500);
  const edited = await page.locator(".history-title").first().innerText();
  console.log("  手直し後の採用タイトル:", edited.trim());

  // 古い控えを読み込む
  await page.setInputFiles(".card:has-text('控えを取る') input[type=file]", path);
  await page.waitForTimeout(1500);
  const note = await page.locator(".card:has-text('控えを取る') p.muted").last().innerText();
  console.log("  読み込みの結果:", note.replace(/\s+/g, " ").slice(0, 80));
  await page.waitForTimeout(500);
  const afterRestore = await page.locator(".history-title").first().innerText();
  console.log("  戻したあとの採用タイトル:", afterRestore.trim());
  if (afterRestore.trim() !== edited.trim())
    fails.push(`A: 古い控えで手直しが消えた(${edited.trim()} → ${afterRestore.trim()})`);

  console.log("\n=== D) 端末を替えたとき(まっさらな状態に戻す) ===");
  const fresh = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const p2 = await fresh.newPage();
  p2.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await p2.route("**/generativelanguage.googleapis.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) }));
  await p2.goto(`http://localhost:${PORT}/`);
  await p2.waitForTimeout(800);
  // 設定画面から始まる(キーが無いので)。まず控えを戻す
  await p2.click("nav button:has-text('履歴')");
  await p2.waitForTimeout(700);
  const empty = await p2.locator("body").innerText();
  console.log("  最初の状態:", empty.includes("まだエピソードがありません") ? "空" : "空でない");
  await p2.setInputFiles("input[type=file][accept*='json']", path);
  await p2.waitForTimeout(1800);
  const note2 = await p2.locator("p.muted").filter({ hasText: "✓" }).first().innerText().catch(() => "(出ていない)");
  console.log("  読み込みの結果:", note2.replace(/\s+/g, " ").slice(0, 90));
  await p2.click("nav button:has-text('設定')");
  await p2.waitForTimeout(800);
  const name2 = await p2.locator("input[type=text]").first().inputValue().catch(() => "");
  const ctx2 = await p2.locator("textarea").first().inputValue().catch(() => "");
  const key2 = await p2.locator("input[type=password]").first().inputValue().catch(() => "");
  console.log("  戻った番組名:", name2 || "(空)");
  console.log("  戻った背景:", (ctx2 || "(空)").slice(0, 26));
  console.log("  APIキー:", key2 ? "⚠️ 入っている" : "空(この端末で入れ直す)");
  if (name2 !== "ブリッジラジオ") fails.push(`D: 番組名が戻っていない(${name2})`);
  if (!ctx2.includes("西武ライオンズ")) fails.push("D: 番組の背景が戻っていない");
  if (key2) fails.push("D: APIキーが控えから復元されている");

  await browser.close();
  console.log(fails.length ? "\nFAIL:\n- " + fails.join("\n- ") : "\nOK: 控えの取り回しを確認");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
