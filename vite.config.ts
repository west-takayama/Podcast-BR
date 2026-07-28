import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages はサブパス配信のため相対パスでビルドする
export default defineConfig({
  base: "./",
  plugins: [react()],
  // Worker が WASM エンコーダを動的に読み込むため、コード分割できる ES 形式にする
  worker: { format: "es" },
});
