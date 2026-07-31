// 告知画像の素材を作るための注文文を組み立てる。
//
// アプリから画像生成 API を叩くのではなく文章を渡す形にした理由:
// OpenAI の画像 API は有料で、利用者に別のキーと課金設定を用意させることになる。
// すでに ChatGPT を契約しているなら、その契約のまま同じ絵が作れるほうが得。
//
// 狙いは「その回の話が実際に交わされている場面」の写真を作らせること。
// 抽象的なイラストは無難だが、何の回なのか伝わらず素通りされる。
// 具体的な物と場所が写っていると、聴く前から中身が想像できる。

/**
 * 何を作らせるか。
 * "background" は文字を載せる前提の素材(題名はアプリが重ねる)。
 * "poster" は題名まで画像の中に描かせる(崩れることがある)。
 */
export type PromptMode = "background" | "poster";

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
  /** 既定は素材づくり(文字はアプリが載せる)。 */
  mode?: PromptMode;
  /** 設定の話者欄。写す人数を決めるために使う。 */
  speakers?: string;
}

/** 話者欄から人数を数える。空なら2人(トーク番組の既定)。 */
function speakerCount(speakers?: string): number {
  const names = (speakers ?? "")
    .split(/[,、\/・\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? Math.min(names.length, 4) : 2;
}

function aspectLine(shape: ImagePromptInput["shape"]): string {
  return shape === "story"
    ? "- 縦長(9:16)。Instagram のストーリーズに使います。"
    : "- 正方形(1:1)。Instagram の投稿とポッドキャストのカバー画像に使います。";
}

/** 画面のどこを空けておくか。あとから題名を重ねるため。 */
function clearAreaLine(shape: ImagePromptInput["shape"]): string {
  return shape === "story"
    ? "- 画面の下半分は、物や暗がりなど落ち着いた面にしてください。あとから文字を重ねます。"
    : "- 画面の下 3分の1 は、物や暗がりなど落ち着いた面にしてください。あとから文字を重ねます。";
}

/**
 * 情景そのものを指定する部分。両モードで共通。
 *
 * 「タイトルを絵にして」だと記号的な絵になりやすいので、
 * 「その話が実際に交わされている場面に翻訳する」と手順で伝えている。
 */
function sceneLines(input: ImagePromptInput): string[] {
  const { headline, subject, accent, speakers } = input;
  const people = speakerCount(speakers);
  const lines: string[] = [];

  lines.push("【この回の内容】");
  lines.push(`タイトル: 「${headline}」`);
  if (subject) lines.push(`話している内容: ${subject}`);
  lines.push("");
  lines.push("【どんな写真にするか】");
  lines.push(
    "- 上の内容を「その話が実際に交わされている場面」に翻訳して、一枚の写真として撮ってください。",
  );
  lines.push(
    "- 記号的な比喩やアイコンではなく、具体的な物と場所で見せてください(何がテーブルに並んでいるか、どこで話しているか、手に何を持っているか)。",
  );
  lines.push(
    `- 登場人物は日本人 ${people}人。実際に会話や作業をしている自然な姿にしてください(カメラ目線にしない、決めポーズにしない)。`,
  );
  lines.push("- 手前には、話題そのものを表す物を実際に並べてください。");
  lines.push("- 場所や小道具は、内容に合うものをそちらで考えて構いません。");
  lines.push("");
  lines.push("【写真の質感】");
  lines.push("- イラストや CG ではなく、実写の写真として仕上げてください。");
  lines.push("- 50mm 相当・f/2.0 程度。手前にピントを置き、奥は柔らかくぼかす。");
  lines.push("- 暖色の間接照明。落ち着いた明るさで、影をきれいに残す。");
  lines.push("- 肌や物の質感を自然に。加工っぽい仕上がりにしない。");
  lines.push("");
  lines.push("【色】");
  lines.push(
    `- 番組の差し色は ${accent} です。小物や照明にさりげなく入れられれば入れてください(不自然になるなら無理に入れないでください)。`,
  );

  return lines;
}

/**
 * そのまま貼れば画像が出てくる文にする。
 * 箇条書きにしているのは、思ったものと違ったときに、どの条件が
 * 効かなかったのかを1行ずつ直せるようにするため。
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const { headline, showName, shape, mode = "background" } = input;
  const lines: string[] = [];

  lines.push("ポッドキャストの告知に使う写真を1枚作ってください。");
  lines.push("");
  lines.push(...sceneLines(input));
  lines.push("");

  if (mode === "poster") {
    lines.push("【画像に入れる文字(一字一句そのまま・改変しないでください)】");
    lines.push(`「${headline}」`);
    if (showName) lines.push(`小さく: 「${showName}」`);
    lines.push("- 上の文字を、日本語のまま正確に描いてください。誤字・脱字・別の字への置き換えは不可です。");
    lines.push("- 指定した文字以外は入れないでください(英語のキャッチコピー、透かし、URL、日付、ロゴを勝手に足さない)。");
    lines.push("- 文字が背景と同化しないよう、文字の下は落ち着いた面にしてください。");
  } else {
    lines.push("【文字について】");
    lines.push("- 題名やロゴを画像に載せないでください。あとからこちらで重ねます。");
    lines.push(
      "- 場面に自然にある文字(ホワイトボードの手書き、紙のメモ、商品のラベルなど)は入れて構いません。ただし日本語として正しく書いてください。崩れるくらいなら文字は省いてください。",
    );
  }

  lines.push("");
  lines.push("【構図】");
  lines.push(aspectLine(shape));
  if (mode === "background") lines.push(clearAreaLine(shape));
  lines.push("");
  lines.push(
    mode === "poster"
      ? "文字が崩れた場合は、崩れた箇所だけ直して描き直してください。"
      : "思ったものと違う場合は、場所と小道具を変えてもう一度作ってください。",
  );

  return lines.join("\n");
}
