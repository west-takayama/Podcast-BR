// 過去回の横断検索。
//
// 回が溜まってくると「あの話、どの回だっけ」が思い出せなくなる。
// 一番おいしい30秒は最新回にあるとは限らないので、探せないと
// 過去回はそのまま埋もれる。ここが引けると、回が増えるほど
// 切り抜きの持ち球が増えていく。
//
// 端末内の検索だけで完結する(通信なし)。

import type { EpisodeRecord } from "./history";
import { parseTimestamp } from "./id3";

export interface Hit {
  episodeId: string;
  episodeTitle: string;
  createdAt: number;
  /** 書き起こしの中で見つかった場合の位置(秒)。メタデータの一致では null。 */
  atSec: number | null;
  speaker: string;
  /** 一致した箇所を含む文。 */
  text: string;
  /** どこで見つかったか。切り抜きに使えるのは書き起こしだけ。 */
  where: "transcript" | "title" | "chapter" | "notes";
  /** その回の音声が端末に残っているか。残っていればその場で切り抜ける。 */
  hasAudio: boolean;
}

export interface SearchResult {
  hits: Hit[];
  /** 書き起こしを持っている回の数。検索できる範囲を示すために返す。 */
  searchableEpisodes: number;
  totalEpisodes: number;
}

/**
 * 比較用に文字をならす。
 *
 * 日本語には単語の区切りが無いので、単純な部分一致で引く。
 * そのぶん「ネギ塩」と「ねぎしお」が別物にならないよう、
 * カタカナはひらがなへ寄せ、全角英数と大文字小文字も畳む。
 */
export function normalize(text: string): string {
  return text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[ー－―‐]/g, "ー")
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** 空白区切りの語すべてを含むか(AND)。 */
function matches(haystack: string, terms: string[]): boolean {
  const n = normalize(haystack);
  return terms.every((t) => n.includes(t));
}

const MAX_HITS = 60;

export function searchEpisodes(records: EpisodeRecord[], query: string): SearchResult {
  const terms = query
    .trim()
    .split(/[\s　]+/)
    .map(normalize)
    .filter(Boolean);

  const searchable = records.filter((r) => (r.transcript?.length ?? 0) > 0).length;
  const base: SearchResult = {
    hits: [],
    searchableEpisodes: searchable,
    totalEpisodes: records.length,
  };
  if (terms.length === 0) return base;

  const hits: Hit[] = [];
  // 新しい回から見る。同じ話なら直近のほうが使いやすい
  const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt);

  for (const r of sorted) {
    const title = r.chosenTitle || r.meta.titles?.[0] || "(タイトル未定)";
    const common = {
      episodeId: r.id,
      episodeTitle: title,
      createdAt: r.createdAt,
      hasAudio: !!r.audio,
    };

    // 1. 書き起こし。切り抜きに使えるのはここだけなので最優先
    let found = 0;
    for (const seg of r.transcript ?? []) {
      if (!matches(seg.text, terms)) continue;
      const ms = parseTimestamp(seg.time);
      hits.push({
        ...common,
        atSec: ms === null ? null : ms / 1000,
        speaker: seg.speaker,
        text: seg.text,
        where: "transcript",
      });
      found++;
      // 1回の中で同じ話を延々拾っても選びにくいだけ
      if (found >= 8) break;
    }
    if (found > 0) continue;

    // 2. 書き起こしが無い回は、せめてどの回かだけでも分かるようにする
    if (matches(title, terms)) {
      hits.push({ ...common, atSec: null, speaker: "", text: title, where: "title" });
      continue;
    }
    const chapter = (r.meta.chapters ?? []).find((c) => matches(c.label, terms));
    if (chapter) {
      const ms = parseTimestamp(chapter.time);
      hits.push({
        ...common,
        atSec: ms === null ? null : ms / 1000,
        speaker: "",
        text: chapter.label,
        where: "chapter",
      });
      continue;
    }
    const notes = [r.meta.transcriptSummary, r.meta.description, r.meta.showNotes]
      .filter(Boolean)
      .join("\n");
    if (notes && matches(notes, terms)) {
      hits.push({
        ...common,
        atSec: null,
        speaker: "",
        text: r.meta.transcriptSummary || r.meta.description.slice(0, 80),
        where: "notes",
      });
    }
  }

  return { ...base, hits: hits.slice(0, MAX_HITS) };
}

/** 見つかった箇所を切り抜きの候補にする。前を少し含めて、話の頭から始める。 */
export function hitToClip(hit: Hit, lengthSec = 40, leadSec = 3) {
  const start = Math.max(0, (hit.atSec ?? 0) - leadSec);
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const fmt = (s: number) => `${pad(s / 60)}:${pad(s % 60)}`;
  return {
    start: fmt(start),
    end: fmt(start + lengthSec),
    // 見出しは長すぎると画面に入らない。文の頭だけ借りる
    hook: hit.text.length > 24 ? `${hit.text.slice(0, 24)}…` : hit.text,
    why: "検索で見つけた場面",
  };
}
