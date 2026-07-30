// ルックアヘッド付きリミッター。
//
// 単純にピークで割る方式だと、1箇所の大きな音のために全体が小さくなり
// 目標ラウドネスに届かない。先読みして瞬間的に押さえることで、
// 平均音量を保ったまま上限を守れる。
//
// ブロック単位で呼べるよう状態を持つ。先読み分の遅延が出るため、
// 最後に flush() で残りを出し切る必要がある。

const LOOKAHEAD_MS = 5; // 立ち上がりを歪ませずに捉えられる長さ
const RELEASE_MS = 120; // 短すぎると音が揺れる(ポンピング)

/**
 * 上限。Apple Podcasts は -1 dBTP を求める。
 * サンプル値のピークをここまでに抑えれば、サンプル間のピーク(真のピーク)も
 * 実用上 -1 dBTP を超えない余裕がある。
 */
export const CEILING_DBFS = -1.2;

export class Limiter {
  private readonly lookahead: number;
  private readonly releaseCoef: number;
  private readonly ceiling: number;
  /** 先読み用の遅延バッファ(リングバッファ)。 */
  private readonly delay: Float32Array[];
  private writeIndex = 0;
  private filled = 0;
  private gain = 1;
  /** 先読み窓内の必要ゲインの最小値を持つ単調キュー。 */
  private queue: { gain: number; index: number }[] = [];
  private sampleIndex = 0;
  private reduced = 0; // 何サンプル抑制したか(効果の確認用)

  constructor(
    sampleRate: number,
    private readonly numChannels: number,
    ceilingDbfs = CEILING_DBFS,
  ) {
    this.lookahead = Math.max(1, Math.round((sampleRate * LOOKAHEAD_MS) / 1000));
    this.releaseCoef = Math.exp(-1 / ((RELEASE_MS / 1000) * sampleRate));
    this.ceiling = Math.pow(10, ceilingDbfs / 20);
    this.delay = Array.from({ length: numChannels }, () => new Float32Array(this.lookahead));
  }

  /** 先読み窓に入っているサンプル群から、いま必要な最小ゲインを取り出す。 */
  private pushTarget(peak: number): number {
    const target = peak > this.ceiling ? this.ceiling / peak : 1;
    // 単調増加キューにして、窓内の最小値を O(1) で取れるようにする
    while (this.queue.length > 0 && this.queue[this.queue.length - 1].gain >= target) {
      this.queue.pop();
    }
    this.queue.push({ gain: target, index: this.sampleIndex });
    const oldest = this.sampleIndex - this.lookahead;
    while (this.queue.length > 0 && this.queue[0].index <= oldest) this.queue.shift();
    return this.queue[0].gain;
  }

  /**
   * ブロックを処理する。出力は先読み分だけ遅れるため、
   * emit に渡される長さは入力と一致しないことがある。
   */
  process(
    channels: Float32Array[],
    length: number,
    emit: (out: Float32Array[], len: number) => void,
  ): void {
    const out = Array.from({ length: this.numChannels }, () => new Float32Array(length));
    let produced = 0;

    for (let i = 0; i < length; i++) {
      let peak = 0;
      for (let c = 0; c < this.numChannels; c++) {
        const a = Math.abs(channels[c][i]);
        if (a > peak) peak = a;
      }

      const required = this.pushTarget(peak);
      // 下げるときは即座に、戻すときは緩やかに。歪みと揺れの両方を避ける
      this.gain =
        required < this.gain
          ? required
          : required + this.releaseCoef * (this.gain - required);
      if (this.gain < 0.999) this.reduced++;

      // 遅延バッファが満たされてから出力を始める
      if (this.filled < this.lookahead) {
        for (let c = 0; c < this.numChannels; c++) this.delay[c][this.writeIndex] = channels[c][i];
        this.filled++;
      } else {
        for (let c = 0; c < this.numChannels; c++) {
          const delayed = this.delay[c][this.writeIndex];
          this.delay[c][this.writeIndex] = channels[c][i];
          // ゲインを掛けた後も、丸め誤差で上限を超えないよう最後に切る
          const v = delayed * this.gain;
          out[c][produced] = v > this.ceiling ? this.ceiling : v < -this.ceiling ? -this.ceiling : v;
        }
        produced++;
      }

      this.writeIndex = (this.writeIndex + 1) % this.lookahead;
      this.sampleIndex++;
    }

    if (produced > 0) emit(out, produced);
  }

  /** 遅延バッファに残った分を出し切る。 */
  flush(emit: (out: Float32Array[], len: number) => void): void {
    if (this.filled === 0) return;
    const remaining = Math.min(this.filled, this.lookahead);
    const out = Array.from({ length: this.numChannels }, () => new Float32Array(remaining));
    for (let i = 0; i < remaining; i++) {
      const idx = (this.writeIndex + i) % this.lookahead;
      const required = this.queue.length > 0 ? this.queue[0].gain : 1;
      this.gain =
        required < this.gain ? required : required + this.releaseCoef * (this.gain - required);
      for (let c = 0; c < this.numChannels; c++) {
        const v = this.delay[c][idx] * this.gain;
        out[c][i] = v > this.ceiling ? this.ceiling : v < -this.ceiling ? -this.ceiling : v;
      }
    }
    this.filled = 0;
    emit(out, remaining);
  }

  get reducedSamples(): number {
    return this.reduced;
  }
}
