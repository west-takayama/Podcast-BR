import type { EpisodeRecord } from "../../lib/history";
import type { ProductionMetric } from "../../lib/productionMetrics";
import { summarize, type BudgetState } from "../budget/ledger";
import { scale, limit } from "../budget/pricing";
import type { PublisherState } from "../publisher/model";
import type { PodcastEntry } from "../publisher/podcast/model";
import { comparisons, day, periods, seriesKey, type Period, type Row } from "./model";

export const labels: Record<string, string> = {
  spotify: "Spotify", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", studio: "AI STUDIO",
  plays: "再生・表示", followers: "フォロワー", followerChange: "フォロワー増減", likes: "いいね", comments: "コメント",
  shares: "シェア", publications: "配信件数", responses: "リスナー反応", audioMinutes: "音声編集時間", aiMinutes: "AI処理時間",
  shortMinutes: "ショート生成時間", prepMinutes: "投稿準備時間", humanMinutes: "人間の操作時間",
  metricool: "Metricool", "spotify-creators": "Spotify for Creators", manual: "手動入力",
  measured: "実測", estimated: "推定", missing: "未取得", count: "件", min: "分",
};

export type Inputs = {
  episodes: Pick<EpisodeRecord, "id" | "createdAt">[];
  sns: PublisherState; podcast: PodcastEntry[]; budget: BudgetState; timings: ProductionMetric[];
};
const inPeriod = (at: number | undefined, period: Period) => at !== undefined && day(at) >= period.start && day(at) <= period.end;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const yen = (value: number) => value / scale;
const number = (value: number) => new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(value);
export const valueText = (value: number | null) => value === null ? "未取得" : number(value);
export const periodText = (period: Period) => period.start <= period.end ? period.start + "〜" + period.end : "確定済み日なし";

