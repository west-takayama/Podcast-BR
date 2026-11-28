import { destinations, fromJst, localDate, visibilityOptions, type Delivery, type Destination, type ProviderResult, type PublisherState, type Status, type Visibility } from "./model";

export function normalizeProvider(result: Pick<ProviderResult, "apiState" | "draft" | "autoPublish">): Status {
  // A provider's detail text cannot override a pending acknowledgement.
  if (result.draft === true && result.autoPublish === false) return "draft";
  switch (result.apiState) {
    case "DRAFT": return "draft";
    case "SCHEDULED": return "scheduled";
    case "PROCESSING": case "PUBLISHING": return "processing";
    case "AWAITING_CONFIRMATION": return "confirmation";
    case "PUBLISHED": return "published";
    case "FAILED": return "failed";
    case "CANCELLED": case "CANCELED": return "cancelled";
    default: return "unknown";
  }
}

const allowed: Partial<Record<Status, Status[]>> = {
  sending: ["draft", "scheduled", "processing", "confirmation", "published", "failed", "unknown", "cancelled"],
  draft: ["scheduled", "processing", "confirmation", "published", "unknown", "cancelled"],
  scheduled: ["processing", "confirmation", "published", "failed", "unknown", "cancelled"],
  processing: ["confirmation", "published", "failed", "unknown", "cancelled"],
  confirmation: ["published", "failed", "cancelled"],
  unknown: ["draft", "scheduled", "processing", "confirmation", "published", "failed", "cancelled"],
};

const identifier = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && /^[\w-]+$/.test(value) ? value : undefined;
const utc = (value: unknown) =>
  typeof value === "string" && /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN;

export function parseProvider(value: Record<string, unknown>) {
  const network = value.destination as Destination;
  const v = value.provider as Record<string, unknown> | null;
  if (!destinations.includes(network) || !v) throw new Error("投稿先・API結果の形式を確認してください。");
  const observedAt = utc(value.observedAt);
  const scheduledAt = typeof v.scheduledAt === "string" && v.scheduledAt.endsWith(":00+09:00")
    ? fromJst(v.scheduledAt.slice(0, -9)) : NaN;
  const approval = typeof value.approval === "string" && /^[a-f0-9]{64}$/.test(value.approval) ? value.approval : undefined;
  const postId = identifier(v.postId, 80);
  const uuid = identifier(v.uuid, 80);
  const videoId = identifier(v.videoId, 100);
  const responseId = identifier(v.responseId, 100);
  const apiState = identifier(v.apiState, 80);
  const visibility = v.visibility as Visibility;
  if (!Number.isFinite(observedAt) || !Number.isFinite(scheduledAt) || !approval || !apiState ||
    !visibilityOptions[network].includes(visibility) || typeof v.raw !== "string" || !v.raw.trim() || v.raw.length > 12_000 ||
    (v.postId !== undefined && !postId) || (v.uuid !== undefined && !uuid) || (v.videoId !== undefined && !videoId) || (v.responseId !== undefined && !responseId) ||
    (v.notifySubscribers !== undefined && (network !== "youtube" || typeof v.notifySubscribers !== "boolean")) ||
    (v.draft !== undefined && typeof v.draft !== "boolean") || (v.autoPublish !== undefined && typeof v.autoPublish !== "boolean") ||
    (v.detail !== undefined && (typeof v.detail !== "string" || v.detail.length > 300))) {
    throw new Error("API結果の項目、予定日時、公開範囲を確認してください。");
  }
  if (/\b(?:Bearer\s+\S+|access_token|refresh_token|client_secret|api_key)\b/i.test(v.raw)) {
    throw new Error("原文から認証情報を除いてください。");
  }
  const result: ProviderResult = {
    postId, uuid, videoId, responseId, apiState, detail: v.detail as string | undefined, raw: v.raw,
    draft: v.draft as boolean | undefined, autoPublish: v.autoPublish as boolean | undefined,
    notifySubscribers: v.notifySubscribers as boolean | undefined, visibility, scheduledAt: localDate(scheduledAt) + ":00+09:00", observedAt, approval,
  };
  if (visibility === "draft" && !["draft", "unknown", "cancelled"].includes(normalizeProvider(result))) throw new Error("下書き限定の結果と矛盾します。");
  if (!["unknown", "failed"].includes(normalizeProvider(result)) && !postId && !uuid) {
    throw new Error("既存投稿のIDまたはUUIDを入力してください。");
  }
  return result;
}

export function applyProvider(state: PublisherState, item: Delivery, result: ProviderResult, now: number, fingerprint: string) {
  if (state.audit.some(event => event.requestId === item.requestId && event.receiptFingerprint === fingerprint)) return false;
  if (result.observedAt < item.at || result.observedAt > now + 60_000 ||
    (item.resultObservedAt !== undefined && result.observedAt <= item.resultObservedAt)) throw new Error("古い結果または照合日時が不正です。");
  const next = normalizeProvider(result);
  const progress = item.providerProgress ?? item.state;
  if (next !== progress && !allowed[progress]?.includes(next)) throw new Error("新しい結果が現在の投稿状態と矛盾します。");
  if (item.device && ["failed", "cancelled", "unknown"].includes(next)) throw new Error("実機確認済みの投稿は状態を照合してください。");
  const previous = item.provider;
  if (previous?.videoId && result.videoId && previous.videoId !== result.videoId) throw new Error("既存動画のIDが一致しません。");
  if (previous?.uuid && result.uuid && previous.uuid !== result.uuid) throw new Error("既存投稿のUUIDが一致しません。");
  if ((previous?.postId ?? item.reference) && result.postId && (previous?.postId ?? item.reference) !== result.postId && !(previous?.uuid && previous.uuid === result.uuid)) throw new Error("既存投稿のIDが一致しません。");
  if (state.deliveries.some(other => other !== item && other.destination === item.destination &&
    ((result.postId && (other.provider?.postId === result.postId || other.reference === result.postId)) ||
      (result.uuid && other.provider?.uuid === result.uuid) || (result.videoId && other.provider?.videoId === result.videoId) ||
      (result.responseId && other.provider?.responseId === result.responseId)))) {
    throw new Error("同じ外部投稿が台帳にあります。既存の記録を照合してください。");
  }
  item.provider = { ...result, postId: result.postId ?? previous?.postId, uuid: result.uuid ?? previous?.uuid,
    videoId: result.videoId ?? previous?.videoId, responseId: result.responseId ?? previous?.responseId };
  item.state = next;
  if (next !== "unknown") item.providerProgress = next;
  else item.providerProgress = progress;
  item.receiptFingerprint = fingerprint;
  item.resultObservedAt = result.observedAt;
  state.audit.push({ ...item, recordedAt: now });
  return true;
}

export function verifyOnDevice(state: PublisherState, index: number, checker: string, note: string, at: number) {
  const item = state.deliveries[index];
  if (!item || !["confirmation", "published"].includes(item.state)) throw new Error("実機で存在を確認した投稿を選んでください。");
  if (!checker.trim() || !note.trim() || !Number.isFinite(at) || at < item.at || at > Date.now() + 60_000 ||
    (item.device && at <= item.device.at)) throw new Error("確認者、日時、確認内容を確認してください。");
  item.device = { by: checker.trim().slice(0, 80), note: note.trim().slice(0, 500), at };
  state.audit.push({ ...item, recordedAt: Date.now() });
}
