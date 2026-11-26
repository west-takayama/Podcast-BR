import assert from 'node:assert/strict';
import { generateEpisodeMeta, type UploadedAudio } from '../src/lib/gemini';
import { DEFAULT_PROMPT_CONFIG } from '../src/lib/prompt';

const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
const originalInfo = console.info;
let uploads = 0, requests = 0;
const logs: unknown[][] = [];
const source: UploadedAudio = { name: 'files/private-name', uri: 'private-uri', expiresAt: Date.now() + 60_000, bytes: 8 };
class MockXHR {
  upload = {};
  status = 200;
  responseText = JSON.stringify({file: {...source, state: 'ACTIVE'}});
  onload?: () => void;
  open() {}
  setRequestHeader() {}
  send() { uploads++; queueMicrotask(() => this.onload?.()); }
  abort() {}
}
try {
  globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
  console.info = (...args) => logs.push(args);
  globalThis.fetch = async () => {
    requests++;
    const text = requests % 2 === 1 ? '{}' : JSON.stringify({titles: ['声の残し方'], description: '会話の具体的な記録。'});
    return new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'ignore'}, {text}]},finishReason:'STOP'}]}));
  };
  for (let i = 0; i < 3; i++) {
    uploads = requests = 0;
    const result = await generateEpisodeMeta({apiKey:'private-key', model:'test', mp3:new ArrayBuffer(8), config:DEFAULT_PROMPT_CONFIG, onStatus() {}});
    assert.equal(result.titles[0], '声の残し方');
    assert.equal(requests, 2, 'one bounded slim retry');
    assert.equal(uploads, 1, 'slim retry must reuse uploaded audio');
  }
  uploads = requests = 0;
  await generateEpisodeMeta({apiKey:'private-key', model:'test', audio:source, config:DEFAULT_PROMPT_CONFIG, onStatus() {}});
  assert.equal(uploads, 0, 'valid source needs no upload');
  assert.equal(requests, 2);
  uploads = requests = 0;
  let uploadedCallbacks = 0;
  await generateEpisodeMeta({apiKey:'private-key', model:'test', audio:{...source, expiresAt:0}, mp3:new ArrayBuffer(8), config:DEFAULT_PROMPT_CONFIG, onStatus() {}, onUploaded() { uploadedCallbacks++; }});
  assert.equal(uploads, 1, 'expired source is replaced once');
  assert.equal(uploadedCallbacks, 1, 'caller receives reusable source exactly once');
  assert.equal(requests, 2);
  globalThis.fetch = async () => new Response('invalid', {status:400});
  await assert.rejects(generateEpisodeMeta({apiKey:'private-key', model:'test', audio:source, config:DEFAULT_PROMPT_CONFIG, onStatus() {}}));
  assert.ok(logs.some(args => (args[1] as {stage?:string;success?:boolean})?.stage === 'metadata-total' && (args[1] as {success?:boolean}).success === false), 'failed workflows are timed');
  assert.ok(!JSON.stringify(logs).includes('private-'), 'diagnostics must not expose credentials or file references');
  console.log('PASS: 3 fresh-upload retry runs: 1 upload / 2 generations each; cached run: 0 uploads / 2 generations; no private diagnostics');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
  console.info = originalInfo;
}
