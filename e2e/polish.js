// スマホで使う道具としての作りを測る。
//
//  1) 横にはみ出していないか(390px 幅で横スクロールが出ると片手で扱えない)
//  2) 押すものが小さすぎないか(指で押せる大きさか)
//  3) 入力に名前が付いているか(読み上げ・自動入力が効くか)
//  4) 初めて開いた人が何を見るか
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";

const META = {
  titles: ["ねぎ塩だれを作りすぎた回", "別案"], description: "説明文です。", showNotes: "- x",
  chapters: [{ time: "00:00", label: "オープニング" }, { time: "00:12", label: "本題" }],
  hashtags: ["#雑談"], transcriptSummary: "要約", keywords: ["ねぎ塩"],
  clips: [{ start: "00:02", end: "00:20", hook: "ここが山場", why: "笑いが起きている" }],
};
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };

const measure = () => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;

  // 横にはみ出している要素
  const over = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.position === "fixed") continue;
    if (r.right > vw + 1 || r.left < -1) {
      // はみ出しの原因になっている最小の要素だけ拾う
      if (![...el.children].some((c) => {
        const cr = c.getBoundingClientRect();
        return cr.right > vw + 1 || cr.left < -1;
      })) {
        over.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 30),
          right: Math.round(r.right),
          text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28),
        });
      }
    }
  }

  // 小さすぎる操作対象
  const small = [];
  for (const el of document.querySelectorAll("button, a, select, input, label.drop, label.photo-pick, label.restore-pick")) {
    // チェックボックスは包んでいるラベル全体が的なので、そちらを測る
    const target = el.type === "checkbox" && el.closest("label") ? el.closest("label") : el;
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    if (r.height < 40 || r.width < 32) {
      small.push({
        tag: target.tagName.toLowerCase(),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        text: (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24),
      });
    }
  }

  // 名前の無い入力
  const unlabeled = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (el.type === "file") continue; // ラベルで包んでいる
    const id = el.id;
    const has =
      el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      (id && document.querySelector(`label[for="${id}"]`)) ||
      el.closest("label") ||
      el.getAttribute("placeholder");
    if (!has) unlabeled.push({ tag: el.tagName.toLowerCase(), type: el.type || "", cls: (el.className||"").slice(0,20) });
  }

  return {
    scrollX: doc.scrollWidth > vw,
    scrollWidth: doc.scrollWidth,
    vw,
    over: over.slice(0, 8),
    small: small.slice(0, 10),
    unlabeled: unlabeled.slice(0, 8),
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const findings = [];

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

  const report = async (label) => {
    const m = await page.evaluate(measure);
    const flags = [];
    if (m.scrollX) flags.push(`横にはみ出す(${m.scrollWidth}px > ${m.vw}px)`);
    if (m.over.length) flags.push(`はみ出し要素 ${m.over.length}`);
    if (m.small.length) flags.push(`小さい操作対象 ${m.small.length}`);
    if (m.unlabeled.length) flags.push(`名前の無い入力 ${m.unlabeled.length}`);
    console.log(`  ${label}: ${flags.length ? flags.join(" / ") : "問題なし"}`);
    for (const o of m.over) console.log(`      はみ出し: <${o.tag} class="${o.cls}"> right=${o.right} 「${o.text}」`);
    for (const s of m.small) console.log(`      小さい: <${s.tag}> ${s.size} 「${s.text}」`);
    for (const u of m.unlabeled) console.log(`      名前なし: <${u.tag} type=${u.type} class=${u.cls}>`);
    if (m.scrollX) findings.push(`${label}: 横にはみ出す(${m.scrollWidth}px)`);
    if (m.small.length) findings.push(`${label}: 指で押しにくい操作対象が ${m.small.length} 個`);
    if (m.unlabeled.length) findings.push(`${label}: 名前の無い入力が ${m.unlabeled.length} 個`);
    return m;
  };

  console.log("=== 初めて開いたとき ===");
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(1200);
  const firstText = await page.locator("body").innerText();
  console.log("  最初に見えるもの:", firstText.split("\n").filter(Boolean).slice(0, 4).join(" / ").slice(0, 100));
  await report("初回(設定)");
  await page.screenshot({ path: "polish-first.png", fullPage: true });

  await page.fill("input[type=password]", "AIzaMOCK");
  await page.waitForTimeout(1200);
  await page.locator("input[type=text]").first().fill("ブリッジラジオ");
  await report("設定(入力後)");
  await page.click("button:has-text('保存して閉じる')");
  await page.waitForTimeout(500);
  await report("作成(待機)");

  console.log("\n=== 変換して結果画面 ===");
  await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
  await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
  await report("結果");
  await page.screenshot({ path: "polish-result.png", fullPage: true });

  console.log("\n=== 各タブ ===");
  for (const t of ["ショート", "次の回", "履歴", "設定"]) {
    await page.click(`nav button:has-text('${t}')`);
    await page.waitForTimeout(800);
    await report(t);
  }

  await browser.close();
  console.log(findings.length ? "\n磨きどころ:\n- " + findings.join("\n- ") : "\nOK: 測った範囲では問題なし");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
