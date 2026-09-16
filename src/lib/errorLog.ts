// 失敗の控え。
//
// 「エラーが多い」と感じても、**どの種類がどれだけ出ているか**は分からない。
// 混雑(503)なのか、無料枠の上限(429)なのか、返ってきた中身が読めなかったのか。
// 原因ごとに打つ手が違うのに、画面に出るのは最後の1件だけで、閉じれば消える。
//
// 起きたことをその場で控えておけば、あとから種類と回数が分かる。
// 端末の中だけに残り、外へは送らない。

const KEY = "podcast-br-errors";
const MAX = 30;

export interface ErrorEntry {
  at: number;
  /** 何をしていたときか(変換・お題・絵柄など)。 */
  what: string;
  /** 画面に出した文言。 */
  message: string;
  /** そのとき使っていたモデル。 */
  model?: string;
}

/** 種類を大づかみに分ける。打つ手が変わる単位。 */
export type ErrorKind = "混雑" | "無料枠の上限" | "結果が読めない" | "通信" | "キー" | "その他";

export function classify(message: string): ErrorKind {
  if (/混雑|503|504/.test(message)) return "混雑";
  if (/上限|429/.test(message)) return "無料枠の上限";
  if (/読めません|切れました|含まれていません|返りませんでした/.test(message)) return "結果が読めない";
  if (/接続できません|通信/.test(message)) return "通信";
  if (/APIキー|許可されていません/.test(message)) return "キー";
  return "その他";
}

export function recordError(what: string, message: string, model?: string): void {
  try {
    const list = loadErrors();
    list.unshift({ at: Date.now(), what, message: message.slice(0, 300), model });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // 控えられなくても、本来の処理には関係がない
  }
}

export function loadErrors(): ErrorEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ErrorEntry[]) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.message === "string") : [];
  } catch {
    return [];
  }
}

export function clearErrors(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 消せなくても実害はない
  }
}

/** 種類ごとの件数。多い順。 */
export function summarize(list: ErrorEntry[]): { kind: ErrorKind; count: number }[] {
  const counts = new Map<ErrorKind, number>();
  for (const e of list) {
    const k = classify(e.message);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}

/** そのまま貼って渡せる形。原因を切り分けるのに要る情報だけ。 */
export function errorsAsText(list: ErrorEntry[]): string {
  if (list.length === 0) return "記録はありません。";
  const fmt = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const head = summarize(list)
    .map((s) => `${s.kind} ${s.count}件`)
    .join(" / ");
  return [
    `直近${list.length}件: ${head}`,
    "",
    ...list.map((e) => `${fmt(e.at)} [${classify(e.message)}] ${e.what}${e.model ? ` (${e.model})` : ""}\n  ${e.message}`),
  ].join("\n");
}

/**
 * 画面に出す文言を返しつつ、控えに残す。
 *
 * 失敗を握る場所が十数か所ある。それぞれで控えを書き足すと必ず書き漏れるので、
 * 「文言を取り出す」ところと一緒にしておく。
 */
export function noteError(what: string, err: unknown, model?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  recordError(what, message, model);
  return message;
}
