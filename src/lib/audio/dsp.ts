// ポッドキャスト向けの音声前処理。すべて端末内(Web Worker)で実行する。
//
// 処理順は「ハイパス → ノイズ低減 → 無音カット → 正規化」。
// 正規化を最後に置くのは、無音やノイズを除いた後の実際の音声区間を基準に
// 音量を決めたいため(先に正規化すると無音の分だけ音量が過小評価される)。

export interface DspOptions {
  highPass: boolean; // 低域のゴロつき(空調音・机の振動)を除去
  noiseReduction: boolean; // 定常ノイズ(ホワイトノイズ・ファンの音)を低減
  trimSilence: boolean; // 長い無音を詰める
}

const FRAME_MS = 20;

/** RBJ Cookbook のバイカッド・ハイパスフィルタ。80Hz 以下を落とす。 */
export function highPassInPlace(
  channels: Float32Array[],
  sampleRate: number,
  cutoffHz = 80,
  q = 0.707,
): void {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  const a0 = 1 + alpha;
  const b0 = ((1 + cosW0) / 2) / a0;
  const b1 = (-(1 + cosW0)) / a0;
  const b2 = ((1 + cosW0) / 2) / a0;
  const a1 = (-2 * cosW0) / a0;
  const a2 = (1 - alpha) / a0;

  for (const ch of channels) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < ch.length; i++) {
      const x0 = ch[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      ch[i] = y0;
    }
  }
}

/** 20ms フレームごとの RMS。無音判定とノイズフロア推定の共通の土台。 */
function frameRms(channels: Float32Array[], sampleRate: number): Float32Array {
  const frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frameCount = Math.ceil(channels[0].length / frameLen);
  const out = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * frameLen;
    const end = Math.min(start + frameLen, channels[0].length);
    let sum = 0;
    let n = 0;
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        sum += ch[i] * ch[i];
        n++;
      }
    }
    out[f] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  return out;
}

/**
 * ノイズフロアを推定する。フレーム RMS の下位10パーセンタイルを採用する。
 * 平均や最小値ではなく下位パーセンタイルなのは、完全な無音区間や
 * 単発のクリックに引きずられずに「常時鳴っている環境音」を捉えるため。
 */
