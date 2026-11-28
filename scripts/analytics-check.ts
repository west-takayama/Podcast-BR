import assert from "node:assert/strict";
import { comparisons, merge, observation, parseImport, periods, schema, validate, type Row } from "../src/modules/analytics/model";
import { makeReport, markdown } from "../src/modules/analytics/report";
import { emptyBudget } from "../src/modules/budget/ledger";
import { emptyPublisher } from "../src/modules/publisher/model";

const at = Date.parse("2026-11-12T03:00:00Z");
const fields: Row = { platform: "instagram", source: "metricool", quality: "measured", metric: "plays", definition: "IGEV05",
  start: "2026-11-09", end: "2026-11-11", acquiredAt: new Date(at).toISOString(), unit: "count", value: 12 };
const envelope = (rows: unknown[]) => JSON.stringify({ schema, rows });
assert.deepEqual(parseImport(envelope([fields])), [fields]);
const csv = "platform,source,quality,metric,definition,start,end,acquiredAt,unit,value,entity\r\n" +
  'instagram,metricool,missing,plays,IGEV05,2026-11-09,2026-11-11,2026-11-12T03:00:00Z,count,,"post-96"';
assert.equal(parseImport("\uFEFF" + csv)[0].value, null);
assert.throws(() => parseImport(envelope([{ ...fields, apiKey: "anything" }])));
assert.throws(() => parseImport(envelope([{ ...fields, entity: "user@example.com" }])));
assert.throws(() => parseImport(envelope([{ ...fields, definition: "YTEV02" }])));
assert.throws(() => validate({ ...fields, start: "2026-02-31" }));
assert.throws(() => validate({ ...fields, value: null }));
assert.throws(() => validate({ ...fields, value: -1 }));
assert.throws(() => validate({ ...fields, postedAt: "2026-11-12T03:00:00Z" }));
assert.equal(merge([fields], [fields]).changed, 0);
assert.throws(() => merge([fields], [{ ...fields, value: 11 }]));
const latest = { ...fields, value: 19, acquiredAt: "2026-11-13T00:00:00.000Z" };
assert.deepEqual(merge([fields], [latest, fields]), { changed: 1, rows: [latest] });
assert.equal(merge([latest], [{ ...latest, acquiredAt: "2026-11-13T00:00:00Z" }]).changed, 0);
const windows = periods(at);
assert.deepEqual(windows.week, { start: "2026-11-09", end: "2026-11-11" });
assert.deepEqual(windows.previousWeek, { start: "2026-11-02", end: "2026-11-04" });
const monday = periods(Date.parse("2027-02-01T00:00:00+09:00"));
assert.equal(observation([], monday.week).value, null);
assert.ok(monday.week.start > monday.week.end);
assert.ok(monday.month.start > monday.month.end);
const daily = ["09", "10", "11"].map(n => ({ ...fields, start: "2026-11-" + n, end: "2026-11-" + n, value: Number(n) }));
assert.equal(observation(daily, windows.week).value, 30);
assert.equal(observation(daily.slice(0, 2), windows.week).value, null);
assert.equal(observation([...daily, fields], windows.week).value, 12);
const snapshots = daily.slice(1).map(row => ({ ...row, metric: "followers" as const, definition: "IGEV01" }));
assert.equal(observation(snapshots, windows.week).value, 11);
assert.equal(observation(snapshots.slice(0, 1), windows.week).value, null);
const youtube = { ...fields, platform: "youtube", definition: "YTEV02" } as const;
assert.equal(comparisons([fields, youtube], at).length, 2);

const budget = emptyBudget();
budget.operating = [{ id: "local", at, amount: 200_000_000, label: "固定費" }];
budget.entries = [
  { id: "a", state: "estimated", mode: "postpaid", month: "2026-11", at: at - 86_400_000, reserved: 0, estimate: 4_000_000,
    attempt: 2, purpose: "captions", episodeId: "episode-a", success: false, elapsedMs: 2000 },
  { id: "b", state: "cache", mode: "free", month: "2026-11", at: at - 86_400_000, reserved: 0, attempt: 0, purpose: "captions" },
  { id: "c", state: "unknown", mode: "postpaid", month: "2026-11", at, reserved: 5_000_000, attempt: 1, purpose: "analysis" },
];
const sns = emptyPublisher();
sns.deliveries = [{ candidateId: "candidate", versionId: "1", destination: "instagram", digest: "digest", at: at - 86_400_000,
  state: "confirmation", copy: { title: "", text: "", hashtags: "", at: "" },
  provider: { postId: "post-a", approval: "", raw: "RAW-EXCLUDED", apiState: "AWAITING_CONFIRMATION", visibility: "public", scheduledAt: "", observedAt: at } }];
const input = { episodes: [], sns, podcast: [], budget, timings: [] };
const report = makeReport([fields, { ...fields, definition: "IGRE13", entity: "post-a", value: 20 },
  { ...fields, definition: "IGRE13", entity: "post-b", value: 10 }], input, at);
assert.match(report.recommendations.join(), /post-a/);
assert.equal(report.delivery.confirmation, 1);
assert.equal(report.metrics[1].candidateId, "candidate");
assert.equal(report.requestStats.reuseRate, 0.5);
assert.equal(report.finance.actualGeminiYen, null);
assert.equal(report.finance.estimatedGeminiYen, 4);
assert.equal(report.finance.failureRetryEstimatedYen, 4);
assert.equal(report.finance.remainingYen, 1791);
assert.equal(report.finance.costByEpisode[0].episodeId, "episode-a");
assert.ok(!JSON.stringify(report).includes("RAW-EXCLUDED"));
assert.match(markdown(report), /未取得/);
assert.match(markdown(report), /残予算/);
assert.match(makeReport([], input, at).recommendations[0], /評価は保留/);
console.log("OK analytics imports, period comparison, privacy, ledger and reporting");
const lifetime = validate({ ...fields, entity: "post-2", definition: "IGRE23", start: fields.end, basis: "lifetime" });
assert.equal(observation([lifetime], { start: fields.end, end: fields.end }).value, null);
assert.equal(merge([lifetime], [validate({ ...lifetime, basis: "interval" })]).rows.length, 2);
assert.throws(() => validate({ ...fields, entity: "post-2", basis: "lifetime" }));
