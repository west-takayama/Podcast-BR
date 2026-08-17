// カバー画像を作らせるための「注文文」を組み立てる。
//
// アプリの中で画像を生成しない理由:
// 画像生成は有料の API が要る。すでに ChatGPT や Gemini を使っているなら、
// その契約のまま同じ絵が作れるほうが得だし、こちらに鍵を預けなくて済む。
// 生成した画像も端末から出ない。
//
// この文章の値打ちは「絵柄の指示」より**制約**のほうにある。
// ポッドキャストのカバーは一覧の中で 1〜2cm で表示される。そこで潰れない
// 作りにさせることと、日本語の文字を描かせないことが、実用と自己満足の差になる。

/** 絵柄の方向。番組の見た目を決めるので、選んだものは覚えておく。 */
export type CoverStyle = "photo" | "illustration" | "minimal" | "retro" | "collage";

export const COVER_STYLE_LABELS: Record<CoverStyle, string> = {
  photo: "写真風(実際の場面を撮ったような一枚)",
  illustration: "イラスト(平面的で色数の少ない絵)",
  minimal: "ミニマル(大きな図形と余白だけ)",
  retro: "レトロ印刷(リソグラフ・活版のようなざらつき)",
  collage: "コラージュ(切り貼りした紙のような質感)",
};

const STYLE_LINES: Record<CoverStyle, string[]> = {
  photo: [
    "実際にその場面を撮った写真のように。作り物めいた光沢や CG らしさを出さない。",
    "自然光。影の出方で立体を見せる。被写界深度は浅めにして、主役以外は軽くぼかす。",
  ],
  illustration: [
    "平面的なイラスト。輪郭線は太く、塗りは単色。グラデーションは使わない。",
    "遠くから見ても形が読み取れるよう、面を大きく取る。",
  ],
  minimal: [
    "大きな図形を2〜3個だけ置く。それ以外は無地の面にする。",
    "余白を恐れない。画面の半分以上が何も無くてよい。",
  ],
  retro: [
    "リソグラフや活版印刷のような、わずかに版がずれた印刷感。紙の粒子とインクのむらを出す。",
    "色は刷り重ねた2〜3版ぶんだけ。中間色を作らない。",
  ],
  collage: [
    "紙を手で切って貼ったような質感。切り口のざらつきと、重なった紙の影を出す。",
    "背景は無地の色紙。貼った要素の数は3つまで。",
  ],
};

export interface CoverPromptInput {
  /** その回のカバーか、番組そのもののカバーか。 */
  scope: "episode" | "show";
  style: CoverStyle;
  /** 採用したタイトル(その回のカバーのとき)。 */
  title?: string;
  /** 内容サマリー。何の話かを絵に落とすための材料。 */
  summary?: string;
  keywords?: string[];
  showName?: string;
  /** 設定の「番組の背景」。番組カバーではこれが主な材料になる。 */
  showContext?: string;
  /** アクセント色(#RRGGBB)。 */
  accent?: string;
  /**
   * AI に考えてもらった絵柄の案。選んだものだけ入る。
   * 題名だけを渡すと記号的な絵になりやすいので、情景まで決めてから注文する。
   */
  idea?: string;
}

/**
 * 色を言葉でも伝える。
 * 画像生成は #RRGGBB を読み飛ばすことがあるので、色名を添える。
 */
export function colorName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.08) return l > 0.75 ? "白に近い灰色" : l < 0.2 ? "黒に近い灰色" : "灰色";

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;

  const hues: [number, string][] = [
    [15, "赤"], [45, "オレンジ"], [70, "黄"], [150, "緑"],
    [200, "水色"], [255, "青"], [290, "紫"], [340, "ピンク"], [360, "赤"],
  ];
  const base = hues.find(([deg]) => h < deg)?.[1] ?? "赤";
  const light = l > 0.72 ? "明るい" : l < 0.3 ? "暗い" : "";
  const sat = d / (1 - Math.abs(2 * l - 1) || 1) < 0.4 ? "くすんだ" : "";
  return `${light}${sat}${base}`;
}

