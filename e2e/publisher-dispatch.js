const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const base = process.env.PUBLISHER_TEST_URL || "http://localhost:4265/";
(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const context = await browser.newContext();
    await context.route("https://**", route => route.abort());
    const page = await context.newPage();
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { dispatch, inspectDelivery } = await import("/src/modules/publisher/dispatch.ts");
      const { publisherTransaction } = await import("/src/modules/publisher/store.ts");
      const { destinations, draftKey, makeDraft } = await import("/src/modules/publisher/model.ts");
      const candidate = { candidateId: "candidate", versionId: "one", title: "Mock short", description: "", hashtags: [],
        mime: "video/mp4", startMs: 0, endMs: 4000, filename: "fixture.mp4", videoId: "fixture", manifestId: "fixture-manifest" };
      const key = draftKey(candidate);
      await publisherTransaction(true, state => { state.drafts[key] = { ...makeDraft(candidate), state: "approved", audience: "no" }; });
      const records = new Map();
      const calls = [];
      const provider = {
        reserve: async item => {
          calls.push(item.destination);
          records.set(item.destination, "scheduled");
          if (item.destination === "tiktok") throw new TypeError("response lost");
          return item.destination + "-fixture";
        },
        inspect: async item => ({ state: records.get(item.destination) || "unknown", evidence: item.destination + "-fixture" }),
        cancel: async item => { records.set(item.destination, "cancelled"); },
      };
      await Promise.all(destinations.map(network => dispatch(provider, key, network, "sameVideo")));
      let duplicateBlocked = false;
      try { await dispatch(provider, key, "tiktok", "sameVideo"); } catch { duplicateBlocked = true; }
      const before = await publisherTransaction(false, state => state.deliveries);
      const tiktok = before.findIndex(item => item.destination === "tiktok");
      await inspectDelivery(provider, tiktok);
      const youtube = before.findIndex(item => item.destination === "youtube");
      await inspectDelivery(provider, youtube, true);
      const instagram = before.findIndex(item => item.destination === "instagram");
      records.set("instagram", "published");
      await inspectDelivery(provider, instagram);
      const after = await publisherTransaction(false, state => state.deliveries);
      return { before: Object.fromEntries(before.map(item => [item.destination, item.state])),
        after: Object.fromEntries(after.map(item => [item.destination, item.state])), duplicateBlocked, calls };
    });
    assert.deepEqual(result.before, { instagram: "scheduled", tiktok: "unknown", youtube: "scheduled" });
    assert.deepEqual(result.after, { instagram: "published", tiktok: "scheduled", youtube: "cancelled" });
    assert.equal(result.duplicateBlocked, true);
    assert.deepEqual(result.calls.sort(), ["instagram", "tiktok", "youtube"]);
    console.log("OK: all three mock destinations, lost acknowledgement, inspect, result and cancellation");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
