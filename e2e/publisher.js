const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const port = process.argv[2] || 4218;
const folder = "14tBUxITSF8mdAx5eAtBqZvGeKbSq-oqu";
const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=24",
  "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
const files = new Map();
const media = new Map();
for (let i = 1; i <= 2; i++) {
  const title = `合成候補${i}`, description = "収録から選んだテスト投稿文", hashtags = ["#合成"];
  const candidateId = hash(`candidate-${i}`);
  const versionId = hash(JSON.stringify(["short-version-v1", hash(bytes), "video/mp4", title, description, hashtags]));
  const identifiers = { candidateId, versionId };
  const videoId = `fixture-video-${i}`, manifestId = `fixture-manifest-${i}`;
  files.set(videoId, { id: videoId, name: `short-${i}.mp4`, mimeType: "video/mp4", parents: [folder],
    appProperties: { ...identifiers, studioRole: "video" } });
  files.set(manifestId, { id: manifestId, name: `short-${i}.json`, mimeType: "application/json", parents: [folder],
    appProperties: { ...identifiers, studioRole: "manifest" } });
  media.set(videoId, bytes);
  media.set(manifestId, Buffer.from(JSON.stringify({ schemaVersion: 2, ...identifiers, status: "pending_owner_approval",
    title, description, hashtags, video: { driveFileId: videoId }, range: { startMs: 0, endMs: 4000 } })));
}

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests = [];
    await page.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "application/javascript", body: `
      window.google = {accounts:{oauth2:{initTokenClient(config) {
        window.publisherScope = config.scope;
        return {requestAccessToken(){config.callback({access_token:"publisher-fixture",expires_in:3600});}};
      }}}};` }));
    await page.route(/https:\/\/(www\.googleapis\.com|generativelanguage\.googleapis\.com|app\.metricool\.com)\//, async route => {
      const req = route.request();
      const url = new URL(req.url());
      requests.push([url.hostname, req.method()]);
      if (url.hostname !== "www.googleapis.com" || req.method() !== "GET") return route.abort();
      assert.equal(req.headers().authorization, "Bearer publisher-fixture");
      const id = url.pathname.split("/").at(-1);
      const headers = { "access-control-allow-origin": "*" };
      if (id === "files") return route.fulfill({ headers, json: { files: [...files.values()] } });
      if (id === folder) return route.fulfill({ headers, json: { id, mimeType: "application/vnd.google-apps.folder", capabilities: {canAddChildren: true} } });
      if (!files.has(id)) return route.fulfill({ headers, status: 404 });
      if (url.searchParams.get("alt") === "media") return route.fulfill({ headers, contentType: files.get(id).mimeType, body: media.get(id) });
      return route.fulfill({ headers, json: files.get(id) });
    });

    await page.goto(`http://localhost:${port}/`);
    await page.getByLabel("OAuthクライアントID").fill("fixture.apps.googleusercontent.com");
    await page.getByLabel("Google Cloudプロジェクト番号").fill("123456");
    await page.getByLabel("Picker用ブラウザ制限キー").fill("no-real-key");
    await page.getByRole("button", { name: "Google接続設定を保存" }).click();
    await page.getByRole("button", { name: "Googleに接続", exact: true }).click();
    assert.equal(await page.evaluate(() => window.publisherScope), "https://www.googleapis.com/auth/drive.file");
    await page.getByText(/接続済み・保存先確認済み/).first().waitFor();
    await page.getByRole("button", { name: "投稿", exact: true }).click();
    await page.getByRole("button", { name: "Driveから投稿候補を取得" }).click();
    await page.getByText("投稿候補 2件を確認しました。").waitFor();
    for (let i = 1; i <= 2; i++) {
      await page.getByText(`合成候補${i} · 投稿候補`, { exact: true }).locator("..").getByRole("button").click();
      if (i === 1) {
        media.set("fixture-video-1", Buffer.concat([bytes, Buffer.from("changed")]));
        await page.getByRole("button", { name: "非公開動画をプレビュー" }).click();
        await page.getByText(/動画の版が変更されています/).waitFor();
        assert.equal(await page.locator(".publisher video").count(), 0);
        media.set("fixture-video-1", bytes);
      }
      await page.getByLabel("子ども向け").selectOption("no");
      await page.getByRole("button", { name: "承認待ちにする" }).click();
      await page.getByRole("checkbox", { name: `合成候補${i} · 承認待ち` }).check();
    }
    await page.getByRole("button", { name: "選択した候補を一括承認" }).click();
    await page.getByText("選んだ版を承認しました。").waitFor();
    await page.getByText("合成候補1 · 承認済み", { exact: true }).locator("..").getByRole("button").click();
    const edit = page.getByRole("textbox", { name: "投稿文 · Instagram · bridge_radio", exact: true });
    await edit.fill("編集したため再承認が必要");
    await edit.blur();
    await page.getByRole("heading", { name: "合成候補1 · 投稿候補" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /引き渡しを準備/ }).count(), 0);
    await page.getByText("合成候補2 · 承認済み", { exact: true }).locator("..").getByRole("button").click();
    await page.getByRole("button", { name: /引き渡しを準備 · Instagram/ }).click();
    await page.getByRole("link", { name: "承認済み動画を保存" }).waitFor();
    assert.match(await page.getByLabel("コピー用投稿情報").inputValue(), /収録から選んだテスト投稿文/);
    await page.getByRole("button", { name: "結果不明を記録" }).click();
    await page.getByText("Instagram · bridge_radio · 結果不明", { exact: true }).waitFor();
    await page.getByRole("button", { name: /引き渡しを準備 · Instagram/ }).click();
    await page.getByText(/同じ動画または候補/).waitFor();
    await page.getByLabel("外部IDまたはPlannerで確認した結果").fill("合成Plannerで未登録を確認");
    await page.getByRole("button", { name: /失敗・未登録確認済みを記録/ }).click();
    await page.getByText("Instagram · bridge_radio · 失敗・未登録確認済み", { exact: true }).waitFor();
    await page.getByRole("button", { name: /引き渡しを準備 · Instagram/ }).click();
    await page.getByRole("link", { name: "承認済み動画を保存" }).waitFor();
    await page.getByLabel("外部IDまたはPlannerで確認した結果").fill("fixture-reservation");
    await page.getByRole("button", { name: "予約済みを記録" }).click();
    await page.getByText(/外部ID fixture-reservation/).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "投稿", exact: true }).click();
    await page.getByText(/外部ID fixture-reservation/).waitFor();
    assert(requests.every(([host, method]) => host === "www.googleapis.com" && method === "GET"));
    if (process.env.PUBLISHER_SCREENSHOT) await page.screenshot({ path: process.env.PUBLISHER_SCREENSHOT, fullPage: true });
    console.log("OK: private Drive, dual approval, verified handoff, unknown/retry, persisted result, no SNS/Gemini calls");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
