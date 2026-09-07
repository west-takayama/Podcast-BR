// 整音の「継ぎ目」を測る。
//
// 音声は 10 秒ずつのブロックに切って流している。部品ごとの試験は通っていても、
// **ブロックの境目で状態が持ち越されていない**と、そこだけ音が飛ぶ。
// 1時間の回なら 360 か所。プチプチというノイズになるが、波形を見ないと分からない。
//
// 見るのは2つ。
//
//  1) 切り方を変えても結果が同じか
//     状態が正しく持ち越されているなら、10秒ずつ流しても素数長で流しても
//     出てくる波形は**同じでなければならない**。違えばどこかで状態が切れている。
//
//  2) 境目に不連続が無いか
//     滑らかな信号を通したとき、隣り合うサンプルの差は滑らかなはず。
//     境目だけ跳ねていれば、そこが継ぎ目。
import {
  GainCurve,
  HighPassFilter,
  NoiseReducer,
  SpeechLeveler,
  applyGain,
} from "../src/lib/audio/dsp";
import { Limiter } from "../src/lib/audio/limiter";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const SR = 48000;

/** 声に近い信号。倍音・抑揚・間があり、整音のどの部品も働く。 */
function speechLike(sec: number, seed = 1): Float32Array {
  const n = Math.round(SR * sec);
  const out = new Float32Array(n);
  const period = SR / 147;
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // 3秒ごとに 0.35 秒の間を置く
    const quiet = t % 3 > 2.65;
    let v = 0;
    if (!quiet) {
      for (let h = 1; h * 147 < 8000; h++) {
        v += Math.pow(h, -1.1) * Math.sin((2 * Math.PI * h * (i % period)) / period);
      }
      v *= 0.12 * (0.6 + 0.4 * Math.abs(Math.sin(t * 4)));
    }
    out[i] = v + rand() * 0.0008;
  }
  return out;
}

/** 与えたブロック長で、整音の並びをそのまま通す。 */
function runChain(
  src: Float32Array,
  blockLen: number,
  opts: { curve?: GainCurve | null; gain: number },
): Float32Array {
  const hp = new HighPassFilter(SR, 1);
  const nr = new NoiseReducer(SR, 1, 1);
  const limiter = new Limiter(SR, 1);
  opts.curve?.reset();

  const out: number[] = [];
  const scratch = new Float32Array(blockLen);
  for (let at = 0; at < src.length; at += blockLen) {
    const len = Math.min(blockLen, src.length - at);
    scratch.set(src.subarray(at, at + len));
    const ch = [scratch.subarray(0, len)];
    hp.process(ch, len);
    nr.process(ch, len);
    opts.curve?.process(ch, len);
    applyGain(ch, len, opts.gain);
    limiter.process(ch, len, (limited, n) => {
      for (let i = 0; i < n; i++) out.push(limited[0][i]);
    });
  }
  limiter.flush((limited, n) => {
    for (let i = 0; i < n; i++) out.push(limited[0][i]);
  });
  return Float32Array.from(out);
}

/** 一番大きい食い違いと、その位置。 */
function worstDiff(a: Float32Array, b: Float32Array): { db: number; at: number } {
  const n = Math.min(a.length, b.length);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  return { db: 20 * Math.log10(worst + 1e-20), at };
}

/** 隣り合うサンプルの差が、周りに比べて跳ねている場所。 */
function jumps(x: Float32Array, boundaries: number[], guard = 4): { at: number; ratio: number }[] {
  const d = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = Math.abs(x[i] - x[i - 1]);
  // 全体の代表値(中央値の代わりに、上位から外れ値を除いた平均)
  const sorted = Float32Array.from(d).sort();
  const typical = sorted[Math.floor(sorted.length * 0.99)] || 1e-9;
  const found: { at: number; ratio: number }[] = [];
  for (const b of boundaries) {
    let peak = 0;
    for (let i = Math.max(1, b - guard); i < Math.min(x.length, b + guard); i++) {
      peak = Math.max(peak, d[i]);
    }
    const ratio = peak / typical;
    if (ratio > 3) found.push({ at: b, ratio });
  }
  return found;
}

