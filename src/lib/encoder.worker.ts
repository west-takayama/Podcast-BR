// WAV → MP3 変換を UI スレッドから切り離す Web Worker。
// 受信: { buffer: ArrayBuffer } / 送信: 進捗 { type:"progress", percent } と
// 完了 { type:"done", mp3: ArrayBuffer, durationSec, gainDb } またはエラー { type:"error", message }

import { Mp3Encoder } from "@breezystack/lamejs";
import { decodeWav } from "./wav";
import { normalizeInPlace } from "./normalize";

const BITRATE_KBPS = 128;
const BLOCK_SIZE = 1152 * 32;

self.onmessage = (e: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const { sampleRate, channels, durationSec } = decodeWav(e.data.buffer);
    const gainDb = normalizeInPlace(channels);

    const numChannels = channels.length;
    const encoder = new Mp3Encoder(numChannels, sampleRate, BITRATE_KBPS);
    const frameCount = channels[0].length;

    const toInt16 = (src: Float32Array, from: number, to: number) => {
      const out = new Int16Array(to - from);
      for (let i = from; i < to; i++) {
        const v = Math.max(-1, Math.min(1, src[i]));
        out[i - from] = v < 0 ? v * 32768 : v * 32767;
      }
      return out;
    };

    const parts: Uint8Array[] = [];
    let lastPercent = -1;
    for (let start = 0; start < frameCount; start += BLOCK_SIZE) {
      const end = Math.min(start + BLOCK_SIZE, frameCount);
      const left = toInt16(channels[0], start, end);
      const right = numChannels === 2 ? toInt16(channels[1], start, end) : undefined;
      const buf = right ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
      if (buf.length > 0) parts.push(new Uint8Array(buf));

      const percent = Math.round((end / frameCount) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        self.postMessage({ type: "progress", percent });
      }
    }
    const tail = encoder.flush();
    if (tail.length > 0) parts.push(new Uint8Array(tail));

    const total = parts.reduce((n, p) => n + p.length, 0);
    const mp3 = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      mp3.set(p, pos);
      pos += p.length;
    }

    self.postMessage({ type: "done", mp3: mp3.buffer, durationSec, gainDb }, [mp3.buffer]);
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
