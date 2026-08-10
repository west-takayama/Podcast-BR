// 話者どうしの「音色」を合わせる。
//
// マイクも部屋も違えば、同じ声量でも聞こえ方が変わる。片方はこもって、
// 片方は細い。会話で切り替わるたびに耳が調整を強いられるので、
// 長く聴くと疲れる。**音量が揃っていても、音色が揃っていないと粗く聞こえる。**
//
// 1本に混ざった音では手が出せないが、人ごとに分かれていれば
// それぞれの周波数バランスを測って寄せられる。
//
// やることは「相手に似せる」だけで、良い音を作りにいくわけではない。
// 元より良くはならないが、**揃っていないことによる不快感は消せる**。

import { HighPassFilter, LowPassFilter, PeakingFilter } from "./dsp";
import { kWeightDb } from "./loudness";

/**
 * 測る帯域。1オクターブ刻み。
 *
 * これより細かくしても、話者間の差は概ねなだらかなので効果が薄く、
 * 逆に細かい谷を無理に埋めて不自然になる。
 * 100Hz より下はハイパスで既に落としてあり、8kHz より上は
 * 配信ビットレートではほとんど残らないので触らない。
 */
export const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

/** 補正の上限。これ以上動かすと元の声から離れる。 */
export const MAX_TONE_DB = 6;

/**
 * 持ち上げてよいと判断する下限。
 *
 * 「声が出ている間」と「静かな間」で、その帯域がどれだけ違うかを見る。
 * 差が小さい帯域は、声ではなく空調やパソコンの音しか入っていない。
 * そこを持ち上げてもノイズが大きくなるだけなので、触らない。
 *
 * 「全体のいちばん大きい帯域より何dB下か」で決める手もあるが、それだと
 * 低音の多い声ほど高域を諦めることになる。静かな間と比べるほうが、
 * 声が入っているかどうかを直接見ていることになる。
 */
const MIN_BAND_SNR_DB = 4;

/**
 * 実際に測る音声の長さ(秒)。これを超える回は間引いて測る。
 *
 * 音色はマイクと部屋と声で決まるもので、回の途中で変わるものではない。
 * 2分半ぶんも集めれば形は決まる。全部を通すと 10分の素材で 6.6秒、
 * 60分なら 40秒かかっていた(実測)。
 *
 * 先頭だけを見る手もあるが、相手が喋っている間ずっと黙っている
 * 収録もあるので、**頭からではなく全体から等間隔に**拾う。
 */
const ANALYZE_SEC = 150;

export interface ToneCurve {
  /** 帯域バランス(dB)。全帯域の平均を 0 とした**形**だけを持つ。 */
  db: number[];
  /** 各帯域で、声が出ている間が静かな間より何dB上か。 */
  snrDb: number[];
}

/**
 * 帯域ごとのエネルギーを測る。
 *
 * 帯域通過フィルタを並べて、それぞれの出力の二乗を溜める。FFT を持ち込まずに
 * 済み、他の処理と同じくブロック単位で流せる。
 *
 * 0.4秒ごとに記録しておき、あとから「声が出ていた側」と「静かだった側」に
 * 分ける。沈黙まで混ぜて平均すると、その人の環境音の色を測ることになる。
 */
export class SpectrumMeter {
  private readonly blocks: { level: number; bands: number[] }[] = [];
  private readonly bandpass: BandPass[];
  private blockEnergy: number[];
  private blockLevel = 0;
  private blockFrames = 0;
  private counted = 0;
  private blockIndex = 0;
  private readonly framesPerBlock: number;
  private readonly warmupFrames: number;
  /** 何ブロックに1回だけ測るか。長い回でも待ち時間を一定に保つ。 */
  private readonly stride: number;
  private scratch = new Float32Array(0);

