import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** public/ に置いてあり、バンドルには現れないファイル。 */
const STATIC_FILES = ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

/**
 * ビルド後の実ファイル一覧を埋め込んだ Service Worker を生成する。
 *
 * 一覧を手で書かない理由は二つある。ファイル名にハッシュが付くので毎回変わること、
 * そして WASM エンコーダは動的 import で読み込まれるため、一覧に入れておかないと
 * 一度も変換していない端末ではオフラインで変換できないこと。
 *
 * キャッシュ名にはファイル一覧のハッシュを使う。デプロイして中身が変われば
 * 名前が変わり、古い世代は activate 時にまとめて捨てられる。
 */
export function serviceWorker(): Plugin {
  return {
    name: "podcast-br-sw",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name !== "index.html");
      // "./" は index.html のこと。ナビゲーションはこの URL で解決される
      const precache = ["./", ...assets, ...STATIC_FILES].sort();
      const version = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 12);

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: renderSw(version, precache),
      });
    },
  };
}

function renderSw(version: string, precache: string[]): string {
  return `// 自動生成。sw-plugin.ts が出力しています。編集しても次のビルドで消えます。
const CACHE = "podcast-br-${version}";
const PRECACHE = ${JSON.stringify(precache, null, 2)};

// ハッシュ付きのファイル名は中身が変われば名前も変わるため、
// 一度キャッシュしたら再取得の必要がない。
const IMMUTABLE = /-[A-Za-z0-9_-]{8}\\.(?:js|css|wasm)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 一つ失敗しても残りは入れる(addAll は全滅するため個別に扱う)
      await Promise.all(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("podcast-br-") && n !== CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Gemini API など外部への通信には一切触らない
  if (url.origin !== self.location.origin) return;

  // ページ遷移は index.html を返す(SPA なのでパスに関係なく同じ)
  const target = req.mode === "navigate" ? new Request("./") : req;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(target);

      if (hit) {
        // 内容が変わりうるものだけ、裏で取り直して次回に備える
        if (!IMMUTABLE.test(url.pathname)) {
          event.waitUntil(
            fetch(target)
              .then((res) => (res.ok ? cache.put(target, res.clone()) : undefined))
              .catch(() => {}),
          );
        }
        return hit;
      }

      try {
        const res = await fetch(target);
        if (res.ok) event.waitUntil(cache.put(target, res.clone()));
        return res;
      } catch (err) {
        // オフラインで未キャッシュのものを要求された場合
        const fallback = await cache.match("./");
        if (req.mode === "navigate" && fallback) return fallback;
        throw err;
      }
    })(),
  );
});
`;
}
