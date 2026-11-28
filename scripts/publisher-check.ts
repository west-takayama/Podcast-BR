import assert from "node:assert/strict";
import { approve, beginHandoff, draftKey, emptyPublisher, fromJst, makeDraft, monthOf, proposal, quota, reconcile, type Candidate } from "../src/modules/publisher/model";

const now = Date.parse("2026-11-28T10:00:00+09:00");
assert.equal(monthOf(fromJst("2026-12-01T00:00")), "2026-12");
assert.equal(fromJst("2026-12-01T00:00"), Date.parse("2026-11-30T15:00Z"));
assert.equal(proposal(now, false).measured, true);
assert.equal(new Set(Object.values(proposal(now, false).slots)).size, 1);
assert.equal(new Set(Object.values(proposal(now, true).slots)).size, 3);
assert.equal(proposal(now + 30 * 86_400_000, false).measured, false);
const candidate: Candidate = { candidateId: "candidate", versionId: "v1", manifestId: "manifest", videoId: "video", filename: "short.mp4",
  mime: "video/mp4", title: "確認用", description: "投稿文", hashtags: ["#確認"], startMs: 0, endMs: 8000 };
const state = emptyPublisher();
const key = draftKey(candidate);
const draft = state.drafts[key] = makeDraft(candidate, now);
assert.throws(() => beginHandoff(state, key, "instagram", "media", now), /承認済み/);
draft.state = "review";
assert.throws(() => approve(state, [key], now), /子ども向け/);
draft.audience = "no";
approve(state, [key], now);
const item = beginHandoff(state, key, "instagram", "media", now);
assert.equal(item.state, "sending");
assert.throws(() => beginHandoff(state, key, "instagram", "media", now), /同じ動画/);
reconcile(state, 0, "unknown", "", now);
assert.throws(() => beginHandoff(state, key, "instagram", "media", now), /同じ動画/);
assert.throws(() => reconcile(state, 0, "failed", "", now), /確認した結果/);
reconcile(state, 0, "failed", "Planner確認済み・未登録", now);
beginHandoff(state, key, "instagram", "media", now);
reconcile(state, 1, "scheduled", "remote-1", now);
assert.throws(() => reconcile(state, 1, "failed", "削除", now), /取消/);
reconcile(state, 1, "cancelled", "Planner取消確認", now);
beginHandoff(state, key, "instagram", "media", now);
reconcile(state, 2, "published", "remote-2", now);
const revised = { ...candidate, versionId: "v2", title: "別バージョン" };
state.drafts[draftKey(revised)] = makeDraft(revised, now);
assert.throws(() => beginHandoff(state, draftKey(revised), "instagram", "changed media", now), /承認済み/);
state.drafts[draftKey(revised)].state = "review";
state.drafts[draftKey(revised)].audience = "no";
approve(state, [draftKey(revised)], now);
assert.throws(() => beginHandoff(state, draftKey(revised), "instagram", "changed media", now), /同じ動画/);
state.other["2026-11"] = 19;
assert.equal(quota(state, "2026-11"), 20);
assert.throws(() => beginHandoff(state, key, "tiktok", "media", now), /無料投稿枠/);
assert.equal(state.audit.length, 8);
console.log("OK: JST, proposals, approval, deduplication, result verification, retry/cancel, free quota");

const { makeRequest, importReceipt, receiptSchema, brandId } = await import("../src/modules/publisher/exchange");
const packets = emptyPublisher();
const approved = makeDraft(candidate, now);
approved.state = "approved";
approved.audience = "no";
packets.drafts[key] = approved;
const digest = "c".repeat(64);
const delivery = beginHandoff(packets, key, "youtube", digest, now);
const request = makeRequest(packets, delivery.requestId!, now);
assert.equal(request.media.sha256, digest);
assert.equal(request.post.madeForKids, false);
assert.equal(request.execution, "requires_separate_live_approval");
assert.equal(request.post.publishAt.endsWith("+09:00"), true);
assert.equal(Date.parse(request.expiresAt) - now, 15 * 60_000);
approved.state = "candidate";
assert.throws(() => makeRequest(packets, delivery.requestId!, now), /変わりました/);
approved.state = "approved";
const receipt = { schema: receiptSchema, brandId, requestId: request.requestId, videoVersion: candidate.versionId,
  sha256: digest, destination: "youtube", observedAt: new Date(now).toISOString(), status: "scheduled", evidence: "external-fixture" };
