// ChatGPT(や他の画像生成)に貼るための注文文を組み立てる。
//
// アプリから画像生成 API を叩くのではなく文章を渡す形にした理由:
// OpenAI の画像 API は有料で、利用者に別のキーと課金設定を用意させることになる。
// すでに ChatGPT を契約しているなら、その契約のまま同じ絵が作れるほうが得。
//
// 文字を絵の中に描かせる前提なので、崩れやすい点を先に潰す指示を入れている。
// 日本語の題名を「一字一句そのまま」と明示し、余計な文字を描かせない。

export interface ImagePromptInput {
  /** 画像の主役にする文字。採用したタイトルか、印象的な一言。 */
  headline: string;
  /** 番組名。空なら触れない。 */
  showName: string;
  /** 絵柄の題材(要約やキーワード)。 */
  subject?: string;
  /** ブランドカラー(#RRGGBB)。 */
  accent: string;
  /** 縦横比。用途に合わせて言葉で伝える。 */
  shape: "square" | "story";
}

const SHAPE_LABEL: Record<ImagePromptInput["shape"], string> = {
  square: "正方形(1:1)。Instagram のフィード投稿とポッドキャストのカバー画像に使います",
  story: "縦長(9:16)。Instagram のストーリーズに使います",
};

/**
 * そのまま貼れば画像が出てくる文にする。
 * 箇条書きにしているのは、崩れたときにどの条件が効かなかったか分かるようにするため。
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const { headline, showName, subject, accent, shape } = input;
  const lines: string[] = [];

  lines.push("ポッドキャストの告知画像を1枚作ってください。");
  lines.push("");
  lines.push("【画像に入れる文字(一字一句そのまま・改変しないでください)】");
  lines.push(`「${headline}」`);
  if (showName) lines.push(`小さく: 「${showName}」`);
  lines.push("");
  lines.push("【文字の条件】");
  lines.push("- 上の文字を、日本語のまま正確に描いてください。誤字・脱字・別の字への置き換えは不可です。");
  lines.push("- 指定した文字以外は入れないでください(英語のキャッチコピー、透かし、URL、日付、ロゴなどを勝手に足さない)。");
  lines.push("- 主役は文字です。画面の中で最も大きく、離れて見ても読める太さにしてください。");
  lines.push("- 文字が背景と同化しないように、背景側を落ち着かせるか帯を敷いてください。");
  lines.push("");
  lines.push("【デザイン】");
  lines.push(`- 配色は黒地に ${accent} のアクセント。差し色は1色だけに絞ってください。`);
  lines.push("- 落ち着いた大人向けのトーン。にぎやかな装飾や絵文字は使わないでください。");
  if (subject) lines.push(`- 話している内容: ${subject}`);
  lines.push("- 内容が伝わる図や質感を背景に置いてください。人物の顔は入れないでください。");
  lines.push(`- ${SHAPE_LABEL[shape]}。`);
  lines.push("");
  lines.push("文字が崩れた場合は、崩れた箇所だけ直して描き直してください。");

  return lines.join("\n");
}
