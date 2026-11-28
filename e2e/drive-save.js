const { selectEpisode, scores } = require("./select-episode");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const port = process.argv[2] || 4218;
const folder = "14tBUxITSF8mdAx5eAtBqZvGeKbSq-oqu";
const oauthResponse = `
  window.google = window.google || {};
  window.google.accounts = { oauth2: { initTokenClient(config) {
    window.observedScope = config.scope;
    window.observedGrantedScopes = config.include_granted_scopes;
    return { requestAccessToken() { config.callback({ access_token: "fixture-token", expires_in: 3600 }); } };
  }}};
`;
const pickerResponse = `
  window.google = window.google || {};
  window.gapi = { load(name, options) { options.callback(); } };
  class View {
    setIncludeFolders() { return this; }
    setSelectFolderEnabled() { return this; }
    setMimeTypes() { return this; }
  }
  class Builder {
    addView() { return this; }
    setOAuthToken() { return this; }
    setDeveloperKey() { return this; }
    setAppId() { return this; }
    setOrigin() { return this; }
    setTitle() { return this; }
    setCallback(callback) { this.callback = callback; return this; }
    build() {
      const callback = this.callback;
      return { setVisible(visible) {
        if (visible) window.setTimeout(() => callback({ action: "picked", docs: [{ id: window.testFolder }] }), 0);
      }};
    }
  }
  window.google.picker = { ViewId: { FOLDERS: "folders" }, Action: { PICKED: "picked", CANCEL: "cancel" }, DocsView: View, PickerBuilder: Builder };
`;
const candidates = {
  clips: [
    { start: 0, end: 5, hook: "短編一", scores, socialPost: "投稿の本文一", hashtags: ["#短編一"] },
    { start: 6, end: 11, hook: "短編二", scores, socialPost: "投稿の本文二", hashtags: ["#短編二"] },
  ],
  episodeFacts: ["素材について話しました。"],
};
const answer = data => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] });

