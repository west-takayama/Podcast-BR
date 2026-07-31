// SNS告知画像の生成。端末内の Canvas で描くため、API 費用も通信も発生しない。
//
// AI に絵を描かせる方式は採らなかった。ポッドキャストの告知で効くのは
// 「何が語られたか」が一目で伝わる言葉であり、回ごとに絵柄が変わると
// 番組としての見た目の統一感が失われるため。

export type Preset = "square" | "story" | "cover";

export interface PresetSpec {
  id: Preset;
  label: string;
  width: number;
  height: number;
  note: string;
}

export const PRESETS: PresetSpec[] = [
  { id: "square", label: "正方形", width: 1080, height: 1080, note: "Instagram フィード投稿" },
  { id: "story", label: "ストーリー", width: 1080, height: 1920, note: "ストーリーズ / リール" },
  { id: "cover", label: "カバー画像", width: 3000, height: 3000, note: "Spotify エピソード画像" },
];

/**
 * 文字の載せ方。素材(背景画像)の見せ方と、文字の読みやすさの折り合いが
 * 回ごとに違うため、選べるようにしている。
 */
export type Template = "band" | "full" | "minimal";

export interface TemplateSpec {
  id: Template;
  label: string;
  note: string;
}

export const TEMPLATES: TemplateSpec[] = [
  { id: "band", label: "帯", note: "下に帯を敷いて文字を置く。絵を大きく見せたいとき" },
  { id: "full", label: "全面", note: "画面いっぱいに文字。言葉を主役にしたいとき" },
  { id: "minimal", label: "余白", note: "絵をほぼそのまま見せ、下に小さく添える" },
];

export interface CardContent {
  quote: string; // 大きく載せる一言
  title: string;
  showName: string;
  accent: string; // #RRGGBB
  /** 背景に敷く AI イラスト。無ければ単色の背景になる。 */
  background?: CanvasImageSource & { width: number; height: number };
  /** 文字の載せ方。既定は「帯」。 */
  template?: Template;
}

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif`;

/**
 * 日本語向けの折り返し。単語区切りが無いため文字単位で測って折る。
 * 行頭に句読点や閉じ括弧が来ないよう最低限の禁則処理を入れている。
 */
const NO_LINE_START = "、。，．・）」』】〉》〕｝!?！？ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ";
const NO_LINE_END = "（「『【〈《〔｛";

export function wrapJapanese(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      const candidate = line + char;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        // 行頭に置けない文字なら、直前の1文字を次の行へ送る
        if (NO_LINE_START.includes(char) && line.length > 1) {
          lines.push(line.slice(0, -1));
          line = line.slice(-1) + char;
        } else if (NO_LINE_END.includes(line.slice(-1)) && line.length > 1) {
          lines.push(line.slice(0, -1));
          line = line.slice(-1) + char;
        } else {
          lines.push(line);
          line = char;
        }
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** 指定の行数に収まるまで文字サイズを下げる。 */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  maxLines: number,
  weight = "bold",
): { size: number; lines: string[] } {
  let size = startSize;
  for (let i = 0; i < 40; i++) {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
    const lines = wrapJapanese(ctx, text, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
    size = Math.round(size * 0.92);
  }
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
  return { size, lines: wrapJapanese(ctx, text, maxWidth).slice(0, maxLines) };
}

/**
 * 字間。日本語の見出しは詰め気味のほうが締まって見える。
 * letterSpacing は比較的新しい API なので、無い環境では黙って無視される。
 */
function setTracking(ctx: CanvasRenderingContext2D, px: number): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = `${px}px`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [29, 185, 84];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 背景を敷く。縦横比が違うプリセットでも歪ませないよう短辺に合わせて切り出す。
 * 画像が無いときは、アクセント色をごく薄く効かせた単色にする。
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  content: CardContent,
  rgb: [number, number, number],
): void {
  const [r, g, b] = rgb;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  const bg = content.background;
  if (bg) {
    const scale = Math.max(W / bg.width, H / bg.height);
    ctx.drawImage(bg, (W - bg.width * scale) / 2, (H - bg.height * scale) / 2, bg.width * scale, bg.height * scale);
    return;
  }
  const glow = ctx.createRadialGradient(W * 0.72, H * 0.15, 0, W * 0.72, H * 0.15, W * 0.95);
  glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.3)`);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

