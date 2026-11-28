import { fromJst, localDate, type Delivery } from "./model";

const filters = ["all", "today", "upcoming", "waiting", "published", "action"] as const;
export type Filter = typeof filters[number];
export const filterLabels: Record<Filter, string> = {
  all: "すべて", today: "今日の投稿", upcoming: "今後の予約", waiting: "配信確認待ち", published: "投稿済み", action: "要対応",
};

export function matchesFilter(item: Delivery, filter: Filter, now: number) {
  const at = fromJst(item.copy.at);
  if (filter === "all") return true;
  if (filter === "today") return item.copy.at.slice(0, 10) === localDate(now).slice(0, 10);
  if (filter === "upcoming") return item.state === "scheduled" && at > now;
  if (filter === "waiting") return !item.device && (item.state === "confirmation" || item.state === "processing");
  if (filter === "published") return !!item.device || item.state === "published";
  return item.state === "failed" || item.state === "unknown" || item.state === "sending";
}
