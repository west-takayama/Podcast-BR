// 今回のパーソナリティ(出演者)を、聞く前に分かるようにする。
//
// Spotify の一覧では、再生を押す前に見えるのはタイトルと説明文の頭だけ。
// 「今日は誰が喋っているのか」はそこに無いと伝わらない。
//
// AI に書かせて済ませることもできるが、それだと**名前が落ちたり、
// 言い換えられたりする**。回によって顔ぶれが変わるものを取り違えると、
// 番組として誠実でない。なのでアプリ側で必ず1行足す。
// AI には「誰が出ているか」だけ伝えて、自分で出演者の行を書かないよう頼む。

/** 説明文の頭に付ける見出し。 */
export const CAST_LABEL = "出演";

/** 名前の区切りとして受け付ける文字。打ちやすさ優先で広く取る。 */
const SEPARATORS = /[、,，・･\n\r\t]+|\s{2,}/;

/**
 * 打ち込まれた文字列を名前の並びにする。
 *
 * 「たかやま、にし」「たかやま・にし」「たかやま, にし」など、
 * どう打っても同じ結果になるようにする。
 */
export function parseCast(raw: string): string[] {
  return raw
    .split(SEPARATORS)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * 説明文の頭に置く1行。出演者が無ければ空。
 *
 * 中黒で繋ぐ。日本語の名前の並びとしていちばん読みやすく、
 * 読点だと文の続きに見えてしまう。
 */
export function castLine(raw: string): string {
  const names = parseCast(raw);
  if (names.length === 0) return "";
  return `${CAST_LABEL}: ${names.join("・")}`;
}

/**
 * 説明文の頭に出演者を足す。
 *
 * 何度呼んでも増えないようにする。AI が気を利かせて自分で
 * 「出演:」を書いてくることがあり、そのときは**こちらの行で置き換える**
 * (手で直した出演者のほうが正しいため)。
 */
export function withCast(description: string, raw: string): string {
  const line = castLine(raw);
  const body = stripCastLine(description);
  if (!line) return body;
  if (!body.trim()) return line;
  return `${line}\n\n${body}`;
}

/** 先頭にある出演者の行を取り除く。 */
export function stripCastLine(description: string): string {
  const lines = description.split("\n");
  let at = 0;
  // 先頭の空行は飛ばす
  while (at < lines.length && lines[at].trim() === "") at++;
  if (at < lines.length && isCastLine(lines[at])) {
    at++;
    while (at < lines.length && lines[at].trim() === "") at++;
    return lines.slice(at).join("\n");
  }
  return description;
}

/** その行が出演者の行か。全角コロンや「出演者」表記も拾う。 */
function isCastLine(line: string): boolean {
  return /^\s*(出演者?|パーソナリティ|MC)\s*[:：]/.test(line);
}
