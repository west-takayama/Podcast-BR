// 収録そのものの問題を検出して伝える。
//
// これまでは音が歪んでいても、片方のマイクが録れていなくても、黙って処理していた。
// 収録側の問題は次回の設定で直せるものが多いので、事実として示す価値がある。
//
// 特に重要なのは左右の位相が逆になっている場合。モノラルに落とすと打ち消し合って
// 音がほとんど消えるため、気づかずに公開すると無音のエピソードになる。
//
// 判定は生の入力(ハイパスもノイズ低減も通す前)に対して行う。
// クリッピングや直流オフセットは処理を通すと見えなくなるため。

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  /** 次回の収録で直すための具体的な助言。 */
  advice?: string;
}

/** 全サンプルに対するクリップの割合がこれを超えたら警告する。 */
const CLIP_RATIO_WARN = 0.0001; // 0.01%
const CLIP_RATIO_CRITICAL = 0.005; // 0.5%
/** これ以上の直流オフセットは機材側の問題を示す。 */
const DC_OFFSET_WARN = 0.01;
/** 左右の相関がこれより低ければ位相が逆の疑い。 */
const PHASE_INVERTED = -0.5;
/** 片チャンネルがもう一方よりこれ以上小さければ、録れていない疑い。 */
const DEAD_CHANNEL_DB = 30;
/** 声とノイズの差がこれを下回ると環境音が目立つ。 */
const LOW_SNR_DB = 18;

export class Diagnostics {
  private samples = 0;
  private clipped = 0;
  private readonly sum: number[] = [];
  private readonly sumSquares: number[] = [];
  private readonly peaks: number[] = [];
  private crossSum = 0;
  private numChannels = 0;

  push(channels: Float32Array[], length: number): void {
    const n = channels.length;
    if (this.numChannels !== n) {
      this.numChannels = n;
      while (this.sum.length < n) {
        this.sum.push(0);
        this.sumSquares.push(0);
        this.peaks.push(0);
      }
    }

    for (let i = 0; i < length; i++) {
      let clippedHere = false;
      for (let c = 0; c < n; c++) {
        const v = channels[c][i];
        this.sum[c] += v;
        this.sumSquares[c] += v * v;
        const a = v < 0 ? -v : v;
        if (a > this.peaks[c]) this.peaks[c] = a;
        // 16bit の最大値付近に張り付いているサンプルを歪みとみなす
        if (a >= 0.999) clippedHere = true;
      }
      if (clippedHere) this.clipped++;
      if (n === 2) this.crossSum += channels[0][i] * channels[1][i];
    }
    this.samples += length;
  }

  /**
   * 判定結果。voiceLufs と noiseFloor は別の解析で得た値を渡す
   * (ここで再計算すると同じ処理を二重に持つことになるため)。
   */
  result(
    sampleRate: number,
    sourceLufs: number,
    noiseFloor: number,
    voiceRms: number,
  ): Finding[] {
    const findings: Finding[] = [];
    if (this.samples === 0) return findings;

    const rms = this.sumSquares.map((s) => Math.sqrt(s / this.samples));
    const dc = this.sum.map((s) => s / this.samples);
    const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));

    // --- 位相の反転。モノラル化で音が消えるため最優先 ---
    if (this.numChannels === 2) {
      const corr =
        this.crossSum / Math.max(1e-12, Math.sqrt(this.sumSquares[0] * this.sumSquares[1]));
      if (corr < PHASE_INVERTED) {
        findings.push({
          severity: "critical",
          title: "左右の位相が逆になっています",
          detail: `左右の相関が ${corr.toFixed(2)} です。このままモノラルに変換すると打ち消し合って音がほとんど消えます。`,
          advice:
            "設定で「モノラルで書き出す」を外してステレオのまま出すか、収録側でマイクの極性(位相スイッチやケーブル)を確認してください。",
        });
      }
    }

    // --- 片チャンネルが録れていない ---
    if (this.numChannels === 2) {
      const diff = db(rms[0]) - db(rms[1]);
      if (Math.abs(diff) > DEAD_CHANNEL_DB) {
        const dead = diff > 0 ? "右" : "左";
        findings.push({
          severity: "warning",
          title: `${dead}チャンネルがほぼ無音です`,
          detail: `左 ${db(rms[0]).toFixed(1)}dB / 右 ${db(rms[1]).toFixed(1)}dB。片方のマイクが録れていないか、モノラル音源が片側だけに入っています。`,
          advice:
            "モノラルで書き出す設定なら問題なく聞こえますが、ステレオで出す場合は片側が無音になります。",
        });
      }
    }

    // --- クリッピング(録音レベルが大きすぎて歪んでいる) ---
    const clipRatio = this.clipped / this.samples;
    if (clipRatio > CLIP_RATIO_WARN) {
      const seconds = this.clipped / sampleRate;
      findings.push({
        severity: clipRatio > CLIP_RATIO_CRITICAL ? "critical" : "warning",
        title: "録音が歪んでいます(クリッピング)",
        detail: `${seconds.toFixed(1)}秒ぶん(全体の${(clipRatio * 100).toFixed(2)}%)が最大値に張り付いています。この歪みは後から取り除けません。`,
        advice:
          "次回の収録では入力レベルを下げてください。ピークが -6dB 程度に収まるのが安全です。",
      });
    }

    // --- 直流オフセット ---
    const maxDc = Math.max(...dc.map(Math.abs));
    if (maxDc > DC_OFFSET_WARN) {
      findings.push({
        severity: "info",
        title: "直流オフセットがあります",
        detail: `波形の中心が ${maxDc.toFixed(3)} ずれています。音量の余裕が減りますが、低域カットで補正されます。`,
        advice: "機材やケーブルの相性による場合があります。低域カットを有効にしておけば実害はありません。",
      });
    }

    // --- 録音レベルが低い ---
    if (Number.isFinite(sourceLufs) && sourceLufs < -40) {
      findings.push({
        severity: "warning",
        title: "録音レベルが低いです",
        detail: `元の音源が ${sourceLufs.toFixed(1)} LUFS です。目標まで大きく持ち上げるため、環境音も一緒に目立ちやすくなります。`,
        advice: "次回はマイクに近づくか、収録アプリの入力レベルを上げてください。",
      });
    }

    // --- 環境音が大きい(声とノイズの差が小さい) ---
    if (noiseFloor > 0 && voiceRms > 0) {
      const snr = db(voiceRms) - db(noiseFloor);
      if (snr < LOW_SNR_DB) {
        findings.push({
          severity: "warning",
          title: "環境音が大きめです",
          detail: `声と環境音の差が ${snr.toFixed(1)}dB です。ノイズ低減で抑えていますが、静かな場所ほど仕上がりが良くなります。`,
          advice: "空調やパソコンのファンを止める、マイクに近づく、布の多い部屋で録るなどが効きます。",
        });
      }
    }

    return findings;
  }
}
