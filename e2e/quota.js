// 無料枠の1分あたりの上限(429)に当たったとき、待たされ損にならないか。
//
//  A) 枠はモデルごと。空いている別のモデルがあればそちらで完了する
//  B) どのモデルも上限 → 向こうが言う秒数を数えながら待ち、自動で通る
//  C) 1日の上限は待たない(待っても戻らないので待たせてはいけない)
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";

const TOPICS = {
  patterns: ["自炊の話が多い"], gaps: ["旅がない"],
  ideas: [{ title: "上限を越えて出たお題", why: "w", angles: ["a"], hook: "h", related: [] }],
};
const META = {
  titles: ["下ごしらえの回"], description: "説明", showNotes: "-",
  chapters: [{ time: "00:00", label: "オープニング" }],
  hashtags: ["#t"], transcriptSummary: "要約", keywords: ["k"],
};
const MODELS = {
  models: [
    { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] },
  ],
};
const perMinute = (retryDelay) => JSON.stringify({
  error: {
    code: 429, status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for quota metric 'Generate Content API requests per minute'",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
    ],
  },
});
const perDay = JSON.stringify({
  error: { code: 429, status: "RESOURCE_EXHAUSTED",
    message: "You exceeded your quota: GenerateRequestsPerDayPerProjectPerModel" },
});

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const fails = [];

  // mode: "only-first"(既定モデルだけ上限) / "all"(全部・N回目で解ける) / "daily"
  const open = async (mode, freeAfter = 99) => {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
    const state = { topicCalls: 0, models: [] };
    await page.route("**/generativelanguage.googleapis.com/**", (r) => {
      const u = r.request().url();
      const post = r.request().postData() || "";
      if (u.includes("/v1beta/models?"))
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
      if (u.includes("/upload/v1beta/files"))
        return r.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ file: { name: "files/m", uri: "https://mock/f", state: "ACTIVE" } }) });
      if (u.includes(":generateContent")) {
        const id = /models\/([^:]+):/.exec(u)?.[1] || "?";
        const isTopics = post.includes("構成作家") || post.includes("次に話すお題");
        if (!isTopics)
          return r.fulfill({ status: 200, contentType: "application/json",
            body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(META) }] } }] }) });
        state.topicCalls++;
        state.models.push(id);
        if (mode === "daily")
          return r.fulfill({ status: 429, contentType: "application/json", body: perDay });
        const blocked =
          mode === "all" ? state.topicCalls <= freeAfter : id === "gemini-3.5-flash";
        if (blocked)
          return r.fulfill({ status: 429, contentType: "application/json", body: perMinute("6s") });
        return r.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(TOPICS) }] } }] }) });
      }
      return r.fulfill({ status: 404, body: "no" });
    });
    await page.goto(`http://localhost:${PORT}/`);
    if (await page.locator("input[type=password]").count()) {
      await page.fill("input[type=password]", "AIzaMOCK");
      await page.waitForTimeout(1200);
      await page.click("button:has-text('保存して閉じる')");
    }
    // 履歴を1件作る(お題は履歴が要る)
    await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
    await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
    await page.locator("nav button, .tabs button").filter({ hasText: "次の回" }).first().click();
    await page.waitForTimeout(700);
    return { page, state };
  };

  const ask = async (page) => {
    const seen = [];
    const watch = setInterval(async () => {
      const t = await page.locator(".card p").allInnerTexts().catch(() => []);
      const line = t.find((x) => x.includes("秒待って"));
      if (line && !seen.includes(line.trim())) seen.push(line.trim());
    }, 400);
    const t0 = Date.now();
    await page.click("button:has-text('お題を考えてもらう')");
    await page.waitForSelector(".idea, .error", { timeout: 180000 });
    clearInterval(watch);
    return { sec: (Date.now() - t0) / 1000, seen };
  };

  console.log("=== A) 既定のモデルだけ上限 ===");
  {
    const { page, state } = await open("only-first");
    const { sec } = await ask(page);
    const err = (await page.locator(".error").count()) ? await page.textContent(".error") : "";
    console.log("  呼んだモデル:", state.models.join(" → "));
    console.log("  かかった時間:", sec.toFixed(0), "秒");
    if (err) { console.log("  エラー:", err.replace(/\s+/g, " ").slice(0, 100)); fails.push("A: 別のモデルで通らなかった"); }
    else console.log("  出たお題:", await page.locator(".idea-title").first().innerText());
    if (sec > 5) fails.push(`A: 待たなくていい場面で待っている(${sec.toFixed(0)}秒)`);
    await page.close();
  }

  console.log("\n=== B) どのモデルも上限。向こうは6秒後と言っている ===");
  {
    // 実際に起きる筋道: 既定が上限 → 別のモデルも上限 → 待つ → 3回目で通る
    const { page, state } = await open("all", 2);
    const { sec, seen } = await ask(page);
    const err = (await page.locator(".error").count()) ? await page.textContent(".error") : "";
    console.log("  呼んだ回数:", state.topicCalls, "/ かかった時間:", sec.toFixed(0), "秒");
    console.log("  出した案内:", seen.slice(0, 3).join(" | ") || "(なし)");
    if (err) { console.log("  エラー:", err.replace(/\s+/g, " ").slice(0, 120)); fails.push("B: 待っても通らなかった"); }
    else console.log("  出たお題:", await page.locator(".idea-title").first().innerText());
    if (seen.length === 0) fails.push("B: 残り秒数を出していない(固まったように見える)");
    if (state.topicCalls !== 3)
      fails.push(`B: 投げ直しの回数が想定と違う(${state.topicCalls}回)`);
    // 6秒と言われて待つ。60秒も待たない
    if (sec > 20) fails.push(`B: 言われた秒数より待ちすぎ(${sec.toFixed(0)}秒)`);
    await page.close();
  }

  console.log("\n=== C) 1日の上限は待たない ===");
  {
    const { page, state } = await open("daily");
    const { sec } = await ask(page);
    const err = (await page.locator(".error").count()) ? await page.textContent(".error") : "";
    console.log("  呼んだ回数:", state.topicCalls, "/ かかった時間:", sec.toFixed(0), "秒");
    console.log("  表示:", err.replace(/\s+/g, " ").slice(0, 120));
    if (!err) fails.push("C: 通ってしまった");
    if (sec > 5) fails.push(`C: 戻らない枠なのに待っている(${sec.toFixed(0)}秒)`);
    if (!err.includes("1日")) fails.push("C: 1日の上限だと伝えていない");
    if (err.includes("1分ほど待って")) fails.push("C: 待てば戻ると誤解させている");
    if (state.topicCalls > 1) fails.push(`C: 無駄に投げ直している(${state.topicCalls}回)`);
    await page.screenshot({ path: "quota.png", fullPage: false });
    await page.close();
  }

  await browser.close();
  console.log(fails.length ? "\nFAIL:\n- " + fails.join("\n- ") : "\nOK: 上限の扱いを確認");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
