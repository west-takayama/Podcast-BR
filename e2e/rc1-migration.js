const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { createReadStream, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { resolve, extname, sep } = require("node:path");

const previous = resolve(process.env.RC_PREVIOUS_DIST || "/tmp/rc1-v241-dist");
const next = resolve(process.env.RC_NEXT_DIST || "dist");
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
let active = previous;
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = resolve(active, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(active + sep)) { res.writeHead(403).end(); return; }
  try { if (!statSync(file).isFile()) throw new Error(); }
  catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://localhost:" + server.address().port;
  const browser = await chromium.launch(require("./browser-options"));
  const key = "AIzaSYNTHETIC_RC_COMPATIBILITY";
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // Do not make real requests even if the fixture's settings screen fetches models.
    await page.route("https://**/*", route => route.fulfill({ json: { models: [] } }));
    await page.goto(origin);
    await page.evaluate(async key => {
      localStorage.setItem("podcast-br-settings", JSON.stringify({ apiKey: key, savedAt: 1700000000000, model: "gemini-2.5-flash", accentColor: "#ffd400" }));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("podcast-br", 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("episodes", "readwrite");
        const meta = { titles: ["2.4.1で保存した合成回"], description: "合成の移行素材", showNotes: "", chapters: [], hashtags: [], transcriptSummary: "", keywords: [] };
        tx.objectStore("episodes").put({ id: "rc-history-241", createdAt: 1700000000000, fileName: "fixture.wav", durationSec: 5, removedSec: 0,
          meta, chosenTitle: meta.titles[0], audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }) });
        tx.oncomplete = resolve;
        tx.onabort = reject;
      });
      db.close();
    }, key);
    const check = async () => {
      await page.getByRole("button", { name: "履歴", exact: true }).click();
      await page.getByText("2.4.1で保存した合成回", { exact: true }).waitFor();
      const state = await page.evaluate(async () => {
        const settings = JSON.parse(localStorage.getItem("podcast-br-settings"));
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("podcast-br");
          request.onsuccess = () => resolve(request.result);
          request.onerror = reject;
        });
        const row = await new Promise((resolve, reject) => {
          const request = db.transaction("episodes").objectStore("episodes").get("rc-history-241");
          request.onsuccess = () => resolve(request.result);
          request.onerror = reject;
        });
        const snapshot = { version: db.version, key: settings.apiKey, bytes: [...new Uint8Array(await row.audio.arrayBuffer())] };
        db.close();
        return snapshot;
      });
      assert.deepEqual(state, { version: 3, key, bytes: [1, 2, 3] });
    };
    await page.reload();
    await check();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    async function swap(root) {
      active = root;
      await page.evaluate(async () => {
        const current = await navigator.serviceWorker.ready;
        await current.update();
      });
      let waiting = false;
      for (let attempt = 0; !waiting && attempt < 120; attempt++) {
        waiting = await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(waiting, "the updated Service Worker must wait for approval");
      await page.evaluate(async () => {
        const current = await navigator.serviceWorker.getRegistration();
        const done = new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
        current.waiting.postMessage({ type: "skip-waiting" });
        await done;
      });
      await page.reload();
      await check();
    }
    await swap(next);
    await page.getByRole("heading", { name: /RC1/ }).waitFor();
    await swap(previous);
    assert.equal(await page.getByRole("heading", { name: /RC1/ }).count(), 0);
    console.log("OK actual v2.4.1 → RC1 → v2.4.1 same-origin Service Worker, database v3, synthetic audio bytes and settings preserved");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
