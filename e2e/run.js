// 画面ごしの検証をまとめて走らせる。
//
// 単体テスト(npm test)は部品の正しさを見る。こちらは**出来上がった物**を見る。
// 書き出した MP3 のバイト列、切り抜きの音、クリップボードの中身、画面の寸法。
// これまで見つかった不具合のほとんどは、ここでしか見えないものだった。
//
//   node e2e/run.js            全部
//   node e2e/run.js patrol-ui  1つだけ
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PORT = process.env.E2E_PORT || "4218";

/** 速い順に並べる。落ちたときに早く分かるように。 */
const ALL = [
  "load",         // 起動の速さ
  "polish",       // 画面の寸法(はみ出し・押せる大きさ)
  "heights",      // 画面の長さと、消すときの確認
  "patrol-ui",    // 全タブを開いて例外が出ないか
  "shortfall",    // 返しきれないときの粘りと記録
  "quota",        // 無料枠の上限(429)の扱い
  "photo-leak",   // 写真が次の回に漏れないか / MP3 のタグ
  "backup-audit", // 控えの書き出しと読み込み
  "clip-align",   // 切り抜きが頼んだ場所か
];

function ensureFixtures() {
  if (!fs.existsSync(path.join(HERE, "speechlike.wav"))) {
    console.log("音声のもとを作ります…");
    spawnSync("node", ["make-fixtures.js"], { cwd: HERE, stdio: "inherit" });
  }
}

function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", url], {
      encoding: "utf8",
    });
    if (r.stdout === "200") return true;
    spawnSync("sleep", ["0.5"]);
  }
  return false;
}

function hasPlaywright() {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

(async () => {
  if (!hasPlaywright()) {
    console.error(
      "playwright が入っていません。次の2行を実行してからお試しください。\n" +
        "  npm i -D playwright\n" +
        "  npx playwright install chromium",
    );
    process.exit(1);
  }
  const want = process.argv.slice(2);
  const list = want.length ? ALL.filter((n) => want.includes(n)) : ALL;
  if (list.length === 0) {
    console.error(`知らない名前です。使えるのは: ${ALL.join(" ")}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(HERE, "..", "dist", "index.html"))) {
    console.error("先に `npm run build` を実行してください。");
    process.exit(1);
  }
  ensureFixtures();

  const server = spawn("npx", ["vite", "preview", "--port", PORT, "--strictPort"], {
    cwd: path.join(HERE, ".."),
    stdio: "ignore",
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-server.pid);
    } catch {
      /* すでに終わっている */
    }
  };
  process.on("exit", stop);

  if (!waitForServer(`http://localhost:${PORT}/`)) {
    console.error(`localhost:${PORT} が上がりませんでした。`);
    stop();
    process.exit(1);
  }

  const failed = [];
  for (const name of list) {
    process.stdout.write(`${name.padEnd(14)} `);
    // 同時に走らせると端末が混んで、待ち時間切れで落ちることがある。順番に回す
    const r = spawnSync("node", [`${name}.js`, PORT], { cwd: HERE, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const line =
      out.split("\n").reverse().find((l) => /^(OK|FAIL|見つかったもの|磨きどころ|速い回線)/.test(l)) ??
      "(結果が読めません)";
    console.log(line.slice(0, 110));
    if (r.status !== 0) {
      failed.push(name);
      console.log(out.split("\n").filter((l) => l.trim()).slice(-12).map((l) => `    ${l}`).join("\n"));
    }
  }

  stop();
  console.log(failed.length ? `\n❌ 落ちた: ${failed.join(" ")}` : `\n✅ ${list.length}本すべて通過`);
  process.exit(failed.length ? 1 : 0);
})();