  /**
   * @param durationSec 分かっていれば渡す。長い回では間引いて測る。
   */
  constructor(sampleRate: number, durationSec = 0) {
    this.bandpass = BANDS.map((hz) => new BandPass(sampleRate, hz));
    this.blockEnergy = BANDS.map(() => 0);
    this.framesPerBlock = Math.max(1, Math.round(sampleRate * 0.4));
    // フィルタが落ち着くまでの捨て幅。飛ばした直後は波形が繋がっていない
    this.warmupFrames = Math.round(sampleRate * 0.05);
    this.stride = durationSec > ANALYZE_SEC ? Math.ceil(durationSec / ANALYZE_SEC) : 1;
  }

  /**
   * stride 個ごとのまとまりの中で、何番目を測るか。
   *
   * 毎回同じ位置を取ると、会話の周期と間隔が噛み合ったときに
   * いつも同じ場面(喋り始めばかり、沈黙ばかり)を拾ってしまう。
   * 黄金比を使って位置をずらし、まんべんなく当たるようにする。
   */
  private pickInGroup(): number {
    if (this.stride <= 1) return 0;
    const group = Math.floor(this.blockIndex / this.stride);
    return Math.floor(((group * 0.6180339887) % 1) * this.stride);
  }

  push(channels: Float32Array[], length: number): void {
    if (this.scratch.length < length) this.scratch = new Float32Array(length);
    const mono = this.scratch;
    // 音色は左右の合計で見る。人ごとのファイルはたいていモノラル
    if (channels.length === 1) {
      mono.set(channels[0].subarray(0, length));
    } else {
      for (let i = 0; i < length; i++) mono[i] = (channels[0][i] + channels[1][i]) * 0.5;
    }

    let at = 0;
    while (at < length) {
      const take = Math.min(length - at, this.framesPerBlock - this.blockFrames);
      const active = this.blockIndex % this.stride === this.pickInGroup();

      if (active) {
        const slice = mono.subarray(at, at + take);
        // 飛ばした直後はフィルタが落ち着いていないので、頭は数えない
        const skip = Math.max(0, Math.min(take, this.warmupFrames - this.blockFrames));
        for (let i = skip; i < take; i++) this.blockLevel += slice[i] * slice[i];
        for (let b = 0; b < BANDS.length; b++) {
          this.blockEnergy[b] += this.bandpass[b].energyOf(slice, take, skip);
        }
        this.counted += take - skip;
      }

      this.blockFrames += take;
      at += take;
      if (this.blockFrames >= this.framesPerBlock) {
        if (active && this.counted > 0) {
          this.blocks.push({
            level: this.blockLevel / this.counted,
            bands: this.blockEnergy.map((v) => v / this.counted),
          });
        }
        this.blockLevel = 0;
        this.blockEnergy = BANDS.map(() => 0);
        this.blockFrames = 0;
        this.counted = 0;
        this.blockIndex++;
      }
    }
  }

  /** 声が出ている区間の帯域バランスと、帯域ごとの声の入り具合。 */
  curve(): ToneCurve | null {
    // 短すぎると「喋っている側」を選べない
    if (this.blocks.length < 6) return null;
    const sorted = [...this.blocks].sort((a, b) => b.level - a.level);
    const speaking = sorted.slice(0, Math.max(2, Math.round(sorted.length * 0.5)));
    const quiet = sorted.slice(sorted.length - Math.max(2, Math.round(sorted.length * 0.25)));

    const mean = (list: typeof sorted): number[] =>
      BANDS.map((_, b) => list.reduce((s, x) => s + x.bands[b], 0) / list.length);
    const loud = mean(speaking);
    const soft = mean(quiet);

    // サンプリングレートが低いと上の帯域が存在しない(16kHz 収録の 8kHz など)。
    // 測れない帯域を混ぜると平均が壊れるので、最初から外す
    const usable = this.bandpass.map((bp) => bp.usable);
    const raw = loud.map((v) => 10 * Math.log10(v + 1e-30));
    const shown = raw.filter((_, b) => usable[b]);
    if (shown.length === 0) return null;
    const center = shown.reduce((a, b) => a + b, 0) / shown.length;
    if (!Number.isFinite(center)) return null;

    return {
      // 平均を 0 にする。こうしておくと補正量の合計もほぼ 0 になり、
      // 音色を直しても全体の音量が動かない(音量合わせをやり直さずに済む)
      // 測れない帯域は 0(=平均どおり)とし、持ち上げの対象からも外す
      db: raw.map((v, b) => (usable[b] ? v - center : 0)),
      snrDb: loud.map((v, b) =>
        usable[b] ? 10 * Math.log10((v + 1e-30) / (soft[b] + 1e-30)) : 0,
      ),
    };
  }
}

