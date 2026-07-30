// 規格の基準: -20dBFS の 1kHz 正弦波をステレオ(L=R)に入れると -20.0 LUFS
import { LoudnessMeter, targetLufs, gainForTarget } from "../src/lib/audio/loudness";
import { CEILING_DBFS, Limiter } from "../src/lib/audio/limiter";
import { Analyzer, HighPassFilter, NoiseReducer, applyGain } from "../src/lib/audio/dsp";

let failures = 0;
function assert(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const SR = 48000;
function sine(freq: number, amp: number, sec: number): Float32Array {
  const a = new Float32Array(Math.round(SR * sec));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}
const AMP = Math.pow(10, -20 / 20); // -20 dBFS

console.log("=== ITU-R BS.1770 基準信号での検証 (48kHz) ===");
for (const [label, ch] of [["ステレオ(L=R)", 2], ["モノラル", 1]] as const) {
  const m = new LoudnessMeter(SR, ch);
  const sig = Array.from({length: ch}, () => sine(1000, AMP, 10));
  m.push(sig, sig[0].length);
  const lufs = m.integratedLufs();
  const expect = ch === 2 ? -20.0 : -23.0;
  assert(`${label}`, Math.abs(lufs - expect) < 0.15, `${lufs.toFixed(2)} LUFS (期待 ${expect.toFixed(1)}, 差 ${(lufs-expect).toFixed(3)})`);
}

console.log("\n=== 他のサンプリング周波数でも一致するか ===");
for (const sr of [44100, 48000, 96000]) {
  const m = new LoudnessMeter(sr, 2);
  const a = new Float32Array(sr * 10), b = new Float32Array(sr * 10);
  for (let i = 0; i < a.length; i++) { a[i] = AMP * Math.sin(2*Math.PI*1000*i/sr); b[i] = a[i]; }
  m.push([a, b], a.length);
  const lufs = m.integratedLufs();
  assert(`${sr}Hz`, Math.abs(lufs+20)<0.15, `${lufs.toFixed(2)} LUFS`);
}

console.log("\n=== 目標値と必要ゲイン ===");
console.log(`モノラルの目標: ${targetLufs(1)} LUFS / ステレオ: ${targetLufs(2)} LUFS`);
const g = gainForTarget(-30, -19);
assert("-30 LUFS を -19 にするゲイン", Math.abs(20*Math.log10(g)-11)<0.01, `${(20*Math.log10(g)).toFixed(2)} dB (期待 11.00)`);

console.log("\n=== ゲート処理: 長い無音があっても会話部分で測れるか ===");
{
  // 5秒 通常音量 + 30秒 無音
  const voice = sine(1000, AMP, 5);
  const silence = new Float32Array(SR * 30);
  const joined = new Float32Array(voice.length + silence.length);
  joined.set(voice, 0);
  const m = new LoudnessMeter(SR, 2);
  m.push([joined, joined], joined.length);
  const lufs = m.integratedLufs();
  assert("無音を含めても会話部分で測れる", Math.abs(lufs+20)<0.5, `${lufs.toFixed(2)} LUFS`);
}

console.log("\n=== リミッター ===");
{
  // 通常音量の中に1箇所だけ大きなピークを置く
  const sig = sine(300, 0.3, 3);
  for (let i = SR; i < SR + 100; i++) sig[i] = 0.99;
  const lim = new Limiter(SR, 1, -1.2);
  const out: number[] = [];
  const emit = (c: Float32Array[], n: number) => { for (let i=0;i<n;i++) out.push(c[0][i]); };
  for (let i = 0; i < sig.length; i += 4800) {
    const n = Math.min(4800, sig.length - i);
    lim.process([sig.subarray(i, i+n)], n, emit);
  }
  lim.flush(emit);
  const arr = Float32Array.from(out);
  let peak = 0; for (const v of arr) peak = Math.max(peak, Math.abs(v));
  const ceilingLin = Math.pow(10, -1.2/20);
  assert("上限を守る", peak <= ceilingLin + 1e-6, `ピーク ${(20*Math.log10(peak)).toFixed(2)} dBFS (上限 -1.20)`);
  assert("長さが保たれる", arr.length === sig.length, `${arr.length} / ${sig.length}`);
  // ピーク以外の区間は音量が保たれているか(全体が潰れていない)
  let rmsLate = 0; const from = SR*2;
  for (let i = from; i < arr.length; i++) rmsLate += arr[i]*arr[i];
  rmsLate = Math.sqrt(rmsLate/(arr.length-from));
  const expected = 0.3/Math.SQRT2;
  assert("ピーク後も音量が戻る", Math.abs(20*Math.log10(rmsLate/expected)) < 0.3, `${(20*Math.log10(rmsLate/expected)).toFixed(2)} dB 差`);
}

console.log("\n=== 全体: 小さい録音が目標ラウドネスに乗るか ===");
{
  const quiet = sine(500, 0.02, 12); // かなり小さい録音
  const m1 = new LoudnessMeter(SR, 1);
  m1.push([quiet], quiet.length);
  const before = m1.integratedLufs();
  const gain = gainForTarget(before, targetLufs(1));
  const scaled = Float32Array.from(quiet, v => v * gain);
  const lim = new Limiter(SR, 1, -1.2);
  const out: number[] = [];
  const emit = (c: Float32Array[], n: number) => { for (let i=0;i<n;i++) out.push(c[0][i]); };
  for (let i = 0; i < scaled.length; i += 4800) {
    const n = Math.min(4800, scaled.length - i);
    lim.process([scaled.subarray(i, i+n)], n, emit);
  }
  lim.flush(emit);
  const arr = Float32Array.from(out);
  const m2 = new LoudnessMeter(SR, 1);
  m2.push([arr], arr.length);
  const after = m2.integratedLufs();
  assert("小さい録音が目標に乗る", Math.abs(after - targetLufs(1)) < 1.0,
    `${before.toFixed(1)} → ${after.toFixed(1)} LUFS (目標 ${targetLufs(1)}, ゲイン ${(20*Math.log10(gain)).toFixed(1)}dB)`);
}

console.log("\n=== 処理チェーン全体: 突発的な大音量があっても目標に収束するか ===");
{
  // 会話に近い信号(抑揚と間)+ 笑い声のような突発的な大音量
  const SR2 = 44100, frames = SR2 * 25;
  const src = new Float32Array(frames);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / SR2;
    let v = (Math.random() - 0.5) * 0.0015;
    if ((t % 3.2) < 2.3) {
      const f0 = 120 + 18*Math.sin(2*Math.PI*0.7*t) + 8*Math.sin(2*Math.PI*3.1*t);
      phase += 2*Math.PI*f0/SR2;
      const env = 0.06*(0.55+0.45*Math.sin(2*Math.PI*2.4*t));
      v += env*(Math.sin(phase)+0.5*Math.sin(2*phase)+0.28*Math.sin(3*phase)+0.14*Math.sin(5*phase));
    }
    if (t > 14.0 && t < 14.35) v *= 6;
    src[i] = v;
  }

  const target = targetLufs(1);
  const lufsOf = (a: Float32Array) => { const m = new LoudnessMeter(SR2, 1); m.push([a], a.length); return m.integratedLufs(); };
  const peakOf = (a: Float32Array) => { let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); return 20*Math.log10(p); };

  // 1回目: ノイズフロア
  const hp = new Float32Array(src);
  new HighPassFilter(SR2, 1).process([hp], hp.length);
  const an = new Analyzer(SR2); an.push([hp], hp.length);
  const { noiseFloor } = an.result();

  // 2回目: 整音後のラウドネス
  const shaped = new Float32Array(hp);
  new NoiseReducer(SR2, noiseFloor).process([shaped], shaped.length);
  const measured = lufsOf(shaped);

  const runLimiter = (input: Float32Array, gain: number) => {
    const g = Float32Array.from(input);
    applyGain([g], g.length, gain);
    const lim = new Limiter(SR2, 1);
    const out: number[] = [];
    const emit = (c: Float32Array[], n: number) => { for (let i = 0; i < n; i++) out.push(c[0][i]); };
    for (let i = 0; i < g.length; i += SR2 * 10) {
      const n = Math.min(SR2 * 10, g.length - i);
      lim.process([g.subarray(i, i + n)], n, emit);
    }
    lim.flush(emit);
    return Float32Array.from(out);
  };

  let gain = gainForTarget(measured, target);
  const peakAfter = peakOf(shaped) + 20*Math.log10(gain);
  assert("補正が必要と判定される", peakAfter > CEILING_DBFS, `ゲイン後のピーク ${peakAfter.toFixed(1)} dBFS`);

  const trial = lufsOf(runLimiter(shaped, gain));
  const uncorrectedError = Math.abs(trial - target);
  assert("補正なしでは目標を外す", uncorrectedError > 1, `${trial.toFixed(2)} LUFS (差 ${uncorrectedError.toFixed(2)}dB)`);

  // 補正パス相当
  gain *= Math.pow(10, Math.min(6, Math.max(0, target - trial)) / 20);
  const final = runLimiter(shaped, gain);
  const achieved = lufsOf(final);
  assert("補正すると目標±1dB に収まる", Math.abs(achieved - target) <= 1,
    `${measured.toFixed(1)} → ${achieved.toFixed(2)} LUFS (目標 ${target})`);
  assert("補正後もピーク上限を守る", peakOf(final) <= CEILING_DBFS + 0.01, `${peakOf(final).toFixed(2)} dBFS`);
}

console.log(failures === 0 ? "\n✅ ALL OK\n" : `\n❌ ${failures} 件失敗\n`);
process.exit(failures === 0 ? 0 : 1);
