// 返しきれなかったときに、項目を減らして通し直せるか。
//
//  A) 1回目が途中で切れる → 2回目は項目を減らして頼み、結果が出る
//  B) 2回目も駄目 → **1回目の理由**を伝える(2回目の事情で上書きしない)
//  C) 混雑や上限のときは、項目を減らして投げ直さない(意味がないので)
//  D) 起きた失敗が設定画面に残る
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";

const FULL = {
  titles: ["ねぎ塩だれを作りすぎた回", "余った日々"],
  description: "自作のねぎ塩だれが余って、毎食にかけ続けた話。",
  showNotes: "- 作りすぎ\n- 消費の日々",
  chapters: [{ time: "00:00", label: "オープニング" }, { time: "00:12", label: "本題" }],
  hashtags: ["#雑談"], transcriptSummary: "要約", keywords: ["ねぎ塩"],
  clips: [{ start: "00:02", end: "00:20", hook: "ここ", why: "山場" }],
};
const SLIM = {
  titles: ["項目を減らして出た回"],
  description: "減らした頼み方で返ってきた説明文です。",
  chapters: [{ time: "00:00", label: "オープニング" }],
  hashtags: ["#雑談"], keywords: ["ねぎ塩"],
};
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };

// 途中で切れた応答。**説明文にたどり着く前**に切れているので、
// 読めるところまで拾っても投稿には足りない = 頼み直しが要る場面
const TRUNCATED = JSON.stringify(FULL, null, 2).slice(
  0,
  JSON.stringify(FULL, null, 2).indexOf('"description"') - 4,
);

const busy = JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } });

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const fails = [];

  const open = async (mode) => {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
    const state = { calls: [], slimAsked: 0 };
    await page.route("**/generativelanguage.googleapis.com/**", (r) => {
      const u = r.request().url();
      const post = r.request().postData() || "";
      if (u.includes("/v1beta/models?"))
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
      if (u.includes("/upload/v1beta/files"))
        return r.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ file: { name: "files/m", uri: "https://mock/f", state: "ACTIVE" } }) });
      if (u.includes(":generateContent")) {
        // 「切り抜き候補」を頼んでいなければ、減らした頼み方
        const isSlim = !post.includes("clips(切り抜き候補)");
        state.calls.push(isSlim ? "減らした頼み方" : "通常");
        if (isSlim) state.slimAsked++;
        if (mode === "busy")
          return r.fulfill({ status: 503, contentType: "application/json", body: busy });
        if (mode === "both-fail" || !isSlim)
          return r.fulfill({ status: 200, contentType: "application/json",
            body: JSON.stringify({ candidates: [{ content: { parts: [{ text: TRUNCATED }] } }] }) });
        return r.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(SLIM) }] } }] }) });
      }
      return r.fulfill({ status: 404, body: "no" });
    });
    await page.goto(`http://localhost:${PORT}/`);
    if (await page.locator("input[type=password]").count()) {
      await page.fill("input[type=password]", "AIzaMOCK");
      await page.waitForTimeout(1200);
      await page.click("button:has-text('保存して閉じる')");
    }
    return { page, state };
  };

  const convert = async (page) => {
    await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
    await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
  };

  console.log("=== A) 1回目が途中で切れた ===");
  {
    const { page, state } = await open("slim-ok");
    await convert(page);
    console.log("  頼み方:", state.calls.join(" → "));
    if (await page.locator(".error").count()) {
      console.log("  エラー:", (await page.textContent(".error")).replace(/\s+/g, " ").slice(0, 110));
      fails.push("A: 減らして頼み直しても結果が出ていない");
    } else {
      const title = await page.locator(".title-option").first().innerText();
      console.log("  出たタイトル:", title.trim().replace(/\s+/g, " "));
      if (!title.includes("項目を減らして出た回")) fails.push("A: 減らした結果が使われていない");
    }
    if (state.slimAsked !== 1) fails.push(`A: 減らした頼み方の回数が想定と違う(${state.slimAsked})`);
    await page.close();
  }

  console.log("\n=== B) 2回目も駄目だった ===");
  {
    const { page, state } = await open("both-fail");
    await convert(page);
    const err = (await page.locator(".error").count()) ? await page.textContent(".error") : "";
    console.log("  頼み方:", state.calls.join(" → "));
    console.log("  表示:", err.replace(/\s+/g, " ").slice(0, 130));
    if (!err) fails.push("B: 通ってしまった");
    if (!/切れ|読めません|含まれていません/.test(err)) fails.push("B: 何が起きたか伝えていない");
    if (!err.includes("自動でもう一度試しました")) fails.push("B: 2回試したことを伝えていない");
    if (!err.includes("変換済みMP3")) fails.push("B: 変換が無駄でないことを伝えていない");
    if (state.slimAsked !== 1) fails.push(`B: 減らした頼み方を何度もしている(${state.slimAsked})`);
    await page.close();
  }

  console.log("\n=== C) 混雑のときは減らして投げ直さない ===");
  {
    const { page, state } = await open("busy");
    await convert(page);
    const err = (await page.locator(".error").count()) ? await page.textContent(".error") : "";
    console.log("  減らした頼み方の回数:", state.slimAsked, "(0 のはず)");
    console.log("  表示:", err.replace(/\s+/g, " ").slice(0, 90));
    if (state.slimAsked !== 0) fails.push(`C: 混雑なのに項目を減らして投げ直している(${state.slimAsked}回)`);
    if (!err.includes("混雑")) fails.push("C: 混雑だと伝えていない");

    console.log("\n=== D) 設定に記録が残るか ===");
    await page.click("nav button:has-text('設定')");
    await page.waitForTimeout(800);
    const log = page.locator("details").filter({ hasText: "うまくいかなかった記録" });
    if (!(await log.count())) {
      fails.push("D: 記録の欄が無い");
    } else {
      const head = await log.locator("summary").innerText();
      await log.locator("summary").click();
      await page.waitForTimeout(300);
      const body = await log.innerText();
      console.log("  見出し:", head.trim());
      console.log("  中身:", body.replace(/\s+/g, " ").slice(0, 120));
      if (!/記録\(([1-9]\d*)件\)/.test(head)) fails.push(`D: 件数が出ていない(${head})`);
      if (!body.includes("混雑")) fails.push("D: 種類ごとの数が出ていない");
      await log.locator("button:has-text('記録をコピー')").click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      console.log("  コピーした文字数:", copied.length);
      if (!copied.includes("混雑")) fails.push("D: コピーに種類が入っていない");
      if (!copied.includes("変換と生成")) fails.push("D: コピーに何をしていたかが入っていない");
    }
    await page.close();
  }

  await browser.close();
  console.log(fails.length ? "\nFAIL:\n- " + fails.join("\n- ") : "\nOK: 返しきれないときの粘りと記録を確認");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