/**
 * 1オクターブ幅の帯域通過。
 *
 * ハイパスとローパスを2段ずつ重ねて 24dB/oct にする。1段では隣の帯域が
 * 素通りしてしまい、**低音の大きい声だと高域の測定値が低音の漏れで埋まる**
 * (実測で、8kHz の測定値が実際の中身と無関係になっていた)。
 */
class BandPass {
  private readonly stages: { process(channels: Float32Array[], length: number): void }[];
  private readonly buf = new Float32Array(4096);
  /** この帯域がサンプリングレートに収まるか。 */
  readonly usable: boolean;

  constructor(sampleRate: number, hz: number) {
    // その帯域がサンプリングレートに収まらないなら測らない
    this.usable = hz * Math.SQRT2 < sampleRate * 0.45;
    const lo = hz / Math.SQRT2;
    const hi = hz * Math.SQRT2;
    this.stages = this.usable
      ? [
          new HighPassFilter(sampleRate, 1, lo),
          new HighPassFilter(sampleRate, 1, lo),
          new LowPassFilter(sampleRate, 1, hi),
          new LowPassFilter(sampleRate, 1, hi),
        ]
      : [];
  }

  /**
   * その帯域のエネルギー。
   * @param skip 頭の何サンプルをフィルタには通すが数えないか。
   */
  energyOf(src: Float32Array, length: number, skip = 0): number {
    if (!this.usable) return 0;
    let sum = 0;
    for (let at = 0; at < length; at += this.buf.length) {
      const n = Math.min(this.buf.length, length - at);
      const view = this.buf.subarray(0, n);
      view.set(src.subarray(at, at + n));
      for (const f of this.stages) f.process([view], n);
      for (let i = Math.max(0, skip - at); i < n; i++) sum += view[i] * view[i];
    }
    return sum;
  }
}

/**
 * 各トラックの音色を、全員の平均へ寄せる補正量(dB)を出す。
 *
 * 音量合わせと同じ考え方で、誰か一人に似せるのではなく真ん中へ集める。
 * 一人を基準にすると、その人のマイクの癖が番組全体の癖になる。
 */
export function matchToneDb(curves: (ToneCurve | null)[]): number[][] {
  const usable = curves.filter((c): c is ToneCurve => c !== null);
  if (usable.length < 2) return curves.map(() => BANDS.map(() => 0));

  const target = BANDS.map(
    (_, b) => usable.reduce((n, c) => n + c.db[b], 0) / usable.length,
  );

  return curves.map((curve) => {
    if (!curve) return BANDS.map(() => 0);
    return BANDS.map((_, b) => {
      const diff = target[b] - curve.db[b];
      // 減らすのはいつでも安全(ノイズも一緒に減る)。
      // 持ち上げるのは、その帯域にちゃんと声が入っているときだけ
      if (diff > 0 && curve.snrDb[b] < MIN_BAND_SNR_DB) return 0;
      return Math.max(-MAX_TONE_DB, Math.min(MAX_TONE_DB, diff));
    });
  });
}

/**
 * 音色の補正を掛けたら、そのトラックの音量がどれだけ動くか(dB)。
 *
 * 音量合わせは音色を直す**前**に決めている。低音を削って高音を足せば、
 * 形は揃っても全体は小さくなる。実測で 3.7dB 動いた。そのままだと
 * せっかく揃えた2人の音量が最大で7dB ずれる。
 *
 * 測り直すにはもう一度ファイル全体を読む必要があるので、代わりに
 * **測ってある帯域ごとの中身**から見積もる。どの帯域にどれだけ音が
 * 入っているかは分かっているので、そこへ補正を掛けた後の合計を出せばよい。
 * 人の耳の効き方(K特性)で重みを付けるので、ラウドネスの動きに対応する。
 */
