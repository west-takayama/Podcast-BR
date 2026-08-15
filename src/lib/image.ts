// MP3 に埋め込むカバー画像を端末内の Canvas で描く。
// 配信アプリの一覧に出るのはこの絵なので、番組名と回のタイトルを載せる。
//
// もとは SNS 告知画像も同じ仕組みで作っていたが、使われないので外した。
// 残っているのはカバー画像に要るぶんだけ。

interface Size {
  width: number;
  height: number;
}

export interface CardContent {
  title: string;
  showName: string;
  accent: string; // #RRGGBB
  /** 背景に敷く写真。無ければ単色の背景になる。 */
  background?: CanvasImageSource & { width: number; height: number };
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

/** カバー画像を描く。下に帯を敷き、その中で番組名とタイトルを読ませる。 */
function renderCard(spec: Size, content: CardContent): HTMLCanvasElement {
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
  const quote = content.title;

  const safeBottom = pad;

  drawBackground(ctx, W, H, content, rgb);
  ctx.textBaseline = "top";

  // 絵を大きく見せ、下に敷いた面の中だけで文字を読ませる
  {
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
  }

  return canvas;
}

function canvasToBlob(
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
  const blob = await canvasToBlob(
    renderCard({ width: 1400, height: 1400 }, content),
    "image/jpeg",
    0.85,
  );
  return new Uint8Array(await blob.arrayBuffer());
}
