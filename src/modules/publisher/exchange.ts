import { applyProvider, parseProvider } from "./providerResult";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { accounts, draftKey, fromJst, reconcile, validate, type Delivery, type PublisherState } from "./model";

export const brandId = "7399385";
export const requestSchema = "bridge-radio.publisher.request.v2";
export const providerReceiptSchema = "bridge-radio.publisher.receipt.v2";
export const receiptSchema = "bridge-radio.publisher.receipt.v1";
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const sha256Pattern = /^[0-9a-f]{64}$/;

const approvalOf = (item: Delivery) => hash([item.versionId, item.digest, item.destination, item.copy, item.audience ?? null, item.copy.visibility ?? "public"]);

export function makeRequest(state: PublisherState, requestId: string, now: number) {
  const item = state.deliveries.find(delivery => delivery.requestId === requestId);
  if (!item || item.state !== "sending") throw new Error("有効な引き渡し記録がありません。");
  const draft = state.drafts[draftKey(item)];
  const plan = draft?.plan[item.destination];
  if (!draft || draft.state !== "approved" || !plan || JSON.stringify(plan) !== JSON.stringify(item.copy) ||
    draft.audience !== item.audience || !sha256Pattern.test(item.digest)) {
    throw new Error("承認済みの版・投稿情報が変わりました。再確認してください。");
  }
  validate({ ...draft, plan: { [item.destination]: plan } }, now);
  const approval = approvalOf(item);
  return {
    schema: requestSchema, requestId, idempotencyKey: hash([brandId, item.destination, item.digest]),
    brandId, candidateId: item.candidateId, videoVersion: item.versionId, approval,
    media: { driveFileId: draft.candidate.videoId, sha256: item.digest, filename: draft.candidate.filename, mimeType: draft.candidate.mime },
    destination: { network: item.destination, account: accounts[item.destination].split(" · ")[1] },
    post: { ...item.copy, publishAt: item.copy.at + ":00+09:00", timezone: "Asia/Tokyo",
      intendedVisibility: item.copy.visibility ?? "public",
      notifySubscribers: item.destination === "youtube" ? item.copy.notifySubscribers ?? false : null,
      draft: item.copy.visibility === "draft", autoPublish: item.copy.visibility !== "draft", madeForKids: item.destination === "youtube" ? item.audience === "yes" : null },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 15 * 60_000, fromJst(item.copy.at))).toISOString(),
    execution: "requires_separate_live_approval",
  };
}

const outcomes = ["scheduled", "published", "failed", "cancelled", "unknown"] as const;
type Outcome = typeof outcomes[number];

export function parseReceipt(input: string) {
  if (input.length > 16_384) throw new Error("結果JSONが大きすぎます。");
  const value = JSON.parse(input) as Record<string, unknown> | null;
  if (!value || value.schema !== receiptSchema || value.brandId !== brandId || typeof value.requestId !== "string" ||
    typeof value.videoVersion !== "string" || typeof value.sha256 !== "string" || typeof value.destination !== "string" || typeof value.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) ||
    !outcomes.includes(value.status as Outcome) || typeof value.evidence !== "string" || value.evidence.length > 300 ||
    ((value.status === "scheduled" || value.status === "published") && value.evidence.length > 200)) {
    throw new Error("投稿結果JSONの形式を確認してください。");
  }
  return { requestId: value.requestId, videoVersion: value.videoVersion, sha256: value.sha256,
    destination: value.destination, observedAt: Date.parse(value.observedAt), status: value.status as Outcome, evidence: value.evidence.trim() };
}

/** Import only after a person has verified the provider result. Receipts are not signed. */
export function importReceipt(state: PublisherState, input: string, now: number) {
  if (input.length > 16_384) throw new Error("結果JSONが大きすぎます。");
  const value = JSON.parse(input) as Record<string, unknown> | null;
  if (value?.schema === providerReceiptSchema) {
    const item = state.deliveries.find(row => row.requestId && row.requestId === value.requestId);
    if (value.brandId !== brandId || !item || item.versionId !== value.videoVersion || item.digest !== value.sha256 ||
      item.destination !== value.destination || value.approval !== approvalOf(item)) {
      throw new Error("結果と予約要求の承認版・投稿先が一致しません。");
    }
    const result = parseProvider(value);
    if (result.visibility !== (item.copy.visibility ?? "public") || result.scheduledAt !== item.copy.at + ":00+09:00" ||
      (result.notifySubscribers !== undefined && result.notifySubscribers !== (item.copy.notifySubscribers ?? false))) {
      throw new Error("承認した公開範囲または予定日時が一致しません。照合してください。");
    }
    return applyProvider(state, item, result, now, hash(result));
  }
  const receipt = parseReceipt(input);
  const index = state.deliveries.findIndex(item => item.requestId === receipt.requestId);
  const item: Delivery | undefined = state.deliveries[index];
  if (!item || item.versionId !== receipt.videoVersion || item.digest !== receipt.sha256 || item.destination !== receipt.destination) {
    throw new Error("結果と予約要求の動画版・投稿先が一致しません。");
  }
  const reference = receipt.status === "scheduled" || receipt.status === "published" ? item.reference : item.note;
  if (receipt.observedAt < item.at || receipt.observedAt > now + 60_000) throw new Error("結果の照合日時を確認してください。");
  if (item.state === receipt.status && (reference ?? "") === receipt.evidence) return false;
  if (item.resultObservedAt !== undefined && receipt.observedAt <= item.resultObservedAt) throw new Error("古い照合結果は取り込めません。");
  reconcile(state, index, receipt.status, receipt.evidence, now, receipt.observedAt);
  return true;
}