export function makeReport(rows: Row[], inputs: Inputs, at = Date.now()) {
  const windows = periods(at);
  const { episodes, sns, podcast, budget, timings } = inputs;
  const ledger = summarize(budget, at);
  const localEpisodes = new Set([...episodes.map(row => row.id), ...podcast.map(row => row.episodeId)]);
  const metrics = comparisons(rows, at).map(row => {
    const episodeId = row.entity && row.platform === "spotify"
      ? podcast.find(entry => entry.spotifyId === row.entity)?.episodeId ?? (localEpisodes.has(row.entity) ? row.entity : undefined)
      : undefined;
    const candidateIds = row.entity && row.platform !== "spotify" && row.platform !== "studio" ? [...new Set(sns.deliveries.filter(item =>
      item.destination === row.platform && [item.candidateId, item.provider?.postId, item.provider?.videoId, item.provider?.responseId].includes(row.entity)).map(item => item.candidateId))] : [];
    return { ...row, episodeId, candidateId: candidateIds.length === 1 ? candidateIds[0] : undefined,
      weekChange: row.week.value === null || row.previousWeek.value === null ? null : row.week.value - row.previousWeek.value,
      monthChange: row.month.value === null || row.previousMonth.value === null ? null : row.month.value - row.previousMonth.value };
  });
  const activities = Object.fromEntries(Object.entries(windows).map(([name, period]) => [name, {
    episodes: episodes.filter(row => inPeriod(row.createdAt, period)).length,
    podcasts: podcast.filter(row => inPeriod(row.history.find(event => event.status === "published")?.at, period)).length,
    shorts: sns.deliveries.filter(row => (row.state === "published" || row.device) &&
      (row.provider?.visibility ?? row.copy.visibility ?? "public") === "public" &&
      inPeriod(row.device?.at ?? row.provider?.observedAt ?? row.resultObservedAt, period)).length,
    privateConfirmations: sns.deliveries.filter(row => (row.state === "published" || row.device) &&
      ["private", "SELF_ONLY"].includes(row.provider?.visibility ?? row.copy.visibility ?? "") &&
      inPeriod(row.device?.at ?? row.provider?.observedAt ?? row.resultObservedAt, period)).length,
  }]));
  const recent = budget.entries.filter(entry => inPeriod(entry.at, windows.week));
  const requests = recent.filter(entry => entry.state !== "cache");
  const cached = recent.length - requests.length;
  const production = [
    { label: "端末のAI送信用音声変換", values: timings.filter(row => row.stage === "conversion" && inPeriod(row.at, windows.week)).map(row => row.ms) },
    { label: "Gemini通信時間（各要求）", values: requests.flatMap(row => row.elapsedMs === undefined ? [] : [row.elapsedMs]) },
    { label: "ショートの動画書き出し", values: timings.filter(row => row.stage === "video-export" && inPeriod(row.at, windows.week)).map(row => row.ms) },
    { label: "本編素材の引き渡し処理", values: timings.filter(row => row.stage === "podcast-prep" && inPeriod(row.at, windows.week)).map(row => row.ms) },
  ].map(({ label, values }) => {
    const sorted = values.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return { label, samples: sorted.length, minutes: sorted.length ? sum(sorted) / 60000 : null,
      medianSeconds: sorted.length ? (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2000 : null };
  });
  const uncertain = ledger.current.filter(entry => ["pending", "unknown", "unpriced"].includes(entry.state));
  const costByEpisode = [...new Set(ledger.current.flatMap(row => row.episodeId ? [row.episodeId] : []))].map(episodeId => {
    const entries = ledger.current.filter(row => row.episodeId === episodeId);
    const known = entries.flatMap(row => row.estimate === undefined ? [] : [row.estimate]);
    return { episodeId, estimatedYen: known.length ? yen(sum(known)) : null,
      unresolved: entries.filter(row => ["pending", "unknown", "unpriced"].includes(row.state)).length };
  });
  const finance = { month: ledger.month, limitYen: yen(limit), actualGeminiYen: ledger.actual ? yen(ledger.actual.amount) : null,
    actualThrough: ledger.actual ? new Date(ledger.actual.through).toISOString() : null,
    estimatedGeminiYen: ledger.current.some(row => row.estimate !== undefined) ? yen(ledger.estimated) : null,
    operatingYen: yen(ledger.operating), remainingYen: yen(ledger.remaining), utilization: ledger.total / limit,
    pendingYen: yen(ledger.pending), unknownReservedYen: yen(ledger.unknown), unresolved: uncertain.length,
    failureRetryEstimatedYen: yen(sum(ledger.current.filter(row => row.success === false || row.attempt > 1).flatMap(row => row.estimate === undefined ? [] : [row.estimate]))),
    costByEpisode };
  const delivery = {
    confirmation: sns.deliveries.filter(row => !row.device && ["confirmation", "processing"].includes(row.state)).length,
    needsAction: sns.deliveries.filter(row => !row.device && ["unknown", "failed"].includes(row.state)).length,
    podcastNeedsCheck: podcast.filter(row => ["handoff", "unknown"].includes(row.status)).length,
    review: Object.values(sns.drafts).filter(row => row.state === "review").length,
  };
  const candidates = new Map<string, typeof metrics>();
  for (const row of metrics) {
    if (row.metric !== "plays" || !row.entity || row.week.value === null || row.week.qualities.some(q => q !== "measured")) continue;
    const key = seriesKey({ ...row.latest, entity: undefined });
    const group = candidates.get(key) ?? [];
    group.push(row);
    candidates.set(key, group);
  }
  const recommendations: string[] = [];
  for (const group of candidates.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.week.value! - a.week.value!);
    const top = group[0];
    if (top.week.value !== group[1].week.value) recommendations.push(
      `${labels[top.platform]} (${top.definition}) の比較対象${group.length}件では ${top.entity} が最多。次回企画では、${top.latest.topic ?? "この回"}の構成と公開後の経過日数を確認する。`);
    const slots = [0, 6, 12, 18].map(start => ({ start, values: group.filter(r => {
      if (!r.latest.postedAt) return false;
      const hour = (new Date(r.latest.postedAt).getUTCHours() + 9) % 24;
      return hour >= start && hour < start + 6;
    }).map(row => row.week.value!) })).filter(slot => slot.values.length >= 2);
    if (slots.length >= 2) recommendations.push(`${labels[top.platform]} (${top.definition}) の投稿時間帯別平均（JST） ` +
      slots.map(slot => `${slot.start}時台から6時間 ${number(sum(slot.values) / slot.values.length)}件（${slot.values.length}本）`).join("、") +
      "。投稿時間の効果は判断保留。");
  }
  if (!recommendations.length) recommendations.push("比較可能なエピソード・投稿データが不足しています。企画と時間帯の評価は保留です。");
  const bottleneck = production.filter(row => row.samples >= 2).sort((a, b) => b.minutes! - a.minutes!)[0];
  if (bottleneck) recommendations.push(`計測した工程別の累計では「${bottleneck.label}」が最長。次週も同じ条件で記録する。`);
  if (requests.some(row => row.attempt > 1 || row.success === false)) recommendations.push("失敗・再試行を記録しました。制作時は保存済みの字幕や分析結果を先に確認する。");
  const requestStats = { requests: requests.length, retries: requests.filter(row => row.attempt > 1).length,
    errors: requests.filter(row => row.success === false).length, cached, reuseRate: recent.length ? cached / recent.length : null,
    localErrors: timings.filter(row => !row.success && inPeriod(row.at, windows.week)).length };
  const notes = ["外部サービスは手動取り込み。媒体ごとの定義を維持しており、媒体間の再生数は集計しません。",
    "活動件数はこの端末の台帳にある記録。配信は確認日時で集計し、任意の重複する集計期間は加算しません。",
    "制作工程は重なることがあります。別環境のAUDIO操作時間と人間の作業時間は手動で登録できます。",
    "投稿時間帯・企画と反応の比較は観察結果です。因果関係は評価しません。"];
  return { schema: "bridge-radio.analytics.weekly.v1", generatedAt: new Date(at).toISOString(), timezone: "Asia/Tokyo", windows,
    activities, metrics, production, requestStats, finance, delivery, recommendations, notes };
}

