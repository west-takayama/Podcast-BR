// 履歴から番組の傾向を割り出す。
//
// ここで出すのは**出している側の傾向**であって、聴かれ方ではない。
// Spotify for Creators には再生数を取れる API が無いので、
// 「どの回が伸びたか」はこのツールからは分からない。分からないことを
// 分かったふうに書くと判断を誤らせるので、扱うのは手元にある事実だけにする。
//
// 端末内の計算だけで完結する(通信なし)。AI に投げるのはこの結果と
// 要約の抜粋で、音声は送らない。

import type { EpisodeRecord } from "./history";

/** 語の登場のしかた。 */
export interface TopicStat {
  word: string;
  /** 何回ぶんのエピソードに出たか(1回の中で何度出ても1と数える)。 */
  episodes: number;
  /** 最後に出た回の日時。 */
  lastAt: number;
  /** 最後に出てから何回ぶん空いているか。 */
  sinceEpisodes: number;
  /** 初めて出てから何回ぶん経っているか。「最近出てきた語」を見分けるのに使う。 */
  ageEpisodes: number;
}

export interface Insights {
  /** 集計できた回数。 */
  count: number;
  /** 期間(最初の回から最後の回まで)。1回だけなら 0。 */
  spanDays: number;
  /** 投稿間隔の中央値(日)。2回未満なら null。 */
  medianGapDays: number | null;
  /** 直近の間隔(日)。2回未満なら null。 */
  latestGapDays: number | null;
  /** 最後の回からの経過日数。 */
  daysSinceLast: number;
  /** 1回あたりの長さ(分)の中央値。 */
  medianMinutes: number;
  /** 直近5回とそれ以前で、長さがどう変わったか(分)。比べられなければ null。 */
  minutesTrend: number | null;
  /** 1回あたりのチャプター数の中央値 = 扱っている話題の数。 */
  medianChapters: number;
  /** よく出る語。 */
  topTopics: TopicStat[];
  /** 2回以上出たのに、直近5回では出ていない語。掘り直せる話題。 */
  dormantTopics: TopicStat[];
  /** 直近5回で**初めて**出た語。いま乗っている流れ。 */
  risingTopics: TopicStat[];
  /** 採用したタイトルの平均文字数。 */
  titleChars: number;
  /** 採用したタイトルのうち、AI の第1案だった割合(0〜1)。 */
  firstPickRate: number | null;
  /** 疑問形・問いかけで終わるタイトルの割合(0〜1)。 */
  questionRate: number;
}

/** 直近何回ぶんを「いま」とみなすか。 */
const RECENT = 5;

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const DAY = 86400000;

/**
 * 語をならす。ハッシュタグの # と前後の空白を落とし、全角英数を半角にする。
 * 「#ポッドキャスト」と「ポッドキャスト」を別の語として数えないため。
 */
