// ポッドキャスト向けの音声前処理。すべて端末内(Web Worker)で実行する。
//
// 処理順は「ハイパス → ノイズ低減 → ゲイン → 無音カット」。
//
// 長尺エピソードでも破綻しないよう、各処理はブロック単位で呼べる形にして
// 状態をインスタンスに持たせている(60分ステレオを一括展開すると 1GB を超える)。
// ゲイン量とノイズフロアだけは全体を見ないと決められないため、
// 音声を保持しない軽い解析パス(Analyzer)を先に1回通す設計にしている。

export interface DspOptions {
  highPass: boolean; // 低域のゴロつき(空調音・机の振動)を除去
  noiseReduction: boolean; // 定常ノイズ(ホワイトノイズ・ファンの音)を低減
  trimSilence: boolean; // 長い無音を詰める
  /**
   * ノイズ低減をチャンネルごとに独立して行うか。
   * 2人を別マイクで左右に分けて録った素材では、話していない人のマイクの
   * 環境音を個別に抑えられる。左右で同じ音を録っている素材に使うと
   * 定位が崩れるため、既定は無効。
   */
  perChannelNoise: boolean;
}

export const FRAME_MS = 20;
const TARGET_RMS_DB = -18;
const PEAK_LIMIT_DB = -1;

/** RBJ Cookbook のバイカッド・ハイパス。ブロックをまたいで状態を保つ。 */
export class HighPassFilter {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly state: { x1: number; x2: number; y1: number; y2: number }[];

  constructor(sampleRate: number, numChannels: number, cutoffHz = 80, q = 0.707) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cosW0) / 2) / a0;
    this.b1 = (-(1 + cosW0)) / a0;
    this.b2 = ((1 + cosW0) / 2) / a0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.state = Array.from({ length: numChannels }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  }

  process(channels: Float32Array[], length: number): void {
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      const s = this.state[c];
      let { x1, x2, y1, y2 } = s;
      for (let i = 0; i < length; i++) {
        const x0 = ch[i];
        const y0 = this.b0 * x0 + this.b1 * x1 + this.b2 * x2 - this.a1 * y1 - this.a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        ch[i] = y0;
      }
      s.x1 = x1;
      s.x2 = x2;
      s.y1 = y1;
      s.y2 = y2;
    }
  }
}

/**
 * RBJ のバイカッド・ローパス。間引き前の折り返し防止に使う。
 * ハイパスと同じ形なので係数だけ差し替えている。
 */
export class LowPassFilter {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly state: { x1: number; x2: number; y1: number; y2: number }[];

  constructor(sampleRate: number, numChannels: number, cutoffHz: number, q = 0.707) {
    const w0 = (2 * Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosW0) / 2) / a0;
    this.b1 = (1 - cosW0) / a0;
    this.b2 = ((1 - cosW0) / 2) / a0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.state = Array.from({ length: numChannels }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  }

  process(channels: Float32Array[], length: number): void {
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      const s = this.state[c];
      let { x1, x2, y1, y2 } = s;
      for (let i = 0; i < length; i++) {
        const x0 = ch[i];
        const y0 = this.b0 * x0 + this.b1 * x1 + this.b2 * x2 - this.a1 * y1 - this.a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        ch[i] = y0;
      }
      s.x1 = x1;
      s.x2 = x2;
      s.y1 = y1;
      s.y2 = y2;
    }
  }
}

/**
 * 下向きエクスパンダによるノイズ低減。
 * ノイズフロア付近の小さい音を滑らかに押し下げるため、ハードゲートのような
 * 不自然な途切れ(ポンピング)が起きにくい。声の区間はほぼ無加工で通る。
 */
export class NoiseReducer {
  private readonly thresholds: number[];
  private readonly attack: number;
  private readonly release: number;
  /** 連動モードでは要素1つ、独立モードではチャンネルごとに持つ。 */
  private readonly env: number[];
  private readonly gain: number[];

  private static readonly RATIO = 2.5;
  private static readonly MAX_ATTENUATION = Math.pow(10, -18 / 20); // 下げ幅は最大 -18dB

