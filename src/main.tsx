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
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // 初回表示の通信と競合させない
    void navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