export function normalizeWord(raw: string): string {
  return raw
    .trim()
    .replace(/^[#＃]+/, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

/** その回で扱った語(キーワード + ハッシュタグ)。重複は畳む。 */
function wordsOf(record: EpisodeRecord): string[] {
  const raw = [...(record.meta.keywords ?? []), ...(record.meta.hashtags ?? [])];
  const seen = new Set<string>();
  for (const w of raw) {
    const n = normalizeWord(w);
    // 1文字の語は「回」「話」のような無意味なものが多いので落とす
    if (n.length >= 2) seen.add(n);
  }
  return [...seen];
}

export function buildInsights(records: EpisodeRecord[], now = Date.now()): Insights {
  // 古い順に並べる。「何回ぶん前か」を数えるため
  const eps = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const count = eps.length;
  const empty: Insights = {
    count: 0,
    spanDays: 0,
    medianGapDays: null,
    latestGapDays: null,
    daysSinceLast: 0,
    medianMinutes: 0,
    minutesTrend: null,
    medianChapters: 0,
    topTopics: [],
    dormantTopics: [],
    risingTopics: [],
    titleChars: 0,
    firstPickRate: null,
    questionRate: 0,
  };
  if (count === 0) return empty;

  const gaps: number[] = [];
  for (let i = 1; i < eps.length; i++) {
    gaps.push((eps[i].createdAt - eps[i - 1].createdAt) / DAY);
  }

  const minutes = eps.map((e) => e.durationSec / 60);
  const recentMinutes = minutes.slice(-RECENT);
  const olderMinutes = minutes.slice(0, -RECENT);

  // 語ごとに「出た回」を集める
  const hits = new Map<string, number[]>();
  eps.forEach((e, i) => {
    for (const w of wordsOf(e)) {
      const list = hits.get(w) ?? [];
      list.push(i);
      hits.set(w, list);
    }
  });

  const stats: TopicStat[] = [...hits.entries()].map(([word, idxs]) => {
    const last = idxs[idxs.length - 1];
    return {
      word,
      episodes: idxs.length,
      lastAt: eps[last].createdAt,
      sinceEpisodes: count - 1 - last,
      ageEpisodes: count - 1 - idxs[0],
    };
  });
  // よく出る順。同数なら最近出たほうを先に
  const byWeight = (a: TopicStat, b: TopicStat) =>
    b.episodes - a.episodes || a.sinceEpisodes - b.sinceEpisodes;

  const titles = eps.map((e) => e.chosenTitle || e.meta.titles?.[0] || "").filter(Boolean);
  // 採用したタイトルが AI の第1案だったか。候補が無い回は数えない
  const withCandidates = eps.filter((e) => e.chosenTitle && (e.meta.titles?.length ?? 0) > 0);
  const firstPicks = withCandidates.filter((e) => e.meta.titles[0] === e.chosenTitle).length;

  return {
    count,
    spanDays: (eps[count - 1].createdAt - eps[0].createdAt) / DAY,
    medianGapDays: gaps.length > 0 ? median(gaps) : null,
    latestGapDays: gaps.length > 0 ? gaps[gaps.length - 1] : null,
    daysSinceLast: (now - eps[count - 1].createdAt) / DAY,
    medianMinutes: median(minutes),
    minutesTrend:
      olderMinutes.length > 0 && recentMinutes.length > 0
        ? median(recentMinutes) - median(olderMinutes)
        : null,
    medianChapters: median(eps.map((e) => e.meta.chapters?.length ?? 0)),
    topTopics: stats.filter((s) => s.episodes >= 2).sort(byWeight).slice(0, 12),
    // 2回以上扱ったのに、しばらく触れていない = 掘り直せる
    dormantTopics: stats
      .filter((s) => s.episodes >= 2 && s.sinceEpisodes >= RECENT)
      .sort((a, b) => b.episodes - a.episodes || b.sinceEpisodes - a.sinceEpisodes)
      .slice(0, 10),
    // 直近で「初めて」出た = 新しく入ってきた流れ。
    // 「最後に出たのが直近」だと、昔からある語まで入ってきて
    // 「よく扱う話題」と丸かぶりになる(実際に画面で見て気づいた)
    risingTopics: stats
      .filter((s) => s.ageEpisodes < RECENT && count > RECENT)
      .sort((a, b) => a.ageEpisodes - b.ageEpisodes || b.episodes - a.episodes)
      .slice(0, 10),
    titleChars: titles.length > 0 ? Math.round(median(titles.map((t) => t.length))) : 0,
    firstPickRate: withCandidates.length > 0 ? firstPicks / withCandidates.length : null,
    questionRate:
      titles.length > 0
        ? titles.filter((t) => /[?？]/.test(t) || /(かな|だろう|ですか|とは)$/.test(t)).length /
          titles.length
        : 0,
  };
}

/**
 * AI に渡す履歴の抜粋。
 *
 * 全部渡すと出力上限に当たるうえ、無料枠も食う。
 * お題を考えるのに要るのは「何を、いつ、どんな切り口で話したか」なので、
 * タイトル・日付・要約・チャプターの見出しだけに絞る。
 * 音声も書き起こし本文も送らない。
 */
export function digestForPrompt(records: EpisodeRecord[], limit = 20): string {
  return [...records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((e) => {
      const d = new Date(e.createdAt);
      const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
      const title = e.chosenTitle || e.meta.titles?.[0] || "(タイトル未定)";
      const chapters = (e.meta.chapters ?? []).map((c) => c.label).join(" / ");
      const summary = (e.meta.transcriptSummary || e.meta.description || "").slice(0, 160);
      return [
        `- ${date} ${title}`,
        summary && `  要約: ${summary}`,
        chapters && `  流れ: ${chapters}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

/** 統計を AI にそのまま読ませられる短い文にする。 */
export function insightsForPrompt(ins: Insights): string {
  const lines: string[] = [
    `- 回数: ${ins.count}回`,
    ins.medianGapDays !== null && `- 投稿間隔の中央値: ${ins.medianGapDays.toFixed(1)}日`,
    `- 最後の回から: ${ins.daysSinceLast.toFixed(0)}日`,
    `- 1回の長さ: 中央値 ${ins.medianMinutes.toFixed(0)}分`,
    `- 1回あたりの話題数: ${ins.medianChapters.toFixed(0)}個`,
    ins.topTopics.length > 0 &&
      `- よく扱う話題: ${ins.topTopics.map((t) => `${t.word}(${t.episodes}回)`).join("、")}`,
    ins.dormantTopics.length > 0 &&
      `- しばらく触れていない話題: ${ins.dormantTopics.map((t) => t.word).join("、")}`,
    ins.risingTopics.length > 0 &&
      `- 最近出てきた話題: ${ins.risingTopics.map((t) => t.word).join("、")}`,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}