export function toneLevelShiftDb(
  sampleRate: number,
  curve: ToneCurve,
  fixDb: number[],
): number {
  let before = 0;
  let after = 0;
  for (let b = 0; b < BANDS.length; b++) {
    // その帯域の中身を、耳の効き方で重み付けしたもの
    const energy = Math.pow(10, (curve.db[b] + kWeightDb(sampleRate, BANDS[b])) / 10);
    before += energy;
    after += energy * Math.pow(10, (fixDb[b] ?? 0) / 10);
  }
  if (before <= 0) return 0;
  return 10 * Math.log10(after / before);
}

/** ピーキングフィルタ1段の、ある周波数での増減(dB)。 */
function peakingMagDb(
  sampleRate: number,
  f0: number,
  gainDb: number,
  q: number,
  atHz: number,
): number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);
  const a0 = 1 + alpha / A;
  const b = [(1 + alpha * A) / a0, (-2 * cosW0) / a0, (1 - alpha * A) / a0];
  const a = [1, (-2 * cosW0) / a0, (1 - alpha / A) / a0];

  const w = (2 * Math.PI * atHz) / sampleRate;
  const mag = (c: number[]): number => {
    const re = c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
    const im = -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
    return Math.sqrt(re * re + im * im);
  };
  return 20 * Math.log10(mag(b) / mag(a) + 1e-30);
}

/** フィルタの Q。1オクターブ弱の幅になる値。 */
const TONE_Q = 1.4;

/**
 * 望んだ補正を実際に作るための、フィルタの設定値を解く。
 *
 * オクターブ間隔で並べたピーキングフィルタは裾が隣に届くので、
 * 「+3dB にしたい」と思ってそのまま +3dB を指定すると、隣からの
 * 足し込みで +4dB 以上になる。**指定した通りの形にならない。**
 *
 * そこで、作った形を測っては差を戻す、を繰り返して合わせ込む。
 * 中心の効きが隣より十分強いので、数回で収束する。
 */
export function solveFilterGains(sampleRate: number, desiredDb: number[]): number[] {
  const limit = MAX_TONE_DB * 1.6;
  const gains = BANDS.map((_, b) => desiredDb[b] ?? 0);

  for (let iter = 0; iter < 12; iter++) {
    let worst = 0;
    for (let b = 0; b < BANDS.length; b++) {
      const want = desiredDb[b] ?? 0;
      const err = want - toneResponseDb(sampleRate, gains, BANDS[b]);
      gains[b] = Math.max(-limit, Math.min(limit, gains[b] + err));
      worst = Math.max(worst, Math.abs(err));
    }
    if (worst < 0.05) break;
  }
  return gains;
}

/** フィルタ全体の、ある周波数での増減(dB)。 */
export function toneResponseDb(sampleRate: number, gainsDb: number[], atHz: number): number {
  return gainsDb.reduce(
    (sum, g, b) =>
      Math.abs(g) < 1e-6 ? sum : sum + peakingMagDb(sampleRate, BANDS[b], g, TONE_Q, atHz),
    0,
  );
}

/** 補正量からフィルタの列を作る。ほぼ 0 の帯域は作らない(無駄に通さない)。 */
export function toneFilters(
  sampleRate: number,
  numChannels: number,
  desiredDb: number[],
): PeakingFilter[] {
  if (!desiredDb.some((v) => Math.abs(v) >= 0.5)) return [];
  return solveFilterGains(sampleRate, desiredDb)
    .map((db, b) => ({ hz: BANDS[b], db }))
    .filter((x) => Math.abs(x.db) >= 0.2)
    .map((x) => new PeakingFilter(sampleRate, numChannels, x.hz, x.db, TONE_Q));
}
