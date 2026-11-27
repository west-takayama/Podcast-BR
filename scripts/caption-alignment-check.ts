import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { alignCues, detectActivity, displayCueAt, type CaptionCue } from "../src/lib/video/captionAlignment";
import { addSpeaker, displayCues, swapSpeakerNames, type Speaker } from "../src/lib/video/speakers";
import { captionsForRange } from "../src/lib/video/clip";

const starts = [420, 2110, 3200, 4900, 7680, 9400, 10130, 13150];
const ends = [1030, 2770, 3790, 6500, 7990, 9880, 10990, 13810];
const texts = ["あの、本当ですか", "はい", "それでもこの話は終わりではありません", "聞き取れますか、すぐ次に移りましょう", "（笑い）", "そうですね", "そこが一番の違いです", "それではまた"];
const duration = 15000;
const rate = 16000;
const pcm = new Float32Array(duration * rate / 1000);
for (const [i, start] of starts.entries()) {
  for (let frame = start * rate / 1000; frame < ends[i] * rate / 1000; frame++) {
    pcm[frame] = Math.sin(2 * Math.PI * (180 + i * 40) * frame / rate) * 0.18;
  }
}
const activity = detectActivity([new Float32Array(pcm.length), pcm], rate);
assert.deepEqual(activity, starts.map((startMs, i) => ({startMs, endMs: ends[i]})));
const baseOffset = 47 * 60 + 12.345;
const legacyTime = (sec: number) => {
  const t = Math.round(sec * 10);
  return `${Math.floor(t / 600)}:${((t % 600) / 10).toFixed(1).padStart(4, "0")}`;
};
const levels = new Float32Array(duration / 50);
for (let i = 0; i < levels.length; i++) {
  const block = pcm.subarray(i * 800, (i + 1) * 800);
  levels[i] = Math.sqrt(block.reduce((n, x) => n + x * x, 0) / block.length);
}
const stats = (values: number[]) => {
  const sorted = values.map(Math.abs).sort((a,b) => a-b);
  const n = sorted.length;
  return { mae: Math.round(sorted.reduce((a,b) => a+b) / n), median: Math.round((sorted[Math.floor((n-1)/2)] + sorted[Math.ceil((n-1)/2)]) / 2), p95: Math.round(sorted[Math.ceil(n * 0.95)-1]) };
};

const offsets = [
  { name: "constant", values: starts.map(() => 180) },
  { name: "per-utterance", values: [120, -90, 190, -100, 70, -150, 210, -100] },
  { name: "cumulative", values: [0, 30, 60, 90, 120, 150, 180, 210] },
];
for (const scenario of offsets) {
  const raw: CaptionCue[] = starts.map((start, i) => ({
    startMs: start + scenario.values[i], endMs: ends[i] + scenario.values[i],
    text: texts[i], speakerId: ["A","B","C"][i%3], needsReview: false, emphasis: [],
  }));
  const old = () => captionsForRange(raw.map(cue => ({
    time: legacyTime(baseOffset + cue.startMs! / 1000), text: cue.text, speaker: cue.speakerId,
  })), baseOffset, baseOffset + duration / 1000, levels);
  const aligned = alignCues(raw, activity, duration);
  const legacy = old();
  // Concatenate split pages to identify all rendered pieces for each original cue.
  const matched = [];
  let cursor = 0;
  for (const text of texts) {
    const pieces = [];
    let joined = "";
    while (cursor < legacy.length && joined.length < text.length) {
      const piece = legacy[cursor++];
      pieces.push(piece); joined += piece.text;
    }
    assert.equal(joined, text);
    matched.push({ startMs: (pieces[0].atSec - baseOffset) * 1000, endMs: (pieces.at(-1)!.endSec - baseOffset) * 1000 });
  }
  const measures = (cues: {startMs: number | null; endMs: number | null}[]) => ({
    start: stats(cues.map((cue,i) => cue.startMs! - starts[i])),
    end: stats(cues.map((cue,i) => cue.endMs! - ends[i])),
  });
  const time = <T>(op: () => T) => {
    const samples = [];
    for (let batch = 0; batch < 5; batch++) {
      const started = performance.now();
      for (let i = 0; i < 250; i++) op();
      samples.push((performance.now() - started) / 250);
    }
    return Number(samples.sort((a,b) => a-b)[2].toFixed(3));
  };
  console.log(JSON.stringify({ scenario: scenario.name, old: measures(matched), next: measures(aligned),
    oldMs: time(old), alignedMs: time(() => alignCues(raw, activity, duration)) }));
  assert.deepEqual(aligned.map(cue => cue.startMs), starts);
  assert.deepEqual(aligned.map(cue => cue.endMs), ends);
}
const overlapping: CaptionCue[] = [
  { startMs: 100, endMs: 600, text: "あの", speakerId: "A", emphasis: ["あの", "存在しない語"], needsReview: false },
  { startMs: 400, endMs: 710, text: "はい", speakerId: "B", emphasis: [], needsReview: false },
  { startMs: null, endMs: null, text: "（聞き取り不明）", speakerId: "C", emphasis: [], needsReview: true },
];
const checked = alignCues(overlapping, [], 1000);
assert.deepEqual(checked.map(cue => [cue.startMs, cue.endMs, cue.needsReview]), [[100,600,true],[400,710,true],[null,null,true]]);
let people: Speaker[] = [];
for (const name of ["たそ","ゲスト","進行"]) {
  people = addSpeaker(people);
  people[people.length-1].name = name;
}
const mapping = { A: "person-1", B: "person-2", C: "person-3" };
const rendered = displayCues(checked, people, mapping, 1000);
assert.equal(displayCueAt(rendered, 0.5)?.speaker, "ゲスト");
assert.equal(displayCueAt(rendered, 0.71), undefined);
assert.deepEqual(rendered[0].emphasis, ["あの"]);
assert.equal(displayCues(checked, people, {}, 1000)[0].speaker, "A");
assert.equal(displayCues(checked, people, { A: "person-3" }, 1000)[0].speaker, "進行");
const swapped = displayCues(checked, swapSpeakerNames(people, "person-1", "person-2"), mapping, 1000);
assert.equal(swapped[0].speaker, "ゲスト");
assert.equal(swapped[0].speakerColor, rendered[0].speakerColor);
console.log("caption-alignment: OK");

const { archivedCaptionCues } = await import("../src/lib/video/archivedCaptions");
const { readEpisodeDraft, saveEpisodeDraft } = await import("../src/lib/video/episodeCaptionCache");
const transcript = [
  { time: "00:01.000", text: "冒頭", speaker: "A" },
  { time: "00:12.250", text: "区間内", speaker: "B" },
  { time: "00:15.000", text: "境界", speaker: "A" },
  { time: "00:40.000", text: "後半", speaker: "C" },
];
const archived = archivedCaptionCues(transcript, 12, 15, 40);
assert.deepEqual(archived?.map(cue => [cue.startMs, cue.endMs, cue.speakerId, cue.needsReview]), [[250, null, "B", true]]);
assert.equal(archivedCaptionCues(transcript.slice(0, 2), 12, 25, 40), null, "truncated transcript must not replace short transcription");
assert.equal(archivedCaptionCues(transcript, 19, 24, 40), null, "no stored utterance in this range");
saveEpisodeDraft("archived-test", "[12,15]", archived!);
assert.equal(readEpisodeDraft("archived-test", "[12,15]"), archived);
assert.equal(readEpisodeDraft("other-episode", "[12,15]"), undefined);
assert.equal(readEpisodeDraft("archived-test", "[13,15]"), undefined);
console.log("archived captions and exact-range episode cache: OK");
