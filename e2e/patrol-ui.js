// 画面のパトロール。全部のタブを開いて、押せるものを押して、
// 例外・console.error・React の警告が出ないかを見る。
//
// 「壊れている」の多くは画面には出ず、コンソールにだけ出る。
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";

const META = {
  titles: ["巡回の回"], description: "説明", showNotes: "- x",
  chapters: [{ time: "00:00", label: "オープニング" }],
  hashtags: ["#t"], transcriptSummary: "要約", keywords: ["k"],
  clips: [{ start: "00:02", end: "00:14", hook: "ここ", why: "山場" }],
};
const TRANSCRIPT = {
  segments: [
    { time: "00:01", speaker: "A", text: "きょうはねぎ塩の話をします" },
    { time: "00:06", speaker: "B", text: "作りすぎたんですよね" },
  ],
};
const TOPICS = {
  patterns: ["自炊の話が多い"], gaps: ["旅がない"],
  ideas: [{ title: "ねぎ塩の続き", why: "やり残した", angles: ["a", "b"], hook: "また作った", related: [] }],
};
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  const seen = new Set();
  const note = (kind, text) => {
    const key = `${kind}:${text}`.slice(0, 160);
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(`${kind}: ${text.slice(0, 200)}`);
  };
  page.on("pageerror", (e) => note("例外", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") note("console.error", m.text());
    // React の「key が無い」「制御されていない入力」などはここに出る
    if (m.type() === "warning" && /React|Warning/.test(m.text())) note("警告", m.text());
  });

  // 本物の応答は部品が複数に分かれて返ることがある。巡回でもその形で返す
  const twoParts = (obj) => ({
    candidates: [{ content: { parts: [{ text: "" }, { text: JSON.stringify(obj) }] } }],
  });

  await page.route("**/generativelanguage.googleapis.com/**", (r) => {
    const u = r.request().url();
    const post = r.request().postData() || "";
    if (u.includes("/v1beta/models?"))
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
    if (u.includes("/upload/v1beta/files"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ file: { name: "files/m", uri: "https://mock/f", state: "ACTIVE" } }) });
    if (u.includes(":generateContent")) {
      const isTopics = post.includes("次に話すお題") || post.includes("構成作家");
      const isTranscript = post.includes("segments") || post.includes("書き起こ") || post.includes("字幕");
      const payload = isTopics ? TOPICS : isTranscript ? TRANSCRIPT : META;
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify(twoParts(payload)) });
    }
    return r.fulfill({ status: 404, body: "no" });
  });

  await page.goto(`http://localhost:${PORT}/`);
  if (await page.locator("input[type=password]").count()) {
    await page.fill("input[type=password]", "AIzaMOCK");
    await page.waitForTimeout(1200);
    await page.click("button:has-text('保存して閉じる')");
  }

  console.log("=== 1) 変換して結果画面まで ===");
  await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
  await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
  if (await page.locator(".error").count())
    note("結果", (await page.textContent(".error")).slice(0, 120));
  console.log("  結果画面:", (await page.locator(".card h2").count()), "個の見出し");

  console.log("\n=== 1b) 書き起こしを作る(別の呼び出し) ===");
  const mk = page.locator("button:has-text('書き起こしを作る')");
  if (!(await mk.count())) {
    note("書き起こし", "ボタンが無い");
  } else {
    await mk.click();
    await page.waitForSelector("button:has-text('本文を表示'), .error", { timeout: 60000 });
    if (await page.locator(".error").count()) {
      note("書き起こし", (await page.textContent(".error")).slice(0, 160));
    } else {
      await page.click("button:has-text('本文を表示')");
      await page.waitForTimeout(400);
      const seg = await page.locator(".transcript-seg").count();
      console.log("  発言:", seg, "件 /", await page.locator(".transcript-seg").first().innerText()
        .then((t) => t.replace(/\s+/g, " ").slice(0, 30)));
      if (seg !== TRANSCRIPT.segments.length) note("書き起こし", `件数が合わない(${seg})`);
    }
  }

  console.log("\n=== 2) 全部のタブを開く ===");
  const tabs = await page.locator("nav button, .tabs button").allInnerTexts();
  console.log("  タブ:", tabs.join(" / "));
  for (const t of tabs) {
    const name = t.trim();
    if (!name) continue;
    await page.locator("nav button, .tabs button").filter({ hasText: name }).first().click();
    await page.waitForTimeout(900);
    const h2 = await page.locator("h2").first().innerText().catch(() => "(見出しなし)");
    console.log(`  ${name} → ${h2.replace(/\n/g, " ").slice(0, 40)}`);
  }

  console.log("\n=== 3) 次の回タブ: お題を考えてもらう ===");
  await page.locator("nav button, .tabs button").filter({ hasText: "次の回" }).first().click()
    .catch(async () => {
      await page.locator("button").filter({ hasText: "お題" }).first().click();
    });
  await page.waitForTimeout(600);
  const ask = page.locator("button:has-text('お題を考えてもらう')");
  if (!(await ask.count())) {
    note("お題", "ボタンが見つからない");
  } else {
    await ask.click();
    await page.waitForSelector(".idea, .error", { timeout: 60000 });
    if (await page.locator(".error").count()) {
      note("お題", (await page.textContent(".error")).slice(0, 160));
    } else {
      const n = await page.locator(".idea").count();
      console.log("  出たお題:", n, "件 /", await page.locator(".idea-title").first().innerText());
      if (n === 0) note("お題", "0件しか出ていない");
      // 決めて持ち回れるか
      await page.locator(".idea button:has-text('次はこれ')").first().click();
      await page.waitForTimeout(300);
      const marked = await page.locator("button:has-text('✓ 次はこれ')").count();
      console.log("  次はこれにできたか:", marked > 0 ? "できた" : "できていない");
      if (marked === 0) note("お題", "「次はこれ」が効いていない");
    }
  }

  console.log("\n=== 4) 作成タブに戻り、次の回を始めて持ち回りを確認 ===");
  await page.locator("nav button, .tabs button").filter({ hasText: "作成" }).first().click();
  await page.waitForTimeout(600);
  // 決めたお題は「これから録る」画面に出る。結果を見ている最中には出ない
  const next = page.locator("button:has-text('次のエピソードを処理する')");
  if (await next.count()) { await next.click(); await page.waitForTimeout(600); }
  const carried = await page.locator("body").innerText();
  console.log("  お題が持ち回られたか:", carried.includes("ねぎ塩の続き") ? "見えている" : "見えていない");
  if (!carried.includes("ねぎ塩の続き")) note("持ち回り", "決めたお題が作成画面に出ていない");

  console.log("\n=== 5) 設定の往復 ===");
  await page.locator("nav button, .tabs button").filter({ hasText: "設定" }).first().click();
  await page.waitForTimeout(500);
  const nameBox = page.locator("input[type=text]").first();
  await nameBox.fill("巡回ラジオ");
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(900);
  await page.locator("nav button, .tabs button").filter({ hasText: "設定" }).first().click();
  await page.waitForTimeout(600);
  const kept = await page.locator("input[type=text]").first().inputValue();
  console.log("  番組名が残ったか:", kept || "(空)");
  if (kept !== "巡回ラジオ") note("設定", `番組名が残っていない(${kept})`);

  console.log("\n=== 6) 履歴を開く ===");
  await page.locator("nav button, .tabs button").filter({ hasText: "履歴" }).first().click();
  await page.waitForTimeout(700);
  if (await page.locator(".history-main").count()) {
    await page.locator(".history-main").first().click();
    await page.waitForTimeout(1200);
    const has = await page.locator(".card").filter({ hasText: "カバー画像の注文文" }).count();
    console.log("  過去回にカバーの注文文:", has ? "出る" : "出ない");
    if (!has) note("履歴", "過去回にカバーの注文文が出ない");
    const titles = await page.locator(".title-option").count();
    console.log("  タイトル案:", titles, "件");
  } else {
    note("履歴", "履歴の行が無い");
  }

  console.log("\n=== 7) 控えの書き出し ===");
  const dl = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await page.locator("button:has-text('控えを書き出す')").first().click().catch(() => {});
  const file = await dl;
  console.log("  書き出せたか:", file ? file.suggestedFilename() : "できていない");
  if (!file) note("控え", "書き出せない");

  await page.screenshot({ path: "patrol.png", fullPage: false });
  await browser.close();
  console.log(problems.length ? "\n見つかったもの:\n- " + problems.join("\n- ") : "\nOK: 例外・エラー・警告なし");
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
