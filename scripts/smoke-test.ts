// WAVデコード → DSP → 正規化 → MP3エンコードの一連を検証するスモークテスト。
// 実行: npx tsx scripts/smoke-test.ts
import { Mp3Encoder } from "@breezystack/lamejs";
import { decodeWav } from "../src/lib/audio/wav";
import { normalizeInPlace } from "../src/lib/audio/normalize";
import {
  applyDsp,
  estimateNoiseFloor,
  highPassInPlace,
  noiseReduceInPlace,
  trimSilence,
} from "../src/lib/audio/dsp";
import { buildPrompt, DEFAULT_PROMPT_CONFIG } from "../src/lib/prompt";

const SR = 44100;
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function rmsDb(ch: Float32Array, from = 0, to = ch.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += ch[i] * ch[i];
  return 20 * Math.log10(Math.sqrt(sum / (to - from)) + 1e-12);
}

function makeWav(bits: 16 | 24 | 32, float: boolean, channels: number, seconds = 2): ArrayBuffer {
  const frames = SR * seconds;
  const bytesPerSample = bits / 8;
  const dataSize = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, bits, true);
  w(36, "data"); v.setUint32(40, dataSize, true);
  for (let i = 0; i < frames; i++) {
    const s = 0.25 * Math.sin((2 * Math.PI * 440 * i) / SR);
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

console.log("\n[1] WAVデコード + MP3エンコード(各ビット深度)");
for (const [bits, float, ch] of [[16, false, 1], [16, false, 2], [24, false, 2], [32, true, 1]] as const) {
  const decoded = decodeWav(makeWav(bits, float, ch));
  const okMeta = decoded.sampleRate === SR && decoded.channels.length === ch && Math.abs(decoded.durationSec - 2) < 0.01;
  const gainDb = normalizeInPlace(decoded.channels);
  const enc = new Mp3Encoder(ch, SR, 128);
  const toI16 = (f: Float32Array) => Int16Array.from(f, (x) => Math.max(-32768, Math.min(32767, x * 32767)));
  const body = ch === 2
    ? enc.encodeBuffer(toI16(decoded.channels[0]), toI16(decoded.channels[1]))
    : enc.encodeBuffer(toI16(decoded.channels[0]));
  const size = body.length + enc.flush().length;
  check(`${bits}bit${float ? " float" : ""} ${ch}ch`, okMeta && size > 10000, `gain=${gainDb.toFixed(1)}dB mp3=${(size / 1024).toFixed(0)}KB`);
}

console.log("\n[2] ハイパスフィルタ — 低域だけが落ちること");
{
  const low = new Float32Array(SR);   // 40Hz(除去対象)
  const mid = new Float32Array(SR);   // 1kHz(声の帯域・保持対象)
  for (let i = 0; i < SR; i++) {
    low[i] = 0.5 * Math.sin((2 * Math.PI * 40 * i) / SR);
    mid[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  const lowBefore = rmsDb(low), midBefore = rmsDb(mid);
  highPassInPlace([low], SR);
  highPassInPlace([mid], SR);
  // 過渡応答を避けて後半だけ測る
  const lowAfter = rmsDb(low, SR / 2), midAfter = rmsDb(mid, SR / 2);
  check("40Hz が減衰する", lowBefore - lowAfter > 10, `${(lowBefore - lowAfter).toFixed(1)}dB 減衰`);
  check("1kHz は保持される", Math.abs(midBefore - midAfter) < 1, `${(midBefore - midAfter).toFixed(2)}dB 変化`);
}

console.log("\n[3] ノイズ低減 — 無音部のノイズが下がり声は残ること");
{
  // 前半1秒: ノイズのみ / 後半1秒: 声(1kHz)+ノイズ
  const ch = new Float32Array(SR * 2);
  for (let i = 0; i < ch.length; i++) {
    const noise = (Math.random() - 0.5) * 0.02;
    const voice = i >= SR ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0;
    ch[i] = noise + voice;
  }
  const noiseBefore = rmsDb(ch, 0, SR);
  const voiceBefore = rmsDb(ch, SR);
  const floor = estimateNoiseFloor([ch], SR);
  noiseReduceInPlace([ch], SR, floor);
  const noiseAfter = rmsDb(ch, 0, SR);
  const voiceAfter = rmsDb(ch, SR + SR * 0.1); // 立ち上がり直後を除いて測る
  check("ノイズ区間が減衰する", noiseBefore - noiseAfter > 8, `${(noiseBefore - noiseAfter).toFixed(1)}dB 減衰`);
  check("声区間はほぼ無加工", Math.abs(voiceBefore - voiceAfter) < 1.5, `${(voiceBefore - voiceAfter).toFixed(2)}dB 変化`);
}

console.log("\n[4] 無音カット — 長い沈黙が詰まり、声が残ること");
{
  // 1秒 声 / 5秒 無音 / 1秒 声
  const total = SR * 7;
  const ch = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const voiced = t < 1 || t >= 6;
    ch[i] = (voiced ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0) + (Math.random() - 0.5) * 0.001;
  }
  const floor = estimateNoiseFloor([ch], SR);
  const { channels, removedSec } = trimSilence([ch], SR, floor);
  const outSec = channels[0].length / SR;
  check("無音が削られる", removedSec > 3 && removedSec < 4.5, `${removedSec.toFixed(2)}秒 削除`);
  check("声の長さは保たれる", outSec > 2.5 && outSec < 4, `残り ${outSec.toFixed(2)}秒`);
  const loudFrames = Array.from({ length: Math.floor(outSec * 10) }, (_, k) =>
    rmsDb(channels[0], k * SR * 0.1, Math.min((k + 1) * SR * 0.1, channels[0].length)) > -30);
  check("声が消えていない", loudFrames.filter(Boolean).length >= 15, `${loudFrames.filter(Boolean).length} フレームが有声`);
}

console.log("\n[5] applyDsp — 全処理を通してMP3化できること");
{
  const decoded = decodeWav(makeWav(16, false, 2, 3));
  const before = decoded.channels[0].length;
  const { channels, removedSec } = applyDsp(decoded.channels, SR, {
    highPass: true, noiseReduction: true, trimSilence: true,
  });
  normalizeInPlace(channels);
  const enc = new Mp3Encoder(channels.length, SR, 128);
  const toI16 = (f: Float32Array) => Int16Array.from(f, (x) => Math.max(-32768, Math.min(32767, x * 32767)));
  const size = enc.encodeBuffer(toI16(channels[0]), toI16(channels[1])).length + enc.flush().length;
  check("全処理を通せる", size > 10000 && channels[0].length > 0, `${before}→${channels[0].length}サンプル 削除${removedSec.toFixed(2)}秒 mp3=${(size / 1024).toFixed(0)}KB`);

  // 全編無音でも落ちないこと(実運用で起こりうる事故ケース)
  const silent = [new Float32Array(SR), new Float32Array(SR)];
  const silentResult = applyDsp(silent, SR, { highPass: true, noiseReduction: true, trimSilence: true });
  check("全編無音でも落ちない", silentResult.channels[0].length > 0);
}

console.log("\n[6] プロンプト生成");
{
  const p = buildPrompt({ ...DEFAULT_PROMPT_CONFIG, showContext: "テスト番組", bannedWords: "超, 神回", fixedFooter: "お便りはこちら" });
  check("背景情報が入る", p.includes("テスト番組"));
  check("禁止語が入る", p.includes("超 / 神回"));
  check("定型文が入る", p.includes("お便りはこちら"));
  check("SNS項目が入る", p.includes('"social"'));
  const noSocial = buildPrompt({ ...DEFAULT_PROMPT_CONFIG, generateSocial: false });
  check("SNS無効時は含まれない", !noSocial.includes('"social"'));
}

console.log(failures === 0 ? "\n✅ ALL OK\n" : `\n❌ ${failures} 件失敗\n`);
process.exit(failures === 0 ? 0 : 1);
