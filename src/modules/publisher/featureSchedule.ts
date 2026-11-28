import type { Row } from "../analytics/model";
import { destinations, freeLimit, fromJst, localDate, monthOf, proposal, quota, type Destination, type PublisherState } from "./model";

const day = 86_400_000;

export function observedHours(rows: Row[], now: number) {
  const hours: Partial<Record<Destination, number>> = {};
  for (const destination of destinations) {
    const series = new Map<string, Map<number, number[]>>();
    const unique = new Set<string>();
    for (const row of rows) {
      if (row.platform !== destination || row.metric !== "plays" || row.quality !== "measured" ||
        row.basis === "lifetime" || row.value === null || !row.entity || !row.postedAt || now - Date.parse(row.postedAt) > 90 * day) continue;
      // Compare the same measurement window and definition, using each post once.
      const key = JSON.stringify([row.source, row.definition, row.start, row.end]);
      const identity = JSON.stringify([key, row.entity]);
      if (unique.has(identity)) continue;
      unique.add(identity);
      const groups = series.get(key) ?? new Map<number, number[]>();
      const hour = Math.floor(((new Date(row.postedAt).getUTCHours() + 9) % 24) / 6) * 6 + 3;
      groups.set(hour, [...groups.get(hour) ?? [], row.value]);
      series.set(key, groups);
    }
    const comparable = [...series.values()].map(groups => [...groups].filter(([, values]) => values.length >= 2))
      .filter(groups => groups.length >= 2).sort((left, right) => right.flatMap(x => x[1]).length - left.flatMap(x => x[1]).length)[0];
    if (!comparable) continue;
    const averages = comparable.map(([hour, values]) => [hour, values.reduce((total, value) => total + value, 0) / values.length]);
    averages.sort((a, b) => b[1] - a[1]);
    if (averages[0][1] > averages[1][1]) hours[destination] = averages[0][0];
  }
  return hours;
}

export function applySeriesSchedule(state: PublisherState, keys: string[], after: number, now: number, hours: Partial<Record<Destination, number>>) {
  if (!Number.isFinite(after) || !keys.length) throw new Error("本編配信予定と候補を確認してください。");
  if (keys.some(key => !state.drafts[key]?.candidate.parent)) throw new Error("本編が紐づいたショートを選択してください。");
  const floor = Math.max(now, after);
  const suggested = proposal(floor, true);
  for (const [index, key] of keys.entries()) {
    const draft = state.drafts[key];
    for (const network of destinations) {
      const copy = draft.plan[network];
      if (!copy) continue;
      const slot = fromJst(suggested.slots[network]);
      const at = localDate(slot + index * 3 * day);
      const hour = hours[network];
      draft.plan[network] = { ...copy, at: hour === undefined ? at : at.slice(0, 11) + String(hour).padStart(2, "0") + ":00" };
    }
    if (draft.state === "approved") draft.state = "review";
  }
}
export function planQuotaWarnings(state: PublisherState, keys: string[]) {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const draft = state.drafts[key];
    if (!draft) continue;
    for (const network of destinations) {
      const copy = draft.plan[network];
      if (!copy || copy.visibility === "draft" || !Number.isFinite(fromJst(copy.at)) || state.deliveries.some(item =>
        item.candidateId === draft.candidate.candidateId && item.destination === network && item.state !== "cancelled" && item.state !== "failed")) continue;
      const month = monthOf(fromJst(copy.at));
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
  }
  return [...counts].filter(([month, count]) => quota(state, month) + count > freeLimit).map(([month]) => month);
}
