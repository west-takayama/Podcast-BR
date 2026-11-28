import { canHandoffShort, type Feature, type ShortParent } from "../video/feature";
export const destinations = ["instagram", "tiktok", "youtube"] as const;
export type Destination = typeof destinations[number];
export const accounts: Record<Destination, string> = {
  instagram: "Instagram · bridge_radio", tiktok: "TikTok · bridgeradio2000", youtube: "YouTube Shorts · UCTY_9yQowUpcUEPdh574WaA",
};
export const freeLimit = 20;
export const planner = "https://app.metricool.com/planner";
export const localDate = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 16);
export function fromJst(value: string) {
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? Date.parse(value + ":00+09:00") : NaN;
  return Number.isFinite(at) && localDate(at) === value ? at : NaN;
}
export const monthOf = (at: number) => localDate(at).slice(0, 7);
export type Candidate = {
  candidateId: string; versionId: string; videoId: string; manifestId: string; filename: string; mime: string;
  parent?: ShortParent;
  title: string; description: string; hashtags: string[]; startMs: number; endMs: number;
};
export type Visibility = "public" | "private" | "SELF_ONLY" | "draft";
export type Copy = { title: string; text: string; hashtags: string; at: string; visibility?: Visibility; notifySubscribers?: boolean };
export const visibilityOptions: Record<Destination, Visibility[]> = {
  instagram: ["public", "draft"], tiktok: ["public", "SELF_ONLY"], youtube: ["public", "private"],
};
export type ProviderResult = {
  postId?: string; uuid?: string; videoId?: string; responseId?: string; apiState: string; detail?: string; raw: string;
  visibility: Visibility; scheduledAt: string; observedAt: number; approval: string; draft?: boolean; autoPublish?: boolean; notifySubscribers?: boolean;
};
export type DeviceCheck = { by: string; at: number; note: string };
export type Plan = Partial<Record<Destination, Copy>>;
export type Status = "candidate" | "review" | "approved" | "sending" | "scheduled" | "published" | "failed" | "cancelled" | "unknown" | "draft" | "processing" | "confirmation";
export type Delivery = { requestId?: string; candidateId: string; versionId: string; digest: string; destination: Destination; copy: Copy; audience?: Draft["audience"];
  state: Status; provider?: ProviderResult; providerProgress?: Status; receiptFingerprint?: string; device?: DeviceCheck; resultObservedAt?: number; reference?: string; at: number; note?: string };
export type Draft = { candidate: Candidate; plan: Plan; state: "candidate" | "review" | "approved"; audience?: "yes" | "no" };
export type PublisherState = { drafts: Record<string, Draft>; deliveries: Delivery[]; audit: (Delivery & { recordedAt: number })[]; other: Record<string, number>; confirmedQuota?: Record<string, { count: number; at: number }> };
export const emptyPublisher = (): PublisherState => ({ drafts: {}, deliveries: [], audit: [], other: {} });
export const draftKey = (candidate: Pick<Candidate, "candidateId" | "versionId">) => candidate.candidateId + ":" + candidate.versionId;

// These aggregate best hours were returned by Metricool for 2026-11-29 through 2026-12-04 (JST).
const hours: Record<Destination, number> = { instagram: 10, tiktok: 10, youtube: 16 };
const first = Date.parse("2026-11-29T00:00:00+09:00");
const last = Date.parse("2026-12-05T00:00:00+09:00");
export function proposal(now: number, spread: boolean) {
  const tomorrow = Date.parse(localDate(now).slice(0, 10) + "T00:00:00+09:00") + 86_400_000;
  const measured = tomorrow >= first && tomorrow + (spread ? 2 : 0) * 86_400_000 < last;
  return {
    measured,
    slots: Object.fromEntries(destinations.map((network, index) => [
      network, localDate(tomorrow + (spread ? index : 0) * 86_400_000 + (measured ? (spread ? hours[network] : 10) : 19) * 3_600_000),
    ])) as Record<Destination, string>,
  };
}

export function makeDraft(candidate: Candidate, now = Date.now()): Draft {
  const { slots } = proposal(now, false);
  const plan: Plan = Object.fromEntries(destinations.map(network => [network, {
    title: candidate.title, text: candidate.description, hashtags: candidate.hashtags.join(" "), at: slots[network],
  }]));
  return { candidate, plan, state: "candidate" };
}