  /**
   * @param noiseFloor 連動モードでは単一値、独立モードではチャンネルごとの配列。
   * @param perChannel チャンネルごとに独立して処理するか。
   */
  constructor(
    sampleRate: number,
    noiseFloor: number | number[],
    private readonly perChannel = false,
  ) {
    // ノイズフロアの約 +9.5dB を「声あり」の境目とする
    const floors = Array.isArray(noiseFloor) ? noiseFloor : [noiseFloor];
    this.thresholds = floors.map((f) => f * 3);
    this.attack = Math.exp(-1 / (0.005 * sampleRate)); // 5ms: 声の立ち上がりを削らない速さ
    this.release = Math.exp(-1 / (0.15 * sampleRate)); // 150ms: 語尾を不自然に切らない遅さ
    const slots = perChannel ? Math.max(1, floors.length) : 1;
    this.env = new Array(slots).fill(0);
    this.gain = new Array(slots).fill(1);
  }

  /** 1系統ぶんのゲインを1サンプル進める。 */
  private step(slot: number, peak: number, threshold: number): number {
    this.env[slot] =
      peak > this.env[slot]
        ? peak + this.attack * (this.env[slot] - peak)
        : peak + this.release * (this.env[slot] - peak);

    let target = 1;
    if (this.env[slot] < threshold) {
      const below = Math.max(this.env[slot], 1e-8) / threshold;
      target = Math.max(NoiseReducer.MAX_ATTENUATION, Math.pow(below, NoiseReducer.RATIO - 1));
    }
    // ゲイン自体も平滑化して、急激な音量変化を避ける
    this.gain[slot] =
      target < this.gain[slot]
        ? target + this.attack * (this.gain[slot] - target)
        : target + this.release * (this.gain[slot] - target);
    return this.gain[slot];
  }

  process(channels: Float32Array[], length: number): void {
    const numChannels = channels.length;

    if (this.perChannel && numChannels > 1) {
      for (let c = 0; c < numChannels; c++) {
        const threshold = this.thresholds[Math.min(c, this.thresholds.length - 1)];
        if (threshold <= 0) continue;
        const ch = channels[c];
        for (let i = 0; i < length; i++) {
          ch[i] *= this.step(c, Math.abs(ch[i]), threshold);
        }
      }
      return;
    }

    // 連動モード。左右で同じ音を録っている素材で定位を崩さないよう、
    // チャンネル間で最大のピークを見て同じゲインを掛ける
    const threshold = this.thresholds[0];
    if (threshold <= 0) return;
    for (let i = 0; i < length; i++) {
      let peak = 0;
      for (let c = 0; c < numChannels; c++) {
        const a = Math.abs(channels[c][i]);
        if (a > peak) peak = a;
      }
      const gain = this.step(0, peak, threshold);
      for (let c = 0; c < numChannels; c++) channels[c][i] *= gain;
    }
  }
}

/**
 * 全体を見ないと決まらない値(ノイズフロアと正規化ゲイン)を求めるための解析器。
 * 音声そのものは保持せず、20ms フレームごとの RMS だけを溜める。
 */
export class Analyzer {
  private readonly frameLen: number;
  private readonly rms: number[] = [];
  /** チャンネルごとのフレームRMS。2人別マイクの独立処理に使う。 */
  private readonly perChannelRms: number[][] = [];
  private acc = 0;
  private perChannelAcc: number[] = [];
  private accCount = 0;
  private peak = 0;

  constructor(sampleRate: number) {
    this.frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  }

