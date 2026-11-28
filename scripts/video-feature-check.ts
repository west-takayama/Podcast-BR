import assert from "node:assert/strict";
import { qualityClips, newFeature, canHandoffShort, linkPublishedFeature, parseShortParent, youtubeId } from "../src/modules/video/feature";
import { applySeriesSchedule, observedHours, planQuotaWarnings } from "../src/modules/publisher/featureSchedule";
import { beginHandoff, emptyPublisher, fromJst, localDate, makeDraft, type Candidate } from "../src/modules/publisher/model";
import { makeRequest } from "../src/modules/publisher/exchange";
import type { Row } from "../src/modules/analytics/model";

const fallback = { start: "00:00", end: "00:30", hook: "未評価", why: "旧候補" };
const scores = { interest: 24, insight: 22, hook: 15, empathy: 14, completeness: 14 };
assert.deepEqual(qualityClips([fallback, { ...fallback, scores, needsReview: true }]), []);
assert.deepEqual(qualityClips([{ ...fallback, scores }]).length, 1);
assert.equal(youtubeId("https://www.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
assert.throws(() => youtubeId("https://www.youtube.com.example/watch?v=abcdefghijk"));
assert.equal(youtubeId("https://youtu.be/abcdefghijk?si=test"), "abcdefghijk");
assert.throws(() => youtubeId("https://user@youtu.be/abcdefghijk"));
const parent = parseShortParent({ episodeId: "episode-42", title: "選抜の本編", number: "42" })!;
assert.throws(() => parseShortParent({ ...parent, number: "" }));
const now = Date.parse("2026-11-28T03:00:00Z");
const day = 86400000;
const selected = { ...newFeature(parent.episodeId), ...parent, selected: true, approval: { digest: "a".repeat(64), at: now - day } };
assert.throws(() => canHandoffShort(parent, selected, now + day, now));
assert.throws(() => canHandoffShort(parent, { ...selected, handoff: "unknown" }, now + day, now));
const archived = linkPublishedFeature({ ...newFeature(parent.episodeId), selected: true }, {}, parent, "abcdefghijk", now - day, now);
assert.equal(canHandoffShort(parent, archived, now + day, now).youtubeId, "abcdefghijk");
assert.equal(archived.approval, undefined);
assert.throws(() => linkPublishedFeature(selected, {}, parent, "abcdefghijk", now - day, now));
assert.throws(() => linkPublishedFeature({ ...newFeature("other"), selected: true }, { archive: archived },
  { ...parent, episodeId: "other" }, "abcdefghijk", now - day, now), /登録済み/);
assert.throws(() => linkPublishedFeature({ ...newFeature(parent.episodeId), selected: true }, {}, parent, "abcdefghijk", now + day, now));
const published = { ...selected, handoff: "published" as const, youtubeId: "abcdefghijk", publishedAt: now - 1000 };
assert.throws(() => canHandoffShort(parent, { ...published, selected: false }, now + day, now));
assert.throws(() => canHandoffShort(parent, published, now - day, now));
assert.throws(() => canHandoffShort({ ...parent, title: "別版" }, published, now + day, now));

const state = emptyPublisher();
const candidate: Candidate = { candidateId: "x", versionId: "1", videoId: "video", manifestId: "manifest", filename: "movie.mp4",
  mime: "video/mp4", parent, title: "候補", description: parent.title, hashtags: [], startMs: 0, endMs: 30_000 };
for (const key of ["x:1", "y:1"]) {
  state.drafts[key] = makeDraft({ ...candidate, candidateId: key[0] }, now);
  state.drafts[key].audience = "no";
  state.drafts[key].state = "approved";
}
applySeriesSchedule(state, ["x:1", "y:1"], now, now, { youtube: 15 });
assert.equal(state.drafts["x:1"].state, "review");
assert.match(state.drafts["y:1"].plan.youtube!.at, /T15:00$/);
assert.ok(fromJst(state.drafts["y:1"].plan.youtube!.at) > fromJst(state.drafts["x:1"].plan.youtube!.at));
state.other[localDate(now).slice(0, 7)] = 20;
assert.deepEqual(planQuotaWarnings(state, ["x:1"]), ["2026-11"]);
state.other = {};
state.drafts["x:1"].state = "approved";
assert.throws(() => beginHandoff(state, "x:1", "youtube", "a".repeat(64), now));
const item = beginHandoff(state, "x:1", "youtube", "a".repeat(64), now, published);
assert.throws(() => makeRequest(state, item.requestId!, now), /公開確認/);
assert.equal(makeRequest(state, item.requestId!, now, published).parent?.youtubeId, published.youtubeId);
assert.throws(() => beginHandoff(state, "x:1", "youtube", "b".repeat(64), now, published));

state.drafts["y:1"].state = "approved";
assert.throws(() => beginHandoff(state, "y:1", "youtube", "c".repeat(64), now, archived), /同じ動画/);
state.drafts["y:1"].candidate = { ...state.drafts["y:1"].candidate, startMs: 30000, endMs: 60000 };
assert.ok(beginHandoff(state, "y:1", "youtube", "c".repeat(64), now, archived));

const observations: Row[] = [10, 11, 25, 22].map((value, index) => ({
  platform: "youtube", source: "metricool", definition: "YTVP06", unit: "count", quality: "measured", metric: "plays",
  entity: "post-" + index, value, start: "2026-11-21", end: "2026-11-25", acquiredAt: "2026-11-26T00:00:00Z",
  postedAt: index < 2 ? "2026-11-23T00:00:00Z" : "2026-11-23T07:00:00Z",
}));
assert.deepEqual(observedHours(observations.slice(0, 3), now), {});
assert.deepEqual(observedHours(observations, now), { youtube: 15 });
console.log("OK selected and zero shorts, parent linkage, post-publication gate, duplicate and planned quota");