export function validate(draft: Draft, now: number) {
  if (draft.candidate.mime !== "video/mp4") throw new Error("投稿用のMP4を書き出し直してください。");
  const seconds = (draft.candidate.endMs - draft.candidate.startMs) / 1000;
  if (seconds < 3 || seconds > 180) throw new Error("3秒〜3分のショート動画を指定してください。");
  const selected = destinations.filter(network => draft.plan[network]);
  if (!selected.length) throw new Error("投稿先を選んでください。");
  for (const network of selected) {
    const copy = draft.plan[network]!;
    if (!visibilityOptions[network].includes(copy.visibility ?? "public")) throw new Error("媒体に対応する公開範囲を選んでください。");
    if (!(fromJst(copy.at) > now)) throw new Error("日本時間で将来の予約日時を指定してください。");
    if (network === "youtube" && (!copy.title.trim() || copy.title.length > 100 || !draft.audience)) {
      throw new Error("YouTubeのタイトル（100文字以内）と子ども向け設定を確認してください。");
    }
    if (draft.candidate.parent && !copy.text.includes(draft.candidate.parent.title)) throw new Error("ショートの投稿文に本編タイトルを残してください。");
    if (copy.text.length + copy.hashtags.length + 2 > (network === "youtube" ? 5000 : 2200)) throw new Error("投稿文とハッシュタグを短くしてください。");
  }
}

export function approve(state: PublisherState, keys: string[], now: number) {
  for (const key of keys) {
    const draft = state.drafts[key];
    if (!draft || draft.state !== "review") throw new Error("承認待ちにした候補を選んでください。");
    validate(draft, now);
  }
  for (const key of keys) state.drafts[key].state = "approved";
}

const active = (delivery: Delivery) => delivery.state !== "failed" && delivery.state !== "cancelled";
export function quota(state: PublisherState, month: string) {
  const eligible = state.deliveries.filter(item => active(item) && item.copy.visibility !== "draft" &&
    item.state !== "draft" && monthOf(fromJst(item.copy.at)) === month);
  const local = (state.other[month] ?? 0) + eligible.length;
  const confirmed = state.confirmedQuota?.[month];
  if (!confirmed) return local;
  const newer = eligible.filter(item => (["sending", "unknown", "processing", "confirmation"].includes(item.state) ||
      (item.provider?.observedAt ?? item.resultObservedAt ?? item.at) > confirmed.at)).length;
  return Math.max(local, confirmed.count + newer);
}

export function beginHandoff(state: PublisherState, key: string, network: Destination, digest: string, now: number, feature?: Feature) {
  const draft = state.drafts[key];
  if (!draft || draft.state !== "approved") throw new Error("承認済みの版を開いてください。");
  const copy = draft.plan[network];
  if (!copy) throw new Error("承認済みの投稿先を選んでください。");
  validate({ ...draft, plan: { [network]: copy } }, now);
  if (draft.candidate.parent) canHandoffShort(draft.candidate.parent, feature, fromJst(copy.at), now);
  if (state.deliveries.some(item => item.destination === network && active(item) &&
    (item.digest === digest || item.candidateId === draft.candidate.candidateId))) {
    throw new Error("同じ動画または候補の記録があります。外部結果を確認してください。");
  }
  if (copy.visibility !== "draft" && quota(state, monthOf(fromJst(copy.at))) >= freeLimit) throw new Error("その月の無料投稿枠の目安に達しました。");
  const item: Delivery = { requestId: crypto.randomUUID(), candidateId: draft.candidate.candidateId, versionId: draft.candidate.versionId,
    destination: network, digest, copy: { ...copy }, audience: draft.audience, state: "sending", at: now };
  state.deliveries.push(item);
  state.audit.push({ ...item, recordedAt: now });
  return item;
}

export function reconcile(state: PublisherState, index: number, outcome: "scheduled" | "published" | "failed" | "cancelled" | "unknown",
  evidence: string, now: number, observedAt = now) {
  const item = state.deliveries[index];
  if (!item || !["sending", "unknown", "scheduled", "draft", "processing", "confirmation"].includes(item.state)) throw new Error("照合できる投稿記録を選んでください。");
  if (outcome !== "unknown" && !evidence.trim()) throw new Error("外部IDまたは確認した結果を入力してください。");
  if ((outcome === "scheduled" || outcome === "published") && state.deliveries.some((other, i) =>
    i !== index && other.destination === item.destination && other.reference === evidence.trim() && active(other))) {
    throw new Error("この外部IDは登録済みです。");
  }
  if (outcome === "failed" && ["scheduled", "processing", "confirmation"].includes(item.state)) throw new Error("予約の失敗は外部の取消・不存在を確認してから記録してください。");
  if (item.provider) throw new Error("API結果がある投稿は結果JSONで照合してください。");
  item.state = outcome;
  item.resultObservedAt = observedAt;
  if (outcome === "scheduled" || outcome === "published") item.reference = evidence.trim().slice(0, 200);
  else item.note = evidence.trim().slice(0, 300);
  state.audit.push({ ...item, recordedAt: now });
}
