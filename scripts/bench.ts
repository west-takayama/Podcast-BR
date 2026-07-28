// 旧構成(lamejs・一括展開)と新構成(WASM・ストリーミング)の比較。
// 実行: npx tsx scripts/bench.ts
import { Mp3Encoder } from "@breezystack/lamejs";
import { Analyzer, HighPassFilter, NoiseReducer, applyGain } from "../src/lib/audio/dsp";
import { decodeBlock, parseWavHeader } from "../src/lib/audio/wav";
import { Mp3Stream } from "../src/lib/audio/mp3";

const SR = 44100, MIN = 5, CH = 2;
const frames = SR * 60 * MIN;
const buf = new ArrayBuffer(44 + frames * CH * 2);
const v = new DataView(buf);
const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
w(0,"RIFF"); v.setUint32(4,36+frames*CH*2,true); w(8,"WAVE"); w(12,"fmt ");
v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,CH,true);
v.setUint32(24,SR,true); v.setUint32(28,SR*CH*2,true); v.setUint16(32,CH*2,true); v.setUint16(34,16,true);
w(36,"data"); v.setUint32(40,frames*CH*2,true);
for (let i=0;i<frames;i++) { const s=Math.round(8000*Math.sin(2*Math.PI*440*i/SR)); v.setInt16(44+i*CH*2,s,true); v.setInt16(46+i*CH*2,s,true); }

(async () => {
  const info = parseWavHeader(buf);
  const BLOCK = SR * 10;
  const block = Array.from({length: CH}, () => new Float32Array(BLOCK));
  const readBlock = (b: number) => {
    const start = b * BLOCK, n = Math.min(BLOCK, info.frameCount - start);
    const off = info.dataOffset + start * info.bytesPerFrame;
    decodeBlock(buf.slice(off, off + n * info.bytesPerFrame), info, n, block);
    return n;
  };
  const totalBlocks = Math.ceil(info.frameCount / BLOCK);

  // --- 新構成: 2パス・ストリーミング・WASM・モノラル96k + AI用32k ---
  let t = Date.now();
  const an = new Analyzer(SR);
  const hpA = new HighPassFilter(SR, CH);
  for (let b = 0; b < totalBlocks; b++) { const n = readBlock(b); hpA.process(block, n); an.push(block, n); }
  const { noiseFloor, gain } = an.result();
  const tAnalyze = Date.now() - t;

  t = Date.now();
  const pub = new Mp3Stream(1, SR, 96);
  const ai = new Mp3Stream(1, SR, 32);
  const hp = new HighPassFilter(SR, CH), nr = new NoiseReducer(SR, noiseFloor);
  const mono = new Float32Array(BLOCK);
  for (let b = 0; b < totalBlocks; b++) {
    const n = readBlock(b);
    hp.process(block, n); nr.process(block, n); applyGain(block, n, gain);
    for (let i = 0; i < n; i++) mono[i] = (block[0][i] + block[1][i]) * 0.5;
    const view = mono.subarray(0, n);
    await pub.write([view], n); await ai.write([view], n);
  }
  const [pubBuf, aiBuf] = await Promise.all([pub.finish(), ai.finish()]);
  const tProcess = Date.now() - t;

  // --- 旧構成: 一括展開 + lamejs ステレオ128k ---
  t = Date.now();
  const all = Array.from({length: CH}, () => new Float32Array(info.frameCount));
  decodeBlock(buf.slice(info.dataOffset), info, info.frameCount, all);
  const hpOld = new HighPassFilter(SR, CH); hpOld.process(all, info.frameCount);
  const anOld = new Analyzer(SR); anOld.push(all, info.frameCount);
  new NoiseReducer(SR, anOld.result().noiseFloor).process(all, info.frameCount);
  const enc = new Mp3Encoder(2, SR, 128);
  const toI16 = (f: Float32Array) => { const o = new Int16Array(f.length); for (let i=0;i<f.length;i++){const x=f[i];o[i]=x<0?x*32768:x*32767;} return o; };
  const L = toI16(all[0]), R = toI16(all[1]);
  let oldSize = 0;
  for (let i = 0; i < L.length; i += 1152*32) oldSize += enc.encodeBuffer(L.subarray(i,i+1152*32), R.subarray(i,i+1152*32)).length;
  oldSize += enc.flush().length;
  const tOld = Date.now() - t;

  const peakMemOld = (info.frameCount * CH * 4 * 2) / 1024 / 1024; // Float32 + Int16変換
  const peakMemNew = (BLOCK * CH * 4 * 2) / 1024 / 1024;
  const scale = 60 / MIN;
  console.log(`\n=== ${MIN}分ステレオ素材(60分換算)===\n`);
  console.log(`旧: ${(tOld/1000).toFixed(1)}秒  →  60分で ${(tOld*scale/1000/60).toFixed(1)}分`);
  console.log(`新: ${((tAnalyze+tProcess)/1000).toFixed(1)}秒 (解析${(tAnalyze/1000).toFixed(1)} + 変換${(tProcess/1000).toFixed(1)})  →  60分で ${((tAnalyze+tProcess)*scale/1000/60).toFixed(1)}分`);
  console.log(`高速化: ${(tOld/(tAnalyze+tProcess)).toFixed(1)}倍\n`);
  console.log(`配信用MP3   旧 ${(oldSize/1024/1024).toFixed(1)}MB → 新 ${(pubBuf.byteLength/1024/1024).toFixed(1)}MB  (60分で ${(pubBuf.byteLength/1024/1024*scale).toFixed(0)}MB)`);
  console.log(`AI送信量    旧 ${(oldSize/1024/1024).toFixed(1)}MB → 新 ${(aiBuf.byteLength/1024/1024).toFixed(1)}MB  (60分で ${(aiBuf.byteLength/1024/1024*scale).toFixed(0)}MB) = ${(oldSize/aiBuf.byteLength).toFixed(1)}分の1`);
  console.log(`\nピークメモリ(60分)  旧 ${(peakMemOld*scale).toFixed(0)}MB → 新 ${peakMemNew.toFixed(0)}MB`);
})();