export function markdown(report: ReturnType<typeof makeReport>) {
  const { windows, activities, metrics, finance, delivery, recommendations, production, requestStats, notes } = report;
  return ["# BRIDGE RADIO 週次経営報告", `集計日 ${day(Date.parse(report.generatedAt))} JST`, "",
    "## 活動実績", "", "対象 | 期間（JST） | 制作履歴 | Podcast配信確認 | SNS公開確認 | 非公開SNS確認", "---|---|---:|---:|---:|---:",
    ...[["week","今週"],["previousWeek","前週"],["month","今月の比較期間"],["previousMonth","前月の対応期間"]].map(([key, title]) => {
      const item = activities[key];
      return `${title} | ${periodText(windows[key as keyof typeof windows])} | ${item.episodes} | ${item.podcasts} | ${item.shorts} | ${item.privateConfirmations}`;
    }), "", "## KPIの変化", "",
    "媒体・定義 | 取得元・取得日時 | 今週 | 前週 | 今月 | 前月", "---|---|---:|---:|---:|---:",
    ...metrics.map(row => [`${labels[row.platform]} ${labels[row.metric]} ${row.definition} ${row.entity ?? ""}${row.basis === "lifetime" ? "・公開以来" : ""}（${labels[row.unit]}）`,
      `${labels[row.source]} ${row.acquiredAt}`, ...[row.week, row.previousWeek, row.month, row.previousMonth].map(x =>
        x.value === null ? "未取得" : `${valueText(x.value)}（${x.qualities.map(q => labels[q]).join("・")}）`)].join(" | ")),
    ...(metrics.length ? [] : ["未取得 | — | — | — | — | —"]), "",
    ...metrics.filter(row => row.basis === "lifetime").map(row => `- ${labels[row.platform]} ${row.definition} ${row.entity} 公開以来の最新値 ${valueText(row.latest.value)}（${labels[row.latest.quality]}、${row.latest.end}時点）`),
    "", "## 制作と予算", "",
    ...production.map(row => `- ${row.label} ${valueText(row.minutes)}分／${row.samples}件`),
    `- Gemini要求 ${requestStats.requests}件、失敗 ${requestStats.errors}件、再試行 ${requestStats.retries}件、再利用 ${requestStats.cached}件`,
    `- ${finance.month} 残予算 ${number(finance.remainingYen)}円／上限 ${number(finance.limitYen)}円（予約・不明枠を反映）`,
    `- API実請求 ${finance.actualGeminiYen === null ? "未取得" : number(finance.actualGeminiYen) + "円"}、台帳の推定 ${finance.estimatedGeminiYen === null ? "未取得" : number(finance.estimatedGeminiYen) + "円"}、登録済み運営費 ${number(finance.operatingYen)}円`,
    `- 失敗・再試行に伴う既知の推定 ${number(finance.failureRetryEstimatedYen)}円、未確定・未算出 ${finance.unresolved}件`, "",
    "## 課題・改善提案・次回企画", "", `- SNS確認待ち ${delivery.confirmation}件、要対応 ${delivery.needsAction}件、承認待ち ${delivery.review}件、Podcast要照合 ${delivery.podcastNeedsCheck}件`,
    ...recommendations.map(note => "- " + note), "", "## 集計条件", "", ...notes.map(note => "- " + note), ""].join("\n");
}
