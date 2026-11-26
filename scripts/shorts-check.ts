import assert from 'node:assert/strict';
import { __testNormalizeClips, transcribeRange } from '../src/lib/gemini';
import { captionsForRange } from '../src/lib/video/clip';
const raw = { start: '00:10', end: '00:40', hook: '気づき', why: '完結した対話', scores: { interest: 25, insight: 23, hook: 18, empathy: 14, completeness: 15 }, socialPost: '対話を続けよう', hashtags: ['#BRIDGE_RADIO', '対話'] };
const clips = __testNormalizeClips([raw, raw], 60);
assert.equal(clips.length, 1, 'identical cuts must not consume another export');
assert.deepEqual(clips[0].scores, raw.scores);
assert.equal(clips[0].socialPost, raw.socialPost);
assert.deepEqual(clips[0].hashtags, ['#BRIDGE_RADIO', '#対話']);
assert.equal(__testNormalizeClips([{...raw, end: '02:00'}], 60)[0].needsReview, true, 'repaired bounds must require editorial review');
assert.equal(__testNormalizeClips([{...raw, scores: {...raw.scores, interest: 99}}])[0].scores, undefined, 'invalid scores must not become fabricated ratings');
const captions = captionsForRange([{time:'00:00',text:'対話の価値',speaker:'A',emphasis:['価値']},{time:'00:01',text:'そうだね',speaker:'B'}],0,1.1);
assert.equal(captions[0].speaker, 'A');
assert.deepEqual(captions[0].emphasis, ['価値']);
assert.ok(captions.every(c => c.endSec <= 1.1 && c.endSec > c.atSec));
const original = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments:[{time:'bad',text:'無効'},{time:'00:03',text:'範囲外'},{time:'00:01.0',speaker:'A',text:'対話の価値',emphasis:['価値','捏造']}]})}]}}]}),{status:200});
try {
 const lines = await transcribeRange({apiKey:'test',model:'gemini-test',audio:{uri:'test',name:'test',expiresAt:Date.now()+100000,bytes:1},startSec:0,endSec:2,speakers:'A',onStatus:()=>{}});
 assert.equal(lines.length,1);
 assert.deepEqual(lines[0].emphasis,['価値']);
} finally { globalThis.fetch=original; }
console.log('shorts-check: OK (deduplication, rubric, captions, range bounds, emphasis)');
