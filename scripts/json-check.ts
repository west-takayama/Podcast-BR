// 「生成結果の形式が読めませんでした」がどんなときに出るかを確かめる。
//
// 本文から JSON を取り出す部分は、これまで「最初の { から最後の } まで」で
// 切っていた。前に文が付いていて、その中に { が混ざっていると、そこから
// 切り出してしまって読めない。途中で切れた応答も同じく全滅する。
//
// 途中で切れた場合、**題名と説明文は先頭にあるので残っていることが多い**。
// 全部捨てるより、読める分だけ拾うほうが利用者の損が小さい。
import { __testExtractJson } from "../src/lib/gemini";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const META = {
  titles: ["ねぎ塩だれを作りすぎた回", "余った日々"],
  description: "自作のねぎ塩だれが余って、毎食にかけ続けた話。",
  showNotes: "- 作りすぎ\n- 消費の日々",
  chapters: [{ time: "00:00", label: "オープニング" }, { time: "05:20", label: "本題" }],
  hashtags: ["#雑談", "#自炊"],
  transcriptSummary: "たれが余った。",
  keywords: ["ねぎ塩", "作り置き"],
  clips: [{ start: "05:00", end: "05:40", hook: "また かけてる", why: "笑いが起きている" }],
};
const JSON_TEXT = JSON.stringify(META, null, 2);

const take = (text: string) => {
  try {
    return { got: __testExtractJson(text, "生成結果") as Record<string, unknown>, err: "" };
  } catch (e) {
    return { got: null, err: e instanceof Error ? e.message : String(e) };
  }
};
const titleOf = (r: ReturnType<typeof take>) =>
  (r.got?.titles as string[] | undefined)?.[0] ?? `(読めず: ${r.err.slice(0, 30)})`;

console.log("=== そのまま返ってきた ===");
{
  const r = take(JSON_TEXT);
  check("読める", titleOf(r) === META.titles[0], titleOf(r));
}

console.log("\n=== コードブロックで囲まれている ===");
{
  const r = take("```json\n" + JSON_TEXT + "\n```");
  check("読める", titleOf(r) === META.titles[0], titleOf(r));
}

console.log("\n=== 前に文が付いている ===");
{
  const r = take("承知しました。以下が生成結果です。\n\n" + JSON_TEXT);
  check("読める", titleOf(r) === META.titles[0], titleOf(r));
}

console.log("\n=== 前の文に { が混ざっている(考えている途中の書き出しなど) ===");
{
  const pre = "まず構成を考えます。形は { titles, description, chapters } の順。\n以下が結果です。\n";
  const r = take(pre + JSON_TEXT);
  check("前の { に釣られない", titleOf(r) === META.titles[0], titleOf(r));
}

console.log("\n=== 後ろに文が付いている ===");
{
  const r = take(JSON_TEXT + "\n\n以上です。ご確認ください。}");
  check("後ろの } に釣られない", titleOf(r) === META.titles[0], titleOf(r));
}

console.log("\n=== 途中で切れた(配列の途中) ===");
{
  const cut = JSON_TEXT.slice(0, JSON_TEXT.indexOf('"hashtags"'));
  const r = take(cut);
  check("題名は拾える", titleOf(r) === META.titles[0], titleOf(r));
  check("説明文も拾える", typeof r.got?.description === "string" && (r.got.description as string).length > 5);
  const ch = r.got?.chapters as unknown[] | undefined;
  check("読めたところまでは残る", Array.isArray(ch) && ch.length >= 1, `チャプター ${ch?.length ?? 0}件`);
}

console.log("\n=== 途中で切れた(文字列の途中) ===");
{
  const cut = JSON_TEXT.slice(0, JSON_TEXT.indexOf("毎食") + 2);
  const r = take(cut);
  check("題名は拾える", titleOf(r) === META.titles[0], titleOf(r));
}

console.log("\n=== 途中で切れた(題名の途中。ここは諦めてよい) ===");
{
  const cut = JSON_TEXT.slice(0, 30);
  const r = take(cut);
  check("読めないと分かる", r.got === null || !(r.got.titles as string[])?.length, r.err.slice(0, 40));
}

console.log("\n=== JSON がまったく無い ===");
{
  const r = take("すみません、音声を聞き取れませんでした。");
  check("読めないと伝える", r.got === null, r.err.slice(0, 40));
  check("何が返ってきたかを添える", r.err.includes("すみません"), r.err.slice(0, 60));
}

console.log("\n=== 空 ===");
{
  const r = take("");
  check("落ちない", r.got === null, r.err.slice(0, 40));
}

console.log(failures === 0 ? "\n✅ ALL OK\n" : `\n❌ ${failures} 件失敗\n`);
process.exit(failures === 0 ? 0 : 1);
