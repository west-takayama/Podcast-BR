// チャプターの手直し。
//
// 時刻は端末側の解析で吸着させているが、**ラベルは AI が付けたまま**だった。
// 話題の切り出し方が違っていても直せず、そのまま Spotify に貼ることになる。
// MP3 にも同じものが埋まるので、間違いは配信先と手元の両方に残る。
//
// 画面で見せている「00:00 オープニング」の形をそのまま編集させて、
// 読み取り直す。行の追加も削除も並べ替えも、テキストとして自然にできる。

import { parseTimestamp } from "./id3";

export interface Chapter {
  time: string;
  label: string;
}

/** 画面に出している形。1行に1つ。 */
export function formatChapters(chapters: Chapter[]): string {
  return chapters.map((c) => `${c.time} ${c.label}`).join("\n");
}

/** 秒を "MM:SS" に整える。60分を超えても分表記のまま(例 "72:30")。 */
function toTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface ParsedChapters {
  chapters: Chapter[];
  /** 読み取れずに落とした行。何が起きたか伝えるために返す。 */
  dropped: string[];
}

/**
 * 編集された文字列をチャプターに戻す。
 *
 * 打ち間違いで全部を捨てると、直そうとして全部失う。読める行だけ拾い、
 * 読めなかった行は返して知らせる。
 */
export function parseChapters(text: string): ParsedChapters {
  const chapters: Chapter[] = [];
  const dropped: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // 先頭の時刻を取る。区切りは空白でも全角空白でもタブでもよい
    const m = /^(\d{1,3}:\d{1,2}(?::\d{1,2})?)[\s　]+(.+)$/.exec(line);
    if (!m) {
      dropped.push(line);
      continue;
    }
    const ms = parseTimestamp(m[1]);
    if (ms === null) {
      dropped.push(line);
      continue;
    }
    chapters.push({ time: toTimecode(ms), label: m[2].trim() });
  }

  // 時刻順に並べ直す。打ち足した行が途中に入っても正しい順で埋まる
  chapters.sort((a, b) => (parseTimestamp(a.time) ?? 0) - (parseTimestamp(b.time) ?? 0));
  return { chapters, dropped };
}
