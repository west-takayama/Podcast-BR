// アプリの見た目を番組のブランドカラーに合わせる。
// 告知画像とアプリで色が違うと、どれが自分の色か分からなくなるため揃える。

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function shade(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * factor))),
  );
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** アクセント色と、その上に載せる文字色(明度から判定)を CSS 変数へ反映する。 */
export function applyAccent(hex: string): void {
  const root = document.documentElement;
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--accent-dark", shade(hex, 0.82));
  // 黄色のような明るい色の上では白文字が読めないため、黒寄りの文字にする
  root.style.setProperty("--on-accent", luminance(hex) > 0.4 ? "#141000" : "#ffffff");
}