assert.throws(() => importReceipt(packets, JSON.stringify({ ...receipt, sha256: "different" }), now), /一致しません/);
assert.equal(importReceipt(packets, JSON.stringify(receipt), now), true);
assert.equal(importReceipt(packets, JSON.stringify(receipt), now), false);
assert.equal(packets.deliveries[0].reference, "external-fixture");
assert.throws(() => importReceipt(packets, JSON.stringify({ ...receipt, status: "unknown" }), now), /古い照合/);
console.log("OK: approved exchange, expiry, matching receipts, replay protection");

const { verifyOnDevice } = await import("../src/modules/publisher/providerResult");
const { matchesFilter } = await import("../src/modules/publisher/dashboard");
const { providerReceiptSchema } = await import("../src/modules/publisher/exchange");
const proof = emptyPublisher();
const proofDraft = makeDraft(candidate, now);
proofDraft.plan.youtube!.visibility = "private";
proofDraft.plan.youtube!.notifySubscribers = false;
proofDraft.plan.tiktok!.visibility = "SELF_ONLY";
proofDraft.plan.instagram!.visibility = "draft";
proofDraft.state = "approved";
proofDraft.audience = "no";
proof.drafts[key] = proofDraft;
const evidenceFor = (network: "youtube" | "tiktok" | "instagram", provider: Record<string, unknown>) => {
  const item = beginHandoff(proof, key, network, digest, now);
  const request = makeRequest(proof, item.requestId!, now);
  const payload = { schema: providerReceiptSchema, brandId, requestId: request.requestId, videoVersion: request.videoVersion,
    sha256: digest, approval: request.approval, destination: network, observedAt: new Date(now + 2000).toISOString(),
    provider: { scheduledAt: request.post.publishAt, visibility: request.post.intendedVisibility, ...provider } };
  return { item, payload, request };
};
// Synthetic identifiers; provider states mirror the observations supplied by operations.
const yt = evidenceFor("youtube", { postId: "mock-youtube", videoId: "mock-clip", apiState: "PUBLISHED",
  notifySubscribers: false, raw: '{"status":"PUBLISHED","privacy":"private","notifySubscribers":false}' });
const tt = evidenceFor("tiktok", { postId: "mock-tiktok", responseId: "mock-response", apiState: "AWAITING_CONFIRMATION", detail: "Published",
  raw: '{"status":"AWAITING_CONFIRMATION","detail":"Published","privacy":"SELF_ONLY"}' });
const ig = evidenceFor("instagram", { postId: "mock-instagram", apiState: "DRAFT", draft: true, autoPublish: false,
  raw: '{"draft":true,"autoPublish":false}' });
assert.equal(yt.request.post.notifySubscribers, false);
assert.equal(ig.request.post.autoPublish, false);
for (const fixture of [yt, tt, ig]) {
  assert.equal(importReceipt(proof, JSON.stringify(fixture.payload), now + 2000), true);
  assert.equal(importReceipt(proof, JSON.stringify(fixture.payload), now + 2000), false);
}
assert.equal(yt.item.state, "published");
assert.equal(yt.item.device, undefined);
assert.equal(tt.item.state, "confirmation");
assert.equal(ig.item.state, "draft");
assert(matchesFilter(tt.item, "waiting", now));
assert.throws(() => beginHandoff(proof, key, "tiktok", digest, now), /同じ動画/);
verifyOnDevice(proof, 1, "確認担当", "非公開一覧で確認", now + 4000);
assert.equal(tt.item.provider?.apiState, "AWAITING_CONFIRMATION");
assert(matchesFilter(tt.item, "published", now));
assert(!matchesFilter(tt.item, "waiting", now));
assert.throws(() => importReceipt(proof, JSON.stringify({ ...tt.payload, observedAt: new Date(now + 1000),
  provider: { ...tt.payload.provider, apiState: "SCHEDULED" } }), now + 5000), /古い結果/);
assert.throws(() => importReceipt(proof, JSON.stringify({ ...tt.payload, observedAt: new Date(now + 5000),
  provider: { ...tt.payload.provider, apiState: "FAILED" } }), now + 5000), /実機確認済み/);
assert.throws(() => importReceipt(proof, JSON.stringify({ ...ig.payload, observedAt: new Date(now + 8000),
  provider: { ...ig.payload.provider, draft: false, autoPublish: true, apiState: "PUBLISHED" } }), now + 8000), /下書き/);
proof.confirmedQuota = { "2026-11": { count: 20, at: now + 7000 } };
const nextDraft = { ...makeDraft({ ...candidate, candidateId: "next" }, now), state: "approved" as const };
proof.drafts[draftKey(nextDraft.candidate)] = nextDraft;
assert.throws(() => beginHandoff(proof, draftKey(nextDraft.candidate), "instagram", "a".repeat(64), now + 8000), /無料投稿枠/);
console.log("OK: YouTube private PUBLISHED, TikTok confirmation/device separation, Instagram draft, replay and quota");
