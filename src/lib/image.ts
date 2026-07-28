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

export interface CardContent {
  quote: string; // 大きく載せる一言
  title: string;
  showName: string;
  accent: string; // #RRGGBB
  /** 背景に敷く AI イラスト。無ければ単色の背景になる。 */
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

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [29, 185, 84];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 音の波形を模した装飾。ポッドキャストであることを一目で伝える。 */
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  maxHeight: number,
  accent: string,
  seed: number,
): void {
  const bars = 34;
  const gap = width / bars;
  const barWidth = gap * 0.42;
  ctx.fillStyle = accent;
  for (let i = 0; i < bars; i++) {
    // 疑似乱数で自然な凹凸を作る(毎回同じ回なら同じ形になる)
    const n = Math.abs(Math.sin((i + 1) * 12.9898 + seed) * 43758.5453) % 1;
    const h = maxHeight * (0.18 + n * 0.82);
    ctx.globalAlpha = 0.35 + n * 0.5;
    const bx = x + i * gap;
    ctx.beginPath();
    ctx.roundRect(bx, y - h / 2, barWidth, h, barWidth / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function renderCard(spec: PresetSpec, content: CardContent): HTMLCanvasElement {
  const { width: W, height: H } = spec;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を描画できませんでした");

  const [r, g, b] = hexToRgb(content.accent);
  const accent = `rgb(${r}, ${g}, ${b})`;
  const pad = W * 0.085;
  const inner = W - pad * 2;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  if (content.background) {
    // 縦横比が違うプリセットでも歪ませないよう、短辺に合わせて切り出す
    const bg = content.background;
    const scale = Math.max(W / bg.width, H / bg.height);
    const dw = bg.width * scale;
    const dh = bg.height * scale;
    ctx.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);

    // 文字を確実に読ませるための暗幕。下ほど濃くして下部の情報を守る
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(8, 8, 8, 0.55)");
    scrim.addColorStop(0.45, "rgba(8, 8, 8, 0.72)");
    scrim.addColorStop(1, "rgba(8, 8, 8, 0.92)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } else {
    // イラストが無いときはアクセント色をごく薄く敷いて単調さを避ける
    const glow = ctx.createRadialGradient(W * 0.75, H * 0.12, 0, W * 0.75, H * 0.12, W * 0.9);
    glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.28)`);
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  // 縦長ほど余白が増えるので、中身の基準位置を高さに合わせて調整する
  const isTall = H / W > 1.3;
  const topAnchor = isTall ? H * 0.3 : pad * 1.5;

  ctx.textBaseline = "top";

  // 番組名
  let y = topAnchor;
  if (content.showName) {
    const size = W * 0.036;
    ctx.font = `600 ${size}px ${FONT_STACK}`;
    ctx.fillStyle = accent;
    ctx.fillText(`🎙 ${content.showName}`, pad, y);
    y += size * 1.9;
  }

  // 引用(この画像の主役)
  const quote = content.quote || content.title;
  const fitted = fitText(ctx, quote, inner, W * 0.115, 5);
  ctx.font = `bold ${fitted.size}px ${FONT_STACK}`;
  ctx.fillStyle = "#ffffff";
  const lineHeight = fitted.size * 1.45;
  for (const line of fitted.lines) {
    ctx.fillText(line, pad, y);
    y += lineHeight;
  }

  // アクセントの区切り線
  y += lineHeight * 0.25;
  ctx.fillStyle = accent;
  ctx.fillRect(pad, y, W * 0.16, Math.max(4, W * 0.008));
  y += W * 0.05;

  // タイトル(引用と別の文言のときだけ出す)
  if (content.title && content.title !== quote) {
    const t = fitText(ctx, content.title, inner, W * 0.045, 3, "500");
    ctx.font = `500 ${t.size}px ${FONT_STACK}`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    for (const line of t.lines) {
      ctx.fillText(line, pad, y);
      y += t.size * 1.5;
    }
  }

  // 波形は下部に固定して、文字量が変わってもレイアウトが崩れないようにする
  const seed = quote.length + content.title.length;
  drawWaveform(ctx, pad, H - pad - W * 0.03, inner, W * 0.1, accent, seed);

  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("画像の書き出しに失敗しました"))),
      "image/png",
    );
  });
}