(async () => {
  const browser = await chromium.launch(require("./browser-options"));
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "application/javascript", body: oauthResponse }));
    await page.route("https://apis.google.com/js/api.js", route => route.fulfill({ contentType: "application/javascript", body: pickerResponse }));
    let geminiRequests = 0;
    await page.route("**/generativelanguage.googleapis.com/**", route => {
      geminiRequests++;
      const req = route.request();
      if (req.url().includes("/models?")) return route.fulfill({ json: { models: [{ name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] }] } });
      if (req.url().includes("/upload/")) return route.fulfill({ json: { file: { name: "files/mock", uri: "https://mock/audio", state: "ACTIVE" } } });
      if (req.url().includes(":generateContent")) {
        const prompt = req.postDataJSON().contents[0].parts.at(-1).text;
        return route.fulfill({ json: answer(prompt.includes("Spotify掲載用") ? { titles: ["検証用"], description: "テストです。" } : candidates) });
      }
      return route.abort();
    });
    const files = new Map();
    const sessions = new Map();
    const verifiedIds = [];
    const uploadedRoles = [];
    const uploadedManifests = [];
    let permitFolder = false;
    let reserve = 0;
    let failFirstManifest = true;
    let manifestConflict = false;
    await page.route("https://www.googleapis.com/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,x-upload-content-type,x-upload-content-length",
        "access-control-expose-headers": "location",
      };
      const send = (status, json, headers = {}) => route.fulfill({ status, json, headers: { ...cors, ...headers } });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      assert.equal(request.headers().authorization, "Bearer fixture-token");
      assert(!url.pathname.includes("/permissions"), "sharing state stays unchanged");
      if (url.pathname === `/drive/v3/files/${folder}`) {
        return send(permitFolder ? 200 : 404, permitFolder
          ? { id: folder, mimeType: "application/vnd.google-apps.folder", capabilities: { canAddChildren: true } }
          : {});
      }
      if (url.pathname === "/drive/v3/files/generateIds") {
        reserve++;
        return send(200, { ids: [`video-${reserve}`, `manifest-${reserve}`] });
      }
      if (url.pathname === "/drive/v3/files") {
        const id = url.searchParams.get("q").match(/value='([a-f0-9]+)'/)[1];
        return send(200, { files: [...files.values()].filter(entry => entry.metadata.appProperties.candidateId === id).map(entry => entry.metadata) });
      }
      if (url.pathname.startsWith("/drive/v3/files/")) {
        const id = url.pathname.split("/").at(-1);
        verifiedIds.push(id);
        return send(files.has(id) ? 200 : 404, files.get(id)?.metadata ?? {});
      }
      if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
        const metadata = request.postDataJSON();
        assert.deepEqual(metadata.parents, [folder]);
        assert(!metadata.permissions);
        assert.match(metadata.appProperties.versionId, /^[a-f0-9]{64}$/);
        if (files.has(metadata.id)) { manifestConflict = true; return send(409, {}); }
        const session = String(sessions.size + 1);
        sessions.set(session, { ...metadata, createdTime: new Date(1700000000000 + Number(session) * 1000).toISOString() });
        return send(200, {}, { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${session}` });
      }
      if (url.pathname === "/upload/drive/v3/files" && method === "PUT") {
        const metadata = sessions.get(url.searchParams.get("upload_id"));
        assert(metadata);
        const role = metadata.appProperties.studioRole;
        uploadedRoles.push(role);
        if (role === "manifest") {
          const manifest = request.postDataJSON();
          assert.equal(manifest.candidateId, metadata.appProperties.candidateId);
          assert.equal(manifest.versionId, metadata.appProperties.versionId);
          assert.equal(manifest.schemaVersion, 2);
          assert.equal(manifest.status, "pending_owner_approval");
          assert.deepEqual(manifest.hashtags, [`#${manifest.title}`]);
          assert(files.has(manifest.video.driveFileId));
          const copy = uploadedManifests.length === 2 ? "投稿文を改訂" :
            manifest.title === "短編一" ? "投稿の本文一" : "投稿の本文二";
          assert.equal(manifest.description, copy + "\n\n本編 #42「合成回の本編」");
          assert.equal(manifest.parent.title, "合成回の本編");
          assert.equal(manifest.parent.number, "42");
          assert.match(manifest.parent.episodeId, /^[0-9a-f-]{36}$/);
          assert.equal(manifest.video.mimeType, files.get(manifest.video.driveFileId).metadata.mimeType);
          uploadedManifests.push(manifest);
          if (failFirstManifest) {
            // The server committed but the client lost the response. Hide the
            // first manifest from listing temporarily to force a reserved-ID conflict.
            failFirstManifest = false;
            files.set(metadata.id, { metadata, manifest });
            return send(503, {});
          }
        } else {
          assert(["video/mp4", "video/webm"].includes(metadata.mimeType));
          assert(request.postDataBuffer().length > 0);
        }
        files.set(metadata.id, { metadata });
        return send(200, { id: metadata.id });
      }
      return route.abort();
    });

    await page.goto(`http://localhost:${port}/`);
    await page.getByRole("heading", { name: "Google Drive連携" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: /書き出した動画/ }).count(), 0);
    await page.getByLabel("OAuthクライアントID").fill("fixture.apps.googleusercontent.com");
    await page.getByLabel("Google Cloudプロジェクト番号").fill("123456");
    await page.getByLabel("Picker用ブラウザ制限キー").fill("no-real-key");
    await page.getByRole("button", { name: "Google接続設定を保存" }).click();
    await page.getByRole("button", { name: "Googleに接続", exact: true }).click();
    assert.equal(await page.evaluate(() => window.observedScope), "https://www.googleapis.com/auth/drive.file");
    assert.equal(await page.evaluate(() => window.observedGrantedScopes), false);
    const selectFolder = page.getByRole("button", { name: "投稿候補フォルダを選択" });
    await page.evaluate(() => { window.testFolder = "wrong-folder"; });
    await selectFolder.click();
    await page.getByText("指定の「01_投稿候補」フォルダを選択してください。").waitFor();
    assert.equal(files.size, 0);
    permitFolder = true;
    await page.evaluate(id => { window.testFolder = id; }, folder);
    await selectFolder.click();
    await page.getByRole("status").filter({ hasText: "Google Drive：接続済み・保存先確認済み" }).waitFor();
    assert.equal(geminiRequests, 0);
    await page.locator("input[type=password]").fill("AIzaMOCK");
    await page.getByRole("button", { name: "保存して閉じる" }).click();
    await page.locator(".production-picker input").setInputFiles("speechlike.wav");
    await page.getByRole("checkbox", { name: /字幕を入れる/ }).uncheck();
    await selectEpisode(page);
    await page.getByRole("button", { name: "推奨ショート動画をまとめて生成" }).click();
    await page.getByRole("heading", { name: /書き出した動画\(2本\)/ }).waitFor({ timeout: 90000 });
    await page.getByText("Googleドライブへ保存", { exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Google Drive：接続済み・保存先確認済み" }).waitFor();
    assert.equal(await page.getByLabel("OAuthクライアントID").count(), 0);
    const save = page.getByRole("button", { name: "完成動画をまとめてGoogleドライブに保存" });
    await save.click();
    await page.getByText(/完了 1本、失敗 1本/).waitFor();
    assert.deepEqual(uploadedRoles, ["video", "manifest", "video", "manifest"]);
    assert.equal(files.size, 4, "server committed both pairs despite lost response");
    const firstId = uploadedManifests[0].candidateId;
    // Drive listings may lag immediately after completion. The same reserved IDs must be retried.
    let hideOnce = true;
    await page.route("https://www.googleapis.com/drive/v3/files?**", async route => {
      const request = route.request();
      const query = new URL(request.url()).searchParams.get("q");
      if (request.method() !== "GET" || !hideOnce || !query?.includes(firstId)) return route.fallback();
      hideOnce = false;
      const video = [...files.values()].find(entry => entry.metadata.appProperties.candidateId === firstId && entry.metadata.appProperties.studioRole === "video").metadata;
      return route.fulfill({ json: { files: [video] }, headers: { "access-control-allow-origin": "*" } });
    });
    await page.getByRole("button", { name: "失敗分だけ再試行" }).click();
    await page.getByText(/完了 1本、失敗 0本/).waitFor();
    assert(manifestConflict && verifiedIds.includes("manifest-1"));
    assert.equal(reserve, 2, "retry reuses the same reserved IDs");
    assert.equal(uploadedRoles.length, 4, "retry does not send a second video or manifest body");
    assert.equal(files.size, 4);
    assert.equal(await save.isDisabled(), true);
    const edited = page.locator(".clip-result").filter({ has: page.getByRole("heading", { name: "短編一" }) });
    await edited.getByText("投稿文・ハッシュタグ", { exact: true }).click();
    await edited.getByLabel("投稿文（短編一）").fill("投稿文を改訂");
    await save.click();
    await page.getByText(/完了 1本、失敗 0本/).waitFor();
    assert.equal(files.size, 6, "revised metadata creates one new pair and retains old files");
    assert.equal(uploadedManifests[2].candidateId, firstId);
    assert.notEqual(uploadedManifests[2].versionId, uploadedManifests[0].versionId);
    const latest = page.getByRole("link", { name: uploadedManifests[2].versionId.slice(0, 12) });
    assert(await latest.isVisible());
    assert.match(await latest.locator("..").innerText(), /保存時の最新版/);
    assert.equal(await save.isDisabled(), true);
    const nav = page.locator("nav");
    await nav.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("button", { name: "Googleとの接続を解除" }).click();
    await page.getByRole("status").filter({ hasText: "Google Drive：未接続" }).waitFor();
    await nav.getByRole("button", { name: "作成", exact: true }).click();
    const beforeShortcut = geminiRequests;
    await page.getByRole("button", { name: "設定でGoogle Drive連携を開く" }).click();
    await page.getByRole("heading", { name: "Google Drive連携" }).waitFor();
    await page.getByRole("button", { name: "Googleに接続", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Google Drive：接続済み・保存先確認済み" }).waitFor();
    assert.equal(geminiRequests, beforeShortcut);
    await page.reload();
    const persisted = await page.evaluate(() => ({
      config: JSON.parse(localStorage.getItem("studio-drive-public-config")),
      tokenStored: [...Object.values(localStorage), ...Object.values(sessionStorage)].some(data => data.includes("fixture-token")),
    }));
    assert.deepEqual(persisted.config, { clientId: "fixture.apps.googleusercontent.com", project: "123456", pickerKey: "no-real-key" });
    assert.equal(persisted.tokenStored, false);
    await page.locator("nav").getByRole("button", { name: "設定", exact: true }).click();
    assert.equal(await page.getByLabel("OAuthクライアントID").inputValue(), persisted.config.clientId);
    assert.equal(await page.getByLabel("Google Cloudプロジェクト番号").inputValue(), persisted.config.project);
    assert.equal(await page.getByLabel("Picker用ブラウザ制限キー").inputValue(), persisted.config.pickerKey);
    await page.getByRole("status").filter({ hasText: "Google Drive：未接続" }).waitFor();
    assert.deepEqual(errors, []);
    console.log("OK: Drive batch/retry, versioned metadata, saved browser settings, memory-only token");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