  push(channels: Float32Array[], length: number): void {
    const numChannels = channels.length;
    if (this.perChannelAcc.length !== numChannels) {
      this.perChannelAcc = new Array(numChannels).fill(0);
      while (this.perChannelRms.length < numChannels) this.perChannelRms.push([]);
    }
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        const v = channels[c][i];
        const sq = v * v;
        this.acc += sq;
        this.perChannelAcc[c] += sq;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
      }
      this.accCount += numChannels;
      if (this.accCount >= this.frameLen * numChannels) {
        this.rms.push(Math.sqrt(this.acc / this.accCount));
        for (let c = 0; c < numChannels; c++) {
          this.perChannelRms[c].push(Math.sqrt(this.perChannelAcc[c] / this.frameLen));
          this.perChannelAcc[c] = 0;
        }
        this.acc = 0;
        this.accCount = 0;
      }
    }
  }

  /** チャンネルごとのノイズフロア。独立ノイズ低減に渡す。 */
  channelNoiseFloors(): number[] {
    return this.perChannelRms.map((list) => percentileFloor(list));
  }

  private flush(): void {
    if (this.accCount > 0) {
      this.rms.push(Math.sqrt(this.acc / this.accCount));
      this.acc = 0;
      this.accCount = 0;
    }
  }

  /**
   * ノイズフロアはフレーム RMS の下位10パーセンタイル。平均や最小値ではなく
   * 下位パーセンタイルなのは、完全な無音や単発のクリックに引きずられずに
   * 「常時鳴っている環境音」を捉えるため。
   */
  result(): { noiseFloor: number; gain: number; peak: number; voiceRms: number } {
    this.flush();
    if (this.rms.length === 0 || this.peak === 0)
      return { noiseFloor: 0, gain: 1, peak: 0, voiceRms: 0 };

    const noiseFloor = percentileFloor(this.rms);

    // 正規化の基準は「声が鳴っている区間」の RMS にする。無音を含めて平均すると
    // 沈黙の多い回だけ不必要に大きくなり、回ごとの音量が揃わないため。
    const voiceThreshold = Math.max(noiseFloor * 2, 1e-4);
    let sum = 0;
    let n = 0;
    for (const r of this.rms) {
      if (r > voiceThreshold) {
        sum += r * r;
        n++;
      }
    }
    const referenceRms = n > 0 ? Math.sqrt(sum / n) : Math.sqrt(this.rms.reduce((a, r) => a + r * r, 0) / this.rms.length);
    if (referenceRms <= 0) return { noiseFloor, gain: 1, peak: this.peak, voiceRms: 0 };

    let gainDb = TARGET_RMS_DB - 20 * Math.log10(referenceRms);
    const peakDb = 20 * Math.log10(this.peak);
    if (peakDb + gainDb > PEAK_LIMIT_DB) gainDb = PEAK_LIMIT_DB - peakDb;

    return { noiseFloor, gain: Math.pow(10, gainDb / 20), peak: this.peak, voiceRms: referenceRms };
  }
}

/**
 * フレームRMSの下位10パーセンタイルをノイズフロアとする。
 * 完全な無音(デジタルゼロ)は環境音の指標にならないので除く。
 */
