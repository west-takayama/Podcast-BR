// ITU-R BS.1770-4 に沿ったラウドネス測定(LUFS)。
//
// 以前は単純な RMS を基準にしていたが、それは人の聴感とずれるため
// 配信プラットフォームの基準(Apple Podcasts: -16 LUFS ステレオ / -19 LUFS モノラル、
// ±1dB 許容)を満たせない。規格どおりの K特性フィルタとゲート処理を行う。
//
// 長尺でも破綻しないよう、100ms ごとの二乗平均だけを溜める構成にしている。

/** ステレオ/モノラルのチャンネル重み。サラウンドは扱わないため全て 1.0。 */
const CHANNEL_WEIGHT = 1.0;

/** 規格で定義されるオフセット。1kHz でのK特性の利得とちょうど打ち消し合う。 */
const OFFSET_DB = -0.691;

const BLOCK_MS = 400;
const HOP_MS = 100;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * K特性フィルタの前段(高域シェルビング)。
 *
 * 規格は 48kHz の係数しか示していないため、任意のサンプリング周波数で
 * 導出する必要がある。ここでは双一次変換に周波数プリワープを掛ける方式を使う
 * (libebur128 / ffmpeg と同じ)。一般的な RBJ Cookbook のシェルビング式では
 * 1kHz の利得が 0.44dB になり、規格の 0.70dB と 0.26dB ずれて測定値が狂う。
 * この式なら 48kHz で規格の係数と一致する(検証済み: scripts/lufs-check.ts)。
 */
function highShelf(sampleRate: number): BiquadCoeffs {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;

  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/**
 * K特性フィルタの後段(低域を落とすハイパス)。
 * 分子は規格どおり [1, -2, 1] を正規化せずに使う。
 */
function highPass(sampleRate: number): BiquadCoeffs {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const denom = 1 + k / q + k * k;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / denom,
    a2: (1 - k / q + k * k) / denom,
  };
}

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly c: BiquadCoeffs) {}

  step(x0: number): number {
    const y0 =
      this.c.b0 * x0 + this.c.b1 * this.x1 + this.c.b2 * this.x2 - this.c.a1 * this.y1 - this.c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x0;
    this.y2 = this.y1;
    this.y1 = y0;
    return y0;
  }
}

/**
 * K特性フィルタの、ある周波数での利得(dB)。
 *
 * 音を触ったときにラウドネスがどれだけ動くかを、実際に測り直さずに
 * 見積もるために使う。人の耳は低音を小さく感じるので、同じ dB でも
 * 低い帯域を触ったほうがラウドネスへの影響は小さい。
 */
export function kWeightDb(sampleRate: number, hz: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const mag = (c: BiquadCoeffs): number => {
    const bRe = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
    const bIm = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
    const aRe = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
    const aIm = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
    return Math.sqrt((bRe * bRe + bIm * bIm) / (aRe * aRe + aIm * aIm));
  };
  return 20 * Math.log10(mag(highShelf(sampleRate)) * mag(highPass(sampleRate)) + 1e-30);
}

/**
 * ゲート付き積分ラウドネス計。
 * ブロック(400ms)は 75% 重ねるため、100ms の小ブロックの二乗平均を溜めて
 * 連続する4つを足し合わせる形で組み立てる。
 */
export class LoudnessMeter {
  private readonly shelves: Biquad[];
  private readonly passes: Biquad[];
  private readonly hopLen: number;
  /** チャンネルごとの 100ms 二乗平均の履歴。 */
  private readonly subBlocks: number[][];
  private acc: number[];
  private accCount = 0;
  private truePeak = 0;

  constructor(sampleRate: number, private readonly numChannels: number) {
    const shelf = highShelf(sampleRate);
    const pass = highPass(sampleRate);
    this.shelves = Array.from({ length: numChannels }, () => new Biquad(shelf));
    this.passes = Array.from({ length: numChannels }, () => new Biquad(pass));
    this.hopLen = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
    this.subBlocks = Array.from({ length: numChannels }, () => []);
    this.acc = new Array(numChannels).fill(0);
  }

  push(channels: Float32Array[], length: number): void {
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < this.numChannels; c++) {
        const x = channels[c][i];
        const a = x < 0 ? -x : x;
        if (a > this.truePeak) this.truePeak = a;
        // K特性は2段のバイカッドを直列に通す
        const k = this.passes[c].step(this.shelves[c].step(x));
        this.acc[c] += k * k;
      }
      this.accCount++;
      if (this.accCount === this.hopLen) {
        for (let c = 0; c < this.numChannels; c++) {
          this.subBlocks[c].push(this.acc[c] / this.hopLen);
          this.acc[c] = 0;
        }
        this.accCount = 0;
      }
    }
  }

  /** サンプル値のピーク(dBFS)。真のピークではなくサンプルピーク。 */
  peakDbfs(): number {
    return this.truePeak > 0 ? 20 * Math.log10(this.truePeak) : -Infinity;
  }

  /**
   * 積分ラウドネス(LUFS)。無音しか無い場合は -Infinity を返す。
   *
   * 2段のゲートを掛ける。まず -70 LUFS 未満のブロックを捨て(絶対ゲート)、
   * 残りの平均から -10 LU の閾値を作って再度捨てる(相対ゲート)。
   * これにより長い沈黙があっても会話部分の音量が正しく評価される。
   */
  integratedLufs(): number {
    const blocksPerWindow = BLOCK_MS / HOP_MS; // 4
    const count = this.subBlocks[0]?.length ?? 0;
    if (count < blocksPerWindow) return -Infinity;

    // 各ブロックのチャンネル別二乗平均
    const blockZ: number[][] = [];
    for (let start = 0; start + blocksPerWindow <= count; start++) {
      const z: number[] = [];
      for (let c = 0; c < this.numChannels; c++) {
        let sum = 0;
        for (let k = 0; k < blocksPerWindow; k++) sum += this.subBlocks[c][start + k];
        z.push(sum / blocksPerWindow);
      }
      blockZ.push(z);
    }

    const loudnessOf = (z: number[]) => {
      const sum = z.reduce((n, v) => n + CHANNEL_WEIGHT * v, 0);
      return sum > 0 ? OFFSET_DB + 10 * Math.log10(sum) : -Infinity;
    };

    const aboveAbsolute = blockZ.filter((z) => loudnessOf(z) > ABSOLUTE_GATE_LUFS);
    if (aboveAbsolute.length === 0) return -Infinity;

    const meanZ = (blocks: number[][]) => {
      const mean = new Array(this.numChannels).fill(0);
      for (const z of blocks) for (let c = 0; c < this.numChannels; c++) mean[c] += z[c];
      return mean.map((v) => v / blocks.length);
    };

    const relativeThreshold = loudnessOf(meanZ(aboveAbsolute)) + RELATIVE_GATE_LU;
    const gated = aboveAbsolute.filter((z) => loudnessOf(z) > relativeThreshold);
    if (gated.length === 0) return -Infinity;

    return loudnessOf(meanZ(gated));
  }
}

/**
 * 配信時のチャンネル数に応じた目標ラウドネス。
 *
 * モノラルを -19 にするのは、モノラルが左右同一のステレオとして再生されると
 * 合算で +3dB になり、ステレオ -16 と同じ聴感になるため。
 */
export function targetLufs(channels: number): number {
  return channels === 1 ? -19 : -16;
}

export function gainForTarget(measuredLufs: number, target: number): number {
  if (!Number.isFinite(measuredLufs)) return 1;
  return Math.pow(10, (target - measuredLufs) / 20);
}
