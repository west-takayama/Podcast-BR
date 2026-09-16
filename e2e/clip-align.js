// 切り抜きが「頼んだ場所」を切り出しているか。
//
// ここがずれていると、縦型ショートの中身が別の場面になる。しかも
// 元の音と並べて聴かない限り気づけない。目印を入れた音で確かめる。
//
// 目印: 1秒ごとに、その秒数ぶんの短いビープを鳴らす。
//       5秒目には 5 回、12秒目には 12 回。数えれば何秒地点か分かる。
const fs = require("fs");
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";
const SR = 44100;
const SEC = 40;

function makeMarkedWav(path) {
  const N = SR * SEC;
  const buf = Buffer.alloc(44 + N * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const sec = Math.floor(t);
    const inSec = t - sec;
    // その秒の頭から、(秒数)個のビープを 40ms 間隔で鳴らす
    const beeps = sec + 1;
    let v = 0;
    const slot = Math.floor(inSec / 0.04);
    if (slot < beeps && inSec - slot * 0.04 < 0.02) {
      v = 0.5 * Math.sin(2 * Math.PI * 1000 * i / SR);
    }
    // 無音カットに消されないよう、床に小さな声もどきを敷く
    v += 0.06 * Math.sin(2 * Math.PI * 180 * i / SR) * (0.7 + 0.3 * Math.sin(t * 5));
    buf.writeInt16LE(Math.max(-32700, Math.min(32700, Math.round(v * 32700))), 44 + i * 2);
  }
  fs.writeFileSync(path, buf);
}

const META = (start, end) => ({
  titles: ["目印の回"], description: "説明", showNotes: "-",
  chapters: [{ time: "00:00", label: "オープニング" }],
  hashtags: ["#t"], transcriptSummary: "要約", keywords: ["k"],
  clips: [{ start, end, hook: "ここ", why: "山場" }],
});
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };

/** 切り抜いた音を鳴らして、何秒地点の目印が入っているかを数える。 */
async function countBeeps(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const ac = new OfflineAudioContext(1, 48000, 48000);
  const audio = await ac.decodeAudioData(buf.slice(0));
  const d = audio.getChannelData(0);
  const sr = audio.sampleRate;
  const win = Math.round(sr * 0.01);
  const k = Math.round((1000 * win) / sr);
  const w = (2 * Math.PI * k) / win;
  const coef = 2 * Math.cos(w);
  const on = [];
  for (let at = 0; at + win < d.length; at += win) {
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < win; i++) { s0 = d[at + i] + coef * s1 - s2; s2 = s1; s1 = s0; }
    const mag = Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - coef * s1 * s2)) / win;
    on.push(mag > 0.03);
  }
  const groups = [];
  let cur = { at: 0, n: 0 };
  let prev = false;
  for (let i = 0; i < on.length; i++) {
    const t = (i * win) / sr;
    if (t - cur.at > 0.9) { groups.push({ ...cur }); cur = { at: Math.floor(t), n: 0 }; }
    if (on[i] && !prev) cur.n++;
    prev = on[i];
  }
  groups.push(cur);
  return { seconds: audio.duration, groups: groups.filter((g) => g.n > 0) };
}

(async () => {
  makeMarkedWav("marked.wav");
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const fails = [];
  const RANGE = { start: "00:12", end: "00:24" };

  await page.route("**/generativelanguage.googleapis.com/**", (r) => {
    const u = r.request().url();
    if (u.includes("/v1beta/models?"))
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
    if (u.includes("/upload/v1beta/files"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ file: { name: "files/m", uri: "https://mock/f", state: "ACTIVE" } }) });
    if (u.includes(":generateContent"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(META(RANGE.start, RANGE.end)) }] } }] }) });
    return r.fulfill({ status: 404, body: "no" });
  });

  await page.goto(`http://localhost:${PORT}/`);
  if (await page.locator("input[type=password]").count()) {
    await page.fill("input[type=password]", "AIzaMOCK");
    await page.waitForTimeout(1200);
    await page.click("button:has-text('保存して閉じる')");
  }

  console.log("=== 目印入りの音を変換する ===");
  await page.setInputFiles(".drop input[type=file]", "marked.wav");
  await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
  if (await page.locator(".error").count()) throw new Error(await page.textContent(".error"));

  const whole = await page.evaluate(countBeeps, await page.evaluate(() => document.querySelector("a.dl").href));
  console.log("  書き出した MP3:", whole.seconds.toFixed(1), "秒");
  console.log("  見つけた目印(先頭6つ):", whole.groups.slice(0, 6).map((g) => `${g.at}秒→${g.n}個`).join(" "));
  const ok0 = whole.groups.slice(0, 5).every((g) => Math.abs(g.n - (g.at + 1)) <= 1);
  console.log("  目印が秒数と一致:", ok0 ? "一致" : "ずれている");
  if (!ok0) fails.push("元の MP3 の時点で目印がずれている(試験信号の問題)");

  console.log(`\n=== 「${RANGE.start}〜${RANGE.end}」を切り抜く ===`);
  const studio = page.locator(".card").filter({ has: page.locator(".clip-trim") }).first();
  await studio.scrollIntoViewIfNeeded();
  const btn = studio.locator("button").filter({ hasText: "縦型" }).first();
  if (!(await btn.count())) {
    console.log("  ボタン:", (await studio.locator("button").allInnerTexts()).join(" / "));
    fails.push("切り抜きのボタンが見つからない");
  } else {
    await btn.click();
    await page.waitForSelector("video.card-preview, .error", { timeout: 300000 });
    if (await page.locator(".error").count()) {
      console.log("  エラー:", (await page.textContent(".error")).slice(0, 120));
      fails.push("切り抜きに失敗した");
    } else {
      const src = await page.locator("video.card-preview").first().getAttribute("src");
      const got = await page.evaluate(countBeeps, src);
      console.log("  切り抜きの長さ:", got.seconds.toFixed(1), "秒(頼んだのは 12秒)");
      console.log("  中に入っていた目印:", got.groups.slice(0, 8).map((g) => `${g.n}個`).join(" "));
      const first = got.groups[0];
      if (!first) {
        fails.push("切り抜きに目印が入っていない");
      } else {
        // 12秒地点なら 13 個のビープ(0秒=1個 なので秒数+1)
        const expected = 13;
        console.log(`  先頭の目印: ${first.n}個(12秒地点なら ${expected}個)`);
        if (Math.abs(first.n - expected) > 1)
          fails.push(`切り抜きの開始位置がずれている(${first.n}個 = 約${first.n - 1}秒地点)`);
      }
      if (Math.abs(got.seconds - 12) > 1.5)
        fails.push(`切り抜きの長さが違う(${got.seconds.toFixed(1)}秒)`);
    }
  }

  await browser.close();
  console.log(fails.length ? "\nFAIL:\n- " + fails.join("\n- ") : "\nOK: 頼んだ場所を切り抜いている");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
