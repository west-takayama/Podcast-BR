// Run against Vite dev to call the same adapter and database code from two tabs.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const base = process.env.BUDGET_TEST_URL || "http://localhost:4257/";
const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let sent = 0;
    let release;
    let entered;
    let policy = "hold";
    const nextRequest = () => new Promise(resolve => { entered = resolve; });
    const hold = () => new Promise(resolve => { release = resolve; });
    let held = hold();
    await context.route("https://generativelanguage.googleapis.com/**", async route => {
      if (!route.request().url().startsWith(endpoint)) return route.abort();
      sent++;
      entered?.();
      if (policy === "offline") return route.abort("internetdisconnected");
      if (policy === "hold") await held;
      return route.fulfill({ json: { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 25,
        promptTokensDetails: [{ modality: "AUDIO", tokenCount: 900 }] }, candidates: [{ finishReason: "STOP", content: { parts: [{ text: "private response fixture" }] } }] } });
    });
    const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all([first.goto(base), second.goto(base)]);
    await first.getByRole("button", { name: "予算", exact: true }).click();
    await first.getByRole("heading", { name: "予算管理" }).waitFor();
    await first.getByText("課金方式・換算条件・制作予定", { exact: true }).click();
    await first.getByLabel("課金方式").selectOption("postpaid");
    await first.getByLabel("1米ドルあたりの円").fill("100");
    await first.getByRole("button", { name: "予算条件を保存" }).click();
    await first.getByText(/保存済みの設定 後払い/).waitFor();
    await first.getByText("運営費を登録", { exact: true }).click();
    await first.getByLabel("項目名", { exact: true }).fill("合成の運営費");
    await first.getByLabel("金額（円）", { exact: true }).fill("1940");
    await first.getByRole("button", { name: "運営費を追加" }).click();
    await first.getByText("予算判断額が1,600円以上です。").waitFor();
    const request = (page, text, attempt = 1) => page.evaluate(async ({ endpoint, text, attempt }) => {
      const { geminiFetch } = await import("/src/adapters/geminiObservability.ts");
      const episodeId = "00000000-0000-4000-8000-000000000001";
      try {
        const res = await geminiFetch({ purpose: "captions", model: "gemini-2.5-flash-lite", hasAudio: true, attempt, episodeId },
          endpoint, { method: "POST", headers: { "x-goog-api-key": "private synthetic key" },
            body: JSON.stringify({ contents: [{ parts: [{ text }] }] }) });
        await res.json();
        return { status: res.status };
      } catch (error) { return { error: error.name, message: error.message }; }
    }, { endpoint, text, attempt });
    const read = page => page.evaluate(async () => {
      const { readBudget } = await import("/src/modules/budget/store.ts");
      return readBudget();
    });
    const setExpense = (page, yen) => page.evaluate(async amount => {
      const { updateBudget } = await import("/src/modules/budget/store.ts");
      return updateBudget(state => { state.operating[0].amount = amount * 1_000_000; });
    }, yen);
    const arrived = nextRequest();
    const running = request(first, "private source text");
    await arrived;
    const denied = await request(second, "different paid request");
    assert.match(denied.message, /月間予算2,000円/);
    assert.equal(sent, 1);
    const reserved = (await read(second)).entries[0];
    assert.equal(reserved.state, "pending");
    assert(reserved.reserved > 0);
    release();
    assert.deepEqual(await running, { status: 200 });

    await setExpense(second, 1500);
    held = hold();
    const secondArrived = nextRequest();
    const duplicate = request(first, "private source text");
    await secondArrived;
    assert.match((await request(second, "private source text")).message, /同じGemini要求/);
    assert.equal(sent, 2);
    release();
    await duplicate;
    policy = "offline";
    const interrupted = await request(second, "failed paid request", 2);
    assert.equal(interrupted.error, "TypeError");
    assert.equal(sent, 3);
    const { entries } = await read(first);
    assert.equal(entries.filter(entry => entry.state === "unknown").length, 1);
    assert.equal(entries.at(-1).estimate, undefined);
    assert.equal(entries.at(-1).attempt, 2);
    assert(entries.at(-1).reserved > 0);
    assert(entries[0].estimate > 0 && entries[0].audioTokens === 900 && entries[0].thinkingTokens === 25);
    assert.match(entries[0].rateVersion, /google-standard/);
    assert.doesNotMatch(JSON.stringify(entries), /private|requestKey/);
    await first.evaluate(async () => {
      const { recordGeminiCache } = await import("/src/adapters/geminiObservability.ts");
      recordGeminiCache("captions", "00000000-0000-4000-8000-000000000001");
    });
    await first.getByText("要求と再利用の記録（4件）").waitFor();
    assert.equal(sent, 3);
    await first.reload();
    await first.getByRole("button", { name: "予算", exact: true }).click();
    await first.getByText("要求と再利用の記録（4件）").waitFor();
    assert.equal(await first.getByText(/字幕 · 未確定/).count(), 1);
    assert.equal(await first.getByText(/字幕 · 端末内再利用/).count(), 1);
    if (process.env.BUDGET_SCREENSHOT) await first.screenshot({ path: process.env.BUDGET_SCREENSHOT, fullPage: true });
    assert.equal(sent, 3);
    console.log("OK: budget UI, two-tab atomic cap, duplicate protection, unknown reservation, ledger reload, no sensitive data");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
