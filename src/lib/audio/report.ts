import type { Finding } from "./diagnostics";

/**
 * 仕上がりの実測値。狙い通りかを利用者に示すために持つ。
 *
 * App ではなく lib に置いているのは、中断からの復帰で保存する必要があり、
 * 保存側(history.ts)が画面のコードを参照しないようにするため。
 */
export interface AudioReport {
  sourceLufs: number;
  outputLufs: number;
  targetLufs: number;
  peakDbfs: number;
  channels: number;
  bitrate: number;
  removedSec: number;
  limitedSamples: number;
  sampleRate: number;
  /** リミッターの効きを見て足し戻したゲイン(dB)。0 なら補正不要だった。 */
  correctionDb: number;
  /** 入力ファイルの形式(表示用)。 */
  inputFormat: string;
  /** 収録そのものの問題。 */
  findings: Finding[];
  /** 人ごとに分かれた音声を揃えた場合、その内訳。1本のときは無い。 */
  tracks?: { name: string; lufs: number; gainDb: number; durationSec: number }[];
}