export function estimateNoiseFloor(channels: Float32Array[], sampleRate: number): number {
  const rms = frameRms(channels, sampleRate);
  if (rms.length === 0) return 0;
  const sorted = Float32Array.from(rms).sort();
  // 完全無音(デジタルゼロ)のフレームは環境音の指標にならないので除く
  let firstNonZero = 0;
  while (firstNonZero < sorted.length && sorted[firstNonZero] <= 1e-6) firstNonZero++;
  if (firstNonZero >= sorted.length) return 0;
  const idx = firstNonZero + Math.floor((sorted.length - firstNonZero) * 0.1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * 下向きエクスパンダによるノイズ低減。
 * ノイズフロア付近の小さい音を滑らかに押し下げるため、ハードゲートのような
 * 不自然な途切れ(ポンピング)が起きにくい。声の区間はほぼ無加工で通る。
 */
export function noiseReduceInPlace(
  channels: Float32Array[],
  sampleRate: number,
  noiseFloor: number,
): void {
  if (noiseFloor <= 0) return;

  const threshold = noiseFloor * 3; // ノイズフロアの約 +9.5dB を「声あり」の境目とする
  const ratio = 2.5; // エクスパンダ比。大きいほど強く沈める
  const maxAttenuation = Math.pow(10, -18 / 20); // 下げ幅は最大 -18dB に制限
  const attack = Math.exp(-1 / (0.005 * sampleRate)); // 5ms: 声の立ち上がりを削らない速さ
  const release = Math.exp(-1 / (0.15 * sampleRate)); // 150ms: 語尾を不自然に切らない遅さ

  const len = channels[0].length;
  let env = 0;
  let gain = 1;

  for (let i = 0; i < len; i++) {
    let peak = 0;
    for (const ch of channels) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
    // エンベロープフォロワ: 立ち上がりは速く、減衰は緩やかに追従させる
    env = peak > env ? peak + attack * (env - peak) : peak + release * (env - peak);

    let target = 1;
    if (env < threshold) {
      const below = Math.max(env, 1e-8) / threshold;
      target = Math.max(maxAttenuation, Math.pow(below, ratio - 1));
    }
    // ゲイン自体も平滑化して、急激な音量変化を避ける
    gain = target < gain ? target + attack * (gain - target) : target + release * (gain - target);

    for (const ch of channels) ch[i] *= gain;
  }
}

export interface TrimResult {
  channels: Float32Array[];
  removedSec: number;
}

/**
 * 長い無音を詰める。無音を完全に削除すると会話が不自然に繋がるため、
 * 上限(既定1.0秒)までは残して「間」を保つ。前後の無音は0.3秒まで詰める。
 */
export function trimSilence(
  channels: Float32Array[],
  sampleRate: number,
  noiseFloor: number,
  maxSilenceSec = 1.0,
): TrimResult {
  const rms = frameRms(channels, sampleRate);
  if (rms.length === 0) return { channels, removedSec: 0 };

  const frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const silenceThreshold = Math.max(noiseFloor * 2, 1e-4);
  const maxSilenceFrames = Math.max(1, Math.round((maxSilenceSec * 1000) / FRAME_MS));
  const edgePadFrames = Math.max(1, Math.round(300 / FRAME_MS));

  // 残すフレームを選ぶ。無音が続いても maxSilenceFrames 分は残す。
  const keep = new Uint8Array(rms.length);
  let silentRun = 0;
  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] > silenceThreshold) {
      silentRun = 0;
      keep[f] = 1;
      if (firstVoiced < 0) firstVoiced = f;
      lastVoiced = f;
    } else {
      silentRun++;
      // 無音の前半だけ残すことで、話し終わりの余韻を保ちつつ長い空白を削る
      keep[f] = silentRun <= maxSilenceFrames ? 1 : 0;
    }
  }

  if (firstVoiced < 0) return { channels, removedSec: 0 }; // 全編無音なら何もしない

  // 冒頭と末尾は余韻を短く固定する
  for (let f = 0; f < Math.max(0, firstVoiced - edgePadFrames); f++) keep[f] = 0;
  for (let f = Math.min(rms.length, lastVoiced + edgePadFrames + 1); f < rms.length; f++) keep[f] = 0;

  const keptFrames = keep.reduce((n, v) => n + v, 0);
  if (keptFrames === rms.length) return { channels, removedSec: 0 };

  const srcLen = channels[0].length;
  const outLen = Math.min(keptFrames * frameLen, srcLen);
  const out = channels.map(() => new Float32Array(outLen));

  // フレーム境界のブツ切りを避けるため、残す区間の切れ目に短いクロスフェードをかける
  const fadeLen = Math.min(frameLen, Math.round(sampleRate * 0.005));
  let w = 0;
  for (let f = 0; f < rms.length && w < outLen; f++) {
    if (!keep[f]) continue;
    const start = f * frameLen;
    const end = Math.min(start + frameLen, srcLen);
    const isSeamStart = f === 0 || !keep[f - 1];
    const isSeamEnd = f === rms.length - 1 || !keep[f + 1];
    for (let i = start; i < end && w < outLen; i++, w++) {
      const posInFrame = i - start;
      let fade = 1;
      if (isSeamStart && posInFrame < fadeLen) fade = posInFrame / fadeLen;
      else if (isSeamEnd && end - i <= fadeLen) fade = (end - i) / fadeLen;
      for (let c = 0; c < channels.length; c++) out[c][w] = channels[c][i] * fade;
    }
  }

  const trimmed = out.map((ch) => ch.subarray(0, w));
  return { channels: trimmed, removedSec: (srcLen - w) / sampleRate };
}

export interface DspResult {
  channels: Float32Array[];
  removedSec: number;
}

export function applyDsp(
  channels: Float32Array[],
  sampleRate: number,
  options: DspOptions,
): DspResult {
  if (options.highPass) highPassInPlace(channels, sampleRate);

  // ノイズフロアはハイパス後に測る。低域の暗騒音を含んだままだと過大評価になる。
  const needsFloor = options.noiseReduction || options.trimSilence;
  const noiseFloor = needsFloor ? estimateNoiseFloor(channels, sampleRate) : 0;

  if (options.noiseReduction) noiseReduceInPlace(channels, sampleRate, noiseFloor);

  if (options.trimSilence) {
    const result = trimSilence(channels, sampleRate, noiseFloor);
    return { channels: result.channels, removedSec: result.removedSec };
  }
  return { channels, removedSec: 0 };
}