function percentileFloor(list: number[]): number {
  if (list.length === 0) return 0;
  const sorted = Float32Array.from(list).sort();
  let firstNonZero = 0;
  while (firstNonZero < sorted.length && sorted[firstNonZero] <= 1e-6) firstNonZero++;
  if (firstNonZero >= sorted.length) return 0;
  const idx = firstNonZero + Math.floor((sorted.length - firstNonZero) * 0.1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * 長い無音を詰める。無音を完全に削除すると会話が不自然に繋がるため、
 * 上限(既定1.0秒)までは残して「間」を保つ。
 *
 * 無音区間はいったん保留バッファに溜め、そのあと声が来たときだけ吐き出す。
 * こうすると冒頭・末尾の無音も同じ仕組みで自然に切り落とせる。
 */
export class SilenceTrimmer {
  private readonly frameLen: number;
  private readonly maxSilenceFrames: number;
  private readonly threshold: number;
  /** 保留中の無音フレーム。1要素が1フレーム分の全チャンネル。 */
  private pending: Float32Array[][] = [];
  private started = false;
  private removedFrames = 0;
  private carry: Float32Array[] | null = null;
  private carryLen = 0;

  constructor(
    sampleRate: number,
    private readonly numChannels: number,
    noiseFloor: number,
    maxSilenceSec = 1.0,
  ) {
    this.frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this.maxSilenceFrames = Math.max(1, Math.round((maxSilenceSec * 1000) / FRAME_MS));
    this.threshold = Math.max(noiseFloor * 2, 1e-4);
  }

  /**
   * ブロックを受け取り、残すべきサンプルだけを emit へ渡す。
   * フレーム境界に満たない端数は次のブロックへ持ち越す。
   */
  process(
    channels: Float32Array[],
    length: number,
    emit: (out: Float32Array[], len: number) => void,
  ): void {
    let input = channels;
    let inputLen = length;

    if (this.carry && this.carryLen > 0) {
      const merged = Array.from(
        { length: this.numChannels },
        () => new Float32Array(this.carryLen + length),
      );
      for (let c = 0; c < this.numChannels; c++) {
        merged[c].set(this.carry[c].subarray(0, this.carryLen), 0);
        merged[c].set(channels[c].subarray(0, length), this.carryLen);
      }
      input = merged;
      inputLen = this.carryLen + length;
      this.carryLen = 0;
    }

    const fullFrames = Math.floor(inputLen / this.frameLen);
    for (let f = 0; f < fullFrames; f++) {
      const start = f * this.frameLen;
      let sum = 0;
      for (let c = 0; c < this.numChannels; c++) {
        for (let i = start; i < start + this.frameLen; i++) {
          const v = input[c][i];
          sum += v * v;
        }
      }
      const rms = Math.sqrt(sum / (this.frameLen * this.numChannels));

      const frame = Array.from({ length: this.numChannels }, (_, c) =>
        input[c].slice(start, start + this.frameLen),
      );

      if (rms > this.threshold) {
        // 声が来た。保留していた無音(上限以内に制限済み)を「間」として復元する。
        for (const held of this.pending) emit(held, this.frameLen);
        this.pending = [];
        this.started = true;
        emit(frame, this.frameLen);
      } else if (this.started) {
        // 話し終わりの余韻は先頭側を残す。上限を超えた分はその場で捨てるので、
        // 何分続く無音でも保留バッファは maxSilenceFrames を超えない。
        if (this.pending.length < this.maxSilenceFrames) this.pending.push(frame);
        else this.removedFrames += this.frameLen;
      } else {
        // 冒頭の無音は声の直前だけ残したいので、古い方から捨てていく
        this.pending.push(frame);
        if (this.pending.length > this.maxSilenceFrames) {
          this.pending.shift();
          this.removedFrames += this.frameLen;
        }
      }
    }

    const rest = inputLen - fullFrames * this.frameLen;
    if (rest > 0) {
      if (!this.carry) {
        this.carry = Array.from(
          { length: this.numChannels },
          () => new Float32Array(this.frameLen * 2),
        );
      }
      for (let c = 0; c < this.numChannels; c++) {
        this.carry[c].set(input[c].subarray(fullFrames * this.frameLen, inputLen), 0);
      }
      this.carryLen = rest;
    }
  }

  /** 末尾に残った保留分。無音のまま終わっている場合は捨てる。 */
  finish(emit: (out: Float32Array[], len: number) => void): number {
    if (this.carryLen > 0 && this.carry) {
      emit(
        Array.from({ length: this.numChannels }, (_, c) => this.carry![c].slice(0, this.carryLen)),
        this.carryLen,
      );
      this.carryLen = 0;
    }
    this.removedFrames += this.pending.length * this.frameLen;
    this.pending = [];
    return this.removedFrames;
  }
}

/**
 * 話の切り替わり候補を拾う。
 *
 * AI が音声から推定するチャプター時刻はずれやすい。端末側で「一定以上の沈黙が
 * 終わって声が戻った位置」を測っておき、その一覧を候補として渡したうえで、
 * 返ってきた時刻を近い候補へ吸着させる。数え上げは出力の時間軸で行うため、
 * 無音カットを有効にしていても実際の再生位置と一致する。
 */
export class PauseDetector {
  private readonly frameLen: number;
  private readonly threshold: number;
  private readonly minSilenceFrames: number;
  private readonly boundaries: number[] = [];
  private silentRun = 0;
  private framesSeen = 0;
  private carry = 0;
  private carrySum = 0;
  private started = false;

  constructor(
    private readonly sampleRate: number,
    noiseFloor: number,
    minSilenceSec = 0.6,
  ) {
    this.frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this.threshold = Math.max(noiseFloor * 2, 1e-4);
    this.minSilenceFrames = Math.max(1, Math.round((minSilenceSec * 1000) / FRAME_MS));
  }

  push(channels: Float32Array[], length: number): void {
    const numChannels = channels.length;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        const v = channels[c][i];
        this.carrySum += v * v;
      }
      this.carry++;
      if (this.carry < this.frameLen) continue;

      const rms = Math.sqrt(this.carrySum / (this.carry * numChannels));
      this.carry = 0;
      this.carrySum = 0;
      this.framesSeen++;

      if (rms > this.threshold) {
        // 十分な沈黙のあとに声が戻った位置を話の切り替わり候補とする
        if (this.started && this.silentRun >= this.minSilenceFrames) {
          this.boundaries.push(((this.framesSeen - 1) * this.frameLen) / this.sampleRate);
        }
        this.silentRun = 0;
        this.started = true;
      } else {
        this.silentRun++;
      }
    }
  }

  /** 候補の一覧(秒)。多すぎると扱えないので間隔の広いものを優先して間引く。 */
  result(maxCount = 60): number[] {
    if (this.boundaries.length <= maxCount) return this.boundaries;
    const step = this.boundaries.length / maxCount;
    return Array.from({ length: maxCount }, (_, i) => this.boundaries[Math.floor(i * step)]);
  }
}

export function applyGain(channels: Float32Array[], length: number, gain: number): void {
  if (gain === 1) return;
  for (const ch of channels) {
    for (let i = 0; i < length; i++) ch[i] *= gain;
  }
}
