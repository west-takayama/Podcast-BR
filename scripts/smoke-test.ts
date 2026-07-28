// WAV生成 → decodeWav → normalize → MP3エンコードの一連を検証する
import { Mp3Encoder } from "@breezystack/lamejs";
import { decodeWav } from "../src/lib/wav";
import { normalizeInPlace } from "../src/lib/normalize";

function makeWav(bits: 16 | 24 | 32, float: boolean, channels: number): ArrayBuffer {
  const sampleRate = 44100;
  const seconds = 2;
  const frames = sampleRate * seconds;
  const bytesPerSample = bits / 8;
  const dataSize = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, bits, true);
  w(36, "data"); v.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) {
    const s = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sampleRate); // 静かめの音源で正規化を確認
    for (let ch = 0; ch < channels; ch++) {
      const p = 44 + (i * channels + ch) * bytesPerSample;
      if (float) v.setFloat32(p, s, true);
      else if (bits === 16) v.setInt16(p, Math.round(s * 32767), true);
      else if (bits === 24) {
        const iv = Math.round(s * 8388607);
        v.setUint8(p, iv & 0xff); v.setUint8(p + 1, (iv >> 8) & 0xff); v.setUint8(p + 2, (iv >> 16) & 0xff);
      } else v.setInt32(p, Math.round(s * 2147483647), true);
    }
  }
  return buf;
}

for (const [bits, float, ch] of [[16, false, 1], [16, false, 2], [24, false, 2], [32, true, 1]] as const) {
  const wav = makeWav(bits, float, ch);
  const decoded = decodeWav(wav);
  if (decoded.sampleRate !== 44100 || decoded.channels.length !== ch) throw new Error("decode mismatch");
  if (Math.abs(decoded.durationSec - 2) > 0.01) throw new Error("duration mismatch");
  const peakBefore = Math.max(...decoded.channels[0].slice(0, 1000).map(Math.abs));
  const gainDb = normalizeInPlace(decoded.channels);
  const enc = new Mp3Encoder(ch, decoded.sampleRate, 128);
  const toI16 = (f32: Float32Array) => Int16Array.from(f32, (x) => Math.max(-32768, Math.min(32767, x * 32767)));
  const left = toI16(decoded.channels[0]);
  const right = ch === 2 ? toI16(decoded.channels[1]) : undefined;
  const body = right ? enc.encodeBuffer(left, right) : enc.encodeBuffer(left);
  const tail = enc.flush();
  const mp3Size = body.length + tail.length;
  console.log(`${bits}bit${float ? " float" : ""} ${ch}ch: peak前=${peakBefore.toFixed(3)} gain=${gainDb.toFixed(1)}dB mp3=${(mp3Size / 1024).toFixed(0)}KB`);
  if (mp3Size < 10000) throw new Error("MP3 output too small");
}
console.log("ALL OK");
