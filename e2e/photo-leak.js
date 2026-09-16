// 前の回の写真が、次の回の MP3 に紛れ込まないか。
//
// 写真は「この回の情景」を写したもので、次の回へは持ち越さない約束になっている。
// IndexedDB の控えは reset で消しているが、画面の外で持っている参照はどうか。
//
//  A) 写真を入れた回: MP3 のカバーがその写真の色になる
//  B) 次の回に進んで写真を入れない → タイトルを選び直す(タグを付け直す)
//     → その MP3 に前の回の写真が入っていないか
//     → そもそもタグ(タイトル・チャプター)が残っているか
const fs = require("fs");
const { chromium } = require("playwright");
const PORT = process.argv[2] || "4218";

const meta = (t) => ({
  titles: [`${t}-1`, `${t}-2`], description: "説明", showNotes: "- x",
  chapters: [{ time: "00:00", label: "オープニング" }, { time: "00:10", label: "本題" }],
  hashtags: ["#t"], transcriptSummary: "要約", keywords: ["k"],
});
const MODELS = { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] };

// 真っ赤な PNG。混ざったかどうかが色で分かる
function makeRedPng(path) {
  const zlib = require("zlib");
  const W = 64, H = 64;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = 230; raw[o + 1] = 30; raw[o + 2] = 30;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(require("zlib").crc32 ? require("zlib").crc32(td) >>> 0 : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
      c = (crc ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = c ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** ページ内で MP3 のタグを覗く。 */
async function inspect() {
  const a = document.querySelector("a.dl");
  if (!a) return { error: "MP3 のリンクが無い", frames: [] };
  const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  const txt = new TextDecoder("latin1").decode(buf.subarray(0, 300000));
  const hasId3 = txt.startsWith("ID3");
  const frames = [];
  for (const f of ["TIT2", "TALB", "APIC", "CHAP", "CTOC"]) if (txt.includes(f)) frames.push(f);
  let rgb = null;
  const ap = txt.indexOf("APIC");
  if (ap > 0) {
    const marker = String.fromCharCode(0xff, 0xd8, 0xff);
    const js = txt.indexOf(marker, ap);
    if (js > 0) {
      const je = txt.indexOf(String.fromCharCode(0xff, 0xd9), js);
      const jpeg = buf.subarray(js, je > 0 ? je + 2 : Math.min(js + 400000, buf.length));
      try {
        const bmp = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height * 0.3), 1, 1).data;
        rgb = [d[0], d[1], d[2]];
        bmp.close();
      } catch (e) { rgb = "読めず:" + e.message; }
    }
  }
  return { hasId3, frames, rgb, bytes: buf.length };
}

(async () => {
  makeRedPng("red.png");
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const fails = [];
  let which = "A";

  await page.route("**/generativelanguage.googleapis.com/**", (r) => {
    const u = r.request().url();
    if (u.includes("/v1beta/models?"))
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
    if (u.includes("/upload/v1beta/files"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ file: { name: "files/m", uri: "https://mock/f", state: "ACTIVE" } }) });
    if (u.includes(":generateContent"))
      return r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(meta(which)) }] } }] }) });
    return r.fulfill({ status: 404, body: "no" });
  });

  await page.goto(`http://localhost:${PORT}/`);
  if (await page.locator("input[type=password]").count()) {
    await page.fill("input[type=password]", "AIzaMOCK");
    await page.waitForTimeout(1200);
    await page.click("button:has-text('保存して閉じる')");
  }

  const convert = async () => {
    await page.setInputFiles(".drop input[type=file]", "speechlike.wav");
    await page.waitForSelector("h2:has-text('投稿素材が完成しました'), .error", { timeout: 300000 });
    if (await page.locator(".error").count()) throw new Error(await page.textContent(".error"));
  };

  console.log("=== A) 写真を入れた回 ===");
  await convert();
  await page.setInputFiles(".card:has-text('この回の写真') input[type=file]", "red.png");
  await page.waitForTimeout(2500);
  const a = await page.evaluate(inspect);
  console.log("  タグ:", a.frames.join(","), "/ カバーの色:", a.rgb);
  if (!a.rgb || a.rgb[0] < 150 || a.rgb[1] > 120) fails.push(`A: 写真がカバーに入っていない(${a.rgb})`);

  console.log("\n=== B) 次の回へ進む(写真は入れない) ===");
  which = "B";
  await page.click("button:has-text('次のエピソードを処理する')");
  await page.waitForTimeout(500);
  await convert();
  const before = await page.evaluate(inspect);
  console.log("  生成直後 → タグ:", before.frames.join(","), "/ カバーの色:", before.rgb);

  console.log("\n=== B') タイトルを選び直す(タグを付け直す) ===");
  await page.locator(".title-option").nth(1).click();
  await page.waitForTimeout(2500);
  const after = await page.evaluate(inspect);
  console.log("  付け直し後 → タグ:", after.frames.join(",") || "(無し)", "/ カバーの色:", after.rgb);

  if (!after.hasId3) fails.push("B: 付け直しでタグが丸ごと消えた");
  for (const f of ["TIT2", "CHAP"])
    if (!after.frames.includes(f)) fails.push(`B: 付け直しで ${f} が消えた`);
  if (after.rgb && after.rgb[0] > 150 && after.rgb[1] < 120)
    fails.push(`B: 前の回の写真が入っている(${after.rgb})`);

  console.log("\n=== E) 画面が中身を読み返して見せているか ===");
  const readback = await page.locator("p.muted").filter({ hasText: "ファイルの中身" }).first()
    .innerText().catch(() => "(出ていない)");
  console.log("  表示:", readback.replace(/\s+/g, " ").slice(0, 110));
  if (!readback.includes("ファイルの中身")) fails.push("E: 中身の読み返しが出ていない");
  if (!readback.includes("チャプター")) fails.push("E: チャプター数を出していない");
  if (!readback.includes("カバー")) fails.push("E: カバーの有無を出していない");

  await browser.close();
  console.log(fails.length ? "\nFAIL:\n- " + fails.join("\n- ") : "\nOK: 写真は次の回へ持ち越されない");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