(async () => {
  console.log("=== ブロックの切り方を変えても同じ音になるか ===");
  {
    const src = speechLike(24);
    // 実際は 10 秒ずつ。素数長にすると境目が全部ずれるので、
    // 状態が切れていれば必ず食い違いが出る
    const a = runChain(src, SR * 10, { gain: 1.6 });
    const b = runChain(src, 4409, { gain: 1.6 });
    const c = runChain(src, 977, { gain: 1.6 });

    check("長さが揃う(10秒ずつ / 4409)", a.length === b.length, `${a.length} vs ${b.length}`);
    check("長さが揃う(10秒ずつ / 977)", a.length === c.length, `${a.length} vs ${c.length}`);

    const ab = worstDiff(a, b);
    const ac = worstDiff(a, c);
    // -100 dB は 16bit の量子化(-96dB)より下。聴こえない
    check("切り方を変えても同じ(4409)", ab.db < -100, `最大差 ${ab.db.toFixed(1)} dB @${ab.at}`);
    check("切り方を変えても同じ(977)", ac.db < -100, `最大差 ${ac.db.toFixed(1)} dB @${ac.at}`);
  }

  console.log("\n=== 声の大きさを揃える曲線をまたいでも同じか ===");
  {
    const src = speechLike(30, 7);
    // 曲線は 1 回目の通しで作る。ここも同じ流し方で作らないと意味がない
    const build = (blockLen: number) => {
      const leveler = new SpeechLeveler(SR);
      for (let at = 0; at < src.length; at += blockLen) {
        const len = Math.min(blockLen, src.length - at);
        leveler.push([src.subarray(at, at + len)], len);
      }
      return leveler.build(0.0008);
    };
    const curveA = build(SR * 10);
    const curveB = build(977);
    const spread = (c: GainCurve) => c.rangeDb.max - c.rangeDb.min;
    check("曲線の幅が揃う", Math.abs(spread(curveA) - spread(curveB)) < 0.2,
      `${spread(curveA).toFixed(2)} vs ${spread(curveB).toFixed(2)} dB`);

    const a = runChain(src, SR * 10, { curve: curveA, gain: 1.4 });
    const b = runChain(src, 977, { curve: curveA, gain: 1.4 });
    const d = worstDiff(a, b);
    check("曲線を当てても切り方に依らない", d.db < -100, `最大差 ${d.db.toFixed(1)} dB @${d.at}`);
  }

  console.log("\n=== 境目で音が飛んでいないか ===");
  {
    // 滑らかな信号。境目で状態が切れれば、そこだけ段差になる
    const sec = 24;
    const n = SR * sec;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      src[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 517 * i) / SR);
    }
    const blockLen = SR * 10;
    const out = runChain(src, blockLen, { gain: 1.2 });
    const boundaries: number[] = [];
    for (let b = blockLen; b < out.length; b += blockLen) boundaries.push(b);
    const found = jumps(out, boundaries);
    check("ブロックの境目に段差が無い", found.length === 0,
      found.length ? found.map((f) => `@${f.at} ${f.ratio.toFixed(1)}倍`).join(" / ") : `${boundaries.length}か所を確認`);

    // 出力そのものが素直か(全域で外れ値が無いこと)。
    // ただし頭の数ミリ秒は外す。この試験信号は無音から**いきなり**始まるので、
    // フィルタが立ち上がるまでの間だけは段差が出る。実際の録音でも同じことが
    // 起きるが、1.5ms なので聴こえない。ここで測りたいのは途中の継ぎ目のほう
    const skip = Math.round(SR * 0.01);
    let worstRatio = 0;
    let worstAt = -1;
    const d = new Float32Array(out.length);
    for (let i = 1; i < out.length; i++) d[i] = Math.abs(out[i] - out[i - 1]);
    const sorted = Float32Array.from(d.subarray(skip)).sort();
    const typical = sorted[Math.floor(sorted.length * 0.99)] || 1e-9;
    for (let i = skip; i < out.length; i++) {
      const r = d[i] / typical;
      if (r > worstRatio) {
        worstRatio = r;
        worstAt = i;
      }
    }
    check("最初の10ms より後には、どこにも段差が無い", worstRatio < 3,
      `いちばん急な変化 ${worstRatio.toFixed(2)}倍 @${(worstAt / SR).toFixed(2)}秒`);
  }

  console.log("\n=== 無音を流しても何も生えないか ===");
  {
    const silence = new Float32Array(SR * 12);
    const out = runChain(silence, SR * 10, { gain: 4 });
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    check("無音は無音のまま", peak < 1e-6, `最大 ${(20 * Math.log10(peak + 1e-20)).toFixed(1)} dBFS`);
  }

  console.log(failures === 0 ? "\n✅ ALL OK\n" : `\n❌ ${failures} 件失敗\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
