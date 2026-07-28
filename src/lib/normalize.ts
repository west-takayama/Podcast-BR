// ラウドネス正規化(簡易版): RMS を目標値に近づけつつピークが -1dBFS を超えないようにする。
// ポッドキャスト向けの目安 -16 LUFS に近い聴感になるよう RMS -18dBFS を目標とする。

const TARGET_RMS_DB = -18;
const PEAK_LIMIT_DB = -1;

export function normalizeInPlace(channels: Float32Array[]): number {
  let sumSquares = 0;
  let count = 0;
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      sumSquares += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    count += ch.length;
  }
  if (count === 0 || peak === 0) return 0;

  const rmsDb = 20 * Math.log10(Math.sqrt(sumSquares / count));
  let gainDb = TARGET_RMS_DB - rmsDb;
  const peakDb = 20 * Math.log10(peak);
  if (peakDb + gainDb > PEAK_LIMIT_DB) {
    gainDb = PEAK_LIMIT_DB - peakDb;
  }

  const gain = Math.pow(10, gainDb / 20);
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      ch[i] *= gain;
    }
  }
  return gainDb;
}