/** 注文の材料。空の行は落とす。 */
function subjectBlock(input: CoverPromptInput): string {
  const lines: string[] = [];
  if (input.scope === "show") {
    if (input.showName?.trim()) lines.push(`番組名: ${input.showName.trim()}`);
    if (input.showContext?.trim()) lines.push(`どんな番組か: ${input.showContext.trim()}`);
    lines.push("毎回このカバーを使います。特定の回の内容ではなく、番組全体の雰囲気を一枚にしてください。");
  } else {
    if (input.title?.trim()) lines.push(`この回のタイトル: 「${input.title.trim()}」`);
    if (input.summary?.trim()) lines.push(`話している内容: ${input.summary.trim()}`);
    const kw = (input.keywords ?? []).filter(Boolean).slice(0, 8);
    if (kw.length > 0) lines.push(`出てくる言葉: ${kw.join(" / ")}`);
    if (input.showName?.trim()) lines.push(`番組名: ${input.showName.trim()}(参考。画像には描かない)`);
  }
  return lines.join("\n");
}

export function buildCoverPrompt(input: CoverPromptInput): string {
  const accent = input.accent?.trim();
  const name = accent ? colorName(accent) : "";
  const sections: string[] = [];

  sections.push(
    input.scope === "show"
      ? "ポッドキャストの番組カバー画像を1枚作ってください。"
      : "ポッドキャストのエピソード用カバー画像を1枚作ってください。",
  );

  const subject = subjectBlock(input);
  if (subject) sections.push(`【題材】\n${subject}`);

  if (input.idea?.trim()) {
    sections.push(`【描く場面】\n${input.idea.trim()}`);
  } else {
    sections.push(
      input.scope === "show"
        ? `【描く場面】\n上の番組像を、記号ではなく具体的な物と場所に翻訳して一枚にしてください。何がそこに置いてあるか、どんな場所かで見せます。`
        : `【描く場面】\n上の内容を、記号ではなく具体的な物と場所に翻訳して一枚にしてください。「その話が実際に交わされている場」に何が置いてあるかで見せます。タイトルを図解しないでください。`,
    );
  }

  sections.push(`【絵柄】\n- ${STYLE_LINES[input.style].join("\n- ")}`);

  if (accent) {
    sections.push(
      `【色】\n- ${accent}(${name})を主役の色にしてください。\n` +
        `- 使う色は3色まで。この色が最初に目に入るようにします。`,
    );
  } else {
    sections.push(`【色】\n- 使う色は3色まで。1色を主役にして、残りは支えに回します。`);
  }

  // ここが本題。一覧に並んだ 1〜2cm のサムネイルで成立させるための条件
  sections.push(`【必ず守ること】
- 正方形(1:1)。3000×3000ピクセルで書き出してください。 Spotify と Apple Podcasts の推奨です。
- 一覧では 1〜2cm で表示されます。その大きさで何の絵か分かること。
  そのために、写す物は3つまで。形は大きく太く。細かい描き込みや小さな模様は入れない。
- 主役は中央に置き、四辺から10%は余白にしてください。角が丸く切られたり、再生ボタンが重なります。
- 明るい部分と暗い部分の差をはっきり付けてください。全体が同じ明るさだと縮めたときに潰れます。
- 並んでいる他の番組と見分けが付くこと。どこかで見た絵にしない。`);

  sections.push(`【入れないもの】
- 文字を一切入れないでください。${
    input.showName?.trim() ? `番組名(${input.showName.trim()})やタイトルも描かないこと。` : "題名やロゴも描かないこと。"
  }
  画像生成は日本語の文字をほぼ必ず崩します。文字はこちらであとから重ねます。
- マイク、ヘッドホン、音波・波形、ON AIR のランプ。
  ポッドキャストのカバーで最も使われていて、一覧に並ぶと全部同じに見えます。
- 実在の人物、既存のブランドのロゴ、透かし。`);

  sections.push(`【書き出し】
- JPEG か PNG、RGB、3000×3000ピクセル。`);

  return sections.join("\n\n");
}

/** どこに貼るかの案内。画面にも出すし、コピーには含めない。 */
export const COVER_USAGE_NOTE =
  "ChatGPT・Gemini・Copilot などの画像生成にそのまま貼り付けてください。文字は入らない絵が返るので、番組名やタイトルはあとから重ねます。";

/**
 * 選んだ絵柄を覚えておく。
 * 番組の見た目は毎回揃っているほうがよいので、回ごとに選び直させない。
 */
const STYLE_KEY = "podcast-br-cover-style";

export function loadCoverStyle(): CoverStyle {
  const saved = localStorage.getItem(STYLE_KEY);
  return saved && saved in COVER_STYLE_LABELS ? (saved as CoverStyle) : "photo";
}

export function saveCoverStyle(style: CoverStyle): void {
  localStorage.setItem(STYLE_KEY, style);
}