/** 番組名。小さく、字間を開けて、見出しの前に置く。 */
function drawShowName(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
): number {
  if (!text) return y;
  setTracking(ctx, size * 0.14);
  ctx.font = `700 ${size}px ${FONT_STACK}`;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  setTracking(ctx, 0);
  return y + size * 1.05;
}

/**
 * 見出しを描く。行間は 1.3。日本語の見出しは行間を空けすぎると
 * 一続きの言葉に見えなくなるため、既定の 1.45 から詰めた。
 */
function drawHeadline(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  size: number,
  color = "#ffffff",
): number {
  setTracking(ctx, -size * 0.02);
  ctx.font = `bold ${size}px ${FONT_STACK}`;
  ctx.fillStyle = color;
  const lineHeight = size * 1.3;
  let cursor = y;
  for (const line of lines) {
    ctx.fillText(line, x, cursor);
    cursor += lineHeight;
  }
  setTracking(ctx, 0);
  return cursor;
}

export function renderCard(spec: PresetSpec, content: CardContent): HTMLCanvasElement {
  const { width: W, height: H } = spec;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を描画できませんでした");

  const rgb = hexToRgb(content.accent);
  const [r, g, b] = rgb;
  const accent = `rgb(${r}, ${g}, ${b})`;
  const pad = W * 0.078;
  const inner = W - pad * 2;
  const template = content.template ?? "band";
  const quote = content.quote || content.title;

  // ストーリーは上下に SNS の UI が重なるため、その内側に収める
  const isStory = H / W > 1.5;
  const safeBottom = isStory ? H * 0.14 : pad;

  drawBackground(ctx, W, H, content, rgb);
  ctx.textBaseline = "top";

  if (template === "band") {
    // --- 帯: 絵を大きく見せ、下に敷いた面の中だけで文字を読ませる ---
    const showSize = W * 0.032;
    const head = fitText(ctx, quote, inner, W * 0.078, 3);
    const headBlock = head.lines.length * head.size * 1.3;
    const rule = Math.max(4, W * 0.0075);
    const bandPad = W * 0.075;
    const bandHeight =
      bandPad + (content.showName ? showSize * 1.05 + W * 0.03 : 0) + headBlock + bandPad * 0.9;
    const bandTop = H - safeBottom - bandHeight;

    // 帯の上端が硬い線にならないよう、少し上から溶かす
    const fade = ctx.createLinearGradient(0, bandTop - H * 0.09, 0, bandTop);
    fade.addColorStop(0, "rgba(8, 8, 8, 0)");
    fade.addColorStop(1, "rgba(8, 8, 8, 0.88)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, bandTop - H * 0.09, W, H * 0.09);
    ctx.fillStyle = "rgba(8, 8, 8, 0.9)";
    ctx.fillRect(0, bandTop, W, H - bandTop);

    // 帯の上端に細線を通す。これが無いと暗い絵では帯が「ただの暗がり」に見える
    ctx.fillStyle = accent;
    ctx.fillRect(0, bandTop, W, Math.max(3, W * 0.005));
    // 左端の縦線で番組の色を効かせる
    ctx.fillRect(pad - W * 0.028, bandTop + bandPad, rule, bandHeight - bandPad * 1.9);

    let y = bandTop + bandPad;
    y = drawShowName(ctx, content.showName, pad, y, showSize, accent);
    if (content.showName) y += W * 0.03;
    drawHeadline(ctx, head.lines, pad, y, head.size);
  } else if (template === "full") {
    // --- 全面: 言葉が主役。絵は質感として残す ---
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(8, 8, 8, 0.62)");
    scrim.addColorStop(0.5, "rgba(8, 8, 8, 0.74)");
    scrim.addColorStop(1, "rgba(8, 8, 8, 0.93)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);

    const showSize = W * 0.034;
    const head = fitText(ctx, quote, inner, W * 0.098, 4);
    const headBlock = head.lines.length * head.size * 1.3;
    const rule = Math.max(5, W * 0.009);
    const titleShown = content.title && content.title !== quote;
    const t = titleShown ? fitText(ctx, content.title, inner, W * 0.04, 2, "500") : null;
    const titleBlock = t ? W * 0.055 + t.lines.length * t.size * 1.5 : 0;
    const total =
      (content.showName ? showSize * 1.05 + W * 0.045 : 0) + headBlock + titleBlock;

    // 上下の余白を釣り合わせる。文字量が変わっても重心がぶれない
    let y = Math.max(pad * 1.2, (H - total) / 2);
    y = drawShowName(ctx, content.showName, pad, y, showSize, accent);
    if (content.showName) y += W * 0.045;
    y = drawHeadline(ctx, head.lines, pad, y, head.size);
    if (t) {
      y += W * 0.03;
      ctx.fillStyle = accent;
      ctx.fillRect(pad, y, W * 0.13, rule);
      y += W * 0.025 + rule;
      setTracking(ctx, 0);
      ctx.font = `500 ${t.size}px ${FONT_STACK}`;
      ctx.fillStyle = "rgba(255, 255, 255, 0.74)";
      for (const line of t.lines) {
        ctx.fillText(line, pad, y);
        y += t.size * 1.5;
      }
    }
  } else {
    // --- 余白: 絵をほぼそのまま見せ、下端に最小限だけ添える ---
    const showSize = W * 0.028;
    const head = fitText(ctx, quote, inner, W * 0.064, 3, "700");
    const headBlock = head.lines.length * head.size * 1.3;
    const barHeight = W * 0.06 + (content.showName ? showSize * 1.05 + W * 0.022 : 0) + headBlock + W * 0.06;
    const barTop = H - safeBottom - barHeight;

    const fade = ctx.createLinearGradient(0, barTop - H * 0.16, 0, barTop + barHeight);
    fade.addColorStop(0, "rgba(8, 8, 8, 0)");
    fade.addColorStop(1, "rgba(8, 8, 8, 0.82)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, barTop - H * 0.16, W, barHeight + H * 0.16);

    let y = barTop + W * 0.06;
    y = drawShowName(ctx, content.showName, pad, y, showSize, accent);
    if (content.showName) y += W * 0.022;
    setTracking(ctx, 0);
    ctx.font = `700 ${head.size}px ${FONT_STACK}`;
    ctx.fillStyle = "#ffffff";
    for (const line of head.lines) {
      ctx.fillText(line, pad, y);
      y += head.size * 1.3;
    }
    // 下端のアクセント線。番組として並んだときの目印になる
    ctx.fillStyle = accent;
    ctx.fillRect(0, H - Math.max(6, W * 0.011), W, Math.max(6, W * 0.011));
  }

  return canvas;
}

/**
 * 取り込んだ画像を、文字を重ねずにプリセットの寸法へ収める。
 *
 * ChatGPT などで題名まで描いてもらった画像を使う場合、こちらで文字を重ねると
 * 二重になる。縦横比が違うプリセットに合わせる切り出しだけを行う。
 */
export function renderPlainImage(
  spec: PresetSpec,
  image: CanvasImageSource & { width: number; height: number },
): HTMLCanvasElement {
  const { width: W, height: H } = spec;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を描画できませんでした");

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);
  // 短辺に合わせて拡大し、はみ出す分を均等に切る(歪ませない)
  const scale = Math.max(W / image.width, H / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return canvas;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("画像の書き出しに失敗しました"))),
      type,
      quality,
    );
  });
}

/**
 * MP3 に埋め込むアートワーク。
 * PNG のままだと 3000px で 4MB を超えて音声ファイルを不必要に重くするため、
 * 1400px の JPEG にする(Spotify の推奨サイズでもある)。
 */
export async function renderArtworkJpeg(content: CardContent): Promise<Uint8Array> {
  const spec: PresetSpec = {
    id: "cover",
    label: "アートワーク",
    width: 1400,
    height: 1400,
    note: "MP3 埋め込み用",
  };
  const blob = await canvasToBlob(renderCard(spec, content), "image/jpeg", 0.85);
  return new Uint8Array(await blob.arrayBuffer());
}
