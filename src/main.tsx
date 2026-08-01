import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 変換は端末内で完結するため、資材をキャッシュしておけば圏外でも使える。
// 起動も毎回のダウンロードを待たなくなる。開発時は sw.js を生成していない。
//
// 新しい版は自動で適用しない。処理の途中で入れ替わると、動いているページが
// 使う資材が消えて壊れるため、画面に知らせて押してもらってから切り替える。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        const notify = (worker: ServiceWorker | null) => {
          if (!worker || !navigator.serviceWorker.controller) return;
          window.dispatchEvent(
            new CustomEvent("sw-update", {
              detail: () => worker.postMessage({ type: "skip-waiting" }),
            }),
          );
        };
        // すでに待機している版がある場合(前回開いたときに落ちてきた分)
        notify(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const next = reg.installing;
          next?.addEventListener("statechange", () => {
            if (next.state === "installed") notify(next);
          });
        });
      })
      .catch(() => {});
  });

  // 交代が済んだら読み直す。押した直後にしか起きない
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
