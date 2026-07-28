// 音声処理とプロンプト生成の検証スモークテスト。
// 実行: npx tsx scripts/smoke-test.ts
import {
  Analyzer,
  HighPassFilter,
  NoiseReducer,
  SilenceTrimmer,
  applyGain,
} from "../src/lib/audio/dsp";
import { decodeWav, parseWavHeader, decodeBlock } from "../src/lib/audio/wav";
import { encodeMp3 } from "../src/lib/audio/mp3";
import { buildPrompt, DEFAULT_PROMPT_CONFIG } from "../src/lib/prompt";
import { listModels, pickDefaultModel } from "../src/lib/gemini";
import { overallProgress, estimateRemainingMs, formatDuration } from "../src/lib/progress";

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

(async () => {
  console.log("\n[1] WAVデコード + MP3エンコード(各ビット深度)");
  for (const [bits, float, ch] of [[16, false, 1], [16, false, 2], [24, false, 2], [32, true, 1]] as const) {
    const decoded = decodeWav(makeWav(bits, float, ch));
    const okMeta = decoded.sampleRate === SR && decoded.channels.length === ch && Math.abs(decoded.durationSec - 2) < 0.01;
    // デコード値が実際に正しいか(440Hz 振幅0.25 → RMS ≈ -15dB)
    const okValue = Math.abs(rmsDb(decoded.channels[0]) - 20 * Math.log10(0.25 / Math.SQRT2)) < 0.5;
    const mp3 = await encodeMp3(decoded.channels, SR, 96);
    check(`${bits}bit${float ? " float" : ""} ${ch}ch`, okMeta && okValue && mp3.byteLength > 5000,
      `mp3=${(mp3.byteLength / 1024).toFixed(0)}KB`);
  }

  console.log("\n[2] ブロック分割デコードが一括デコードと一致すること");
  {
    const buf = makeWav(16, false, 2, 3);
    const info = parseWavHeader(buf);
    const whole = decodeWav(buf);
    const blockFrames = SR; // 1秒ずつ
    const block = Array.from({ length: 2 }, () => new Float32Array(blockFrames));
    let maxDiff = 0;
    for (let start = 0; start < info.frameCount; start += blockFrames) {
      const n = Math.min(blockFrames, info.frameCount - start);
      const byteStart = info.dataOffset + start * info.bytesPerFrame;
      decodeBlock(buf.slice(byteStart, byteStart + n * info.bytesPerFrame), info, n, block);
      for (let c = 0; c < 2; c++)
        for (let i = 0; i < n; i++)
          maxDiff = Math.max(maxDiff, Math.abs(block[c][i] - whole.channels[c][start + i]));
    }
    check("ブロック分割でも同じ値", maxDiff === 0, `最大差 ${maxDiff}`);
  }

  console.log("\n[3] ハイパスフィルタ — 低域だけが落ちること");
  {
    const low = new Float32Array(SR);
    const mid = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      low[i] = 0.5 * Math.sin((2 * Math.PI * 40 * i) / SR);
      mid[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    const lowBefore = rmsDb(low), midBefore = rmsDb(mid);
    new HighPassFilter(SR, 1).process([low], low.length);
    new HighPassFilter(SR, 1).process([mid], mid.length);
    const lowAfter = rmsDb(low, SR / 2), midAfter = rmsDb(mid, SR / 2);
    check("40Hz が減衰する", lowBefore - lowAfter > 10, `${(lowBefore - lowAfter).toFixed(1)}dB 減衰`);
    check("1kHz は保持される", Math.abs(midBefore - midAfter) < 1, `${(midBefore - midAfter).toFixed(2)}dB 変化`);
  }

  console.log("\n[4] ハイパスがブロック境界で不連続を生まないこと");
  {
    const make = () => { const a = new Float32Array(SR); for (let i = 0; i < SR; i++) a[i] = 0.4 * Math.sin(2 * Math.PI * 300 * i / SR); return a; };
    const whole = make(), split = make();
    new HighPassFilter(SR, 1).process([whole], whole.length);
    // 1000サンプルずつ分割して同じフィルタ器に通す
    const f = new HighPassFilter(SR, 1);
    for (let i = 0; i < split.length; i += 1000) {
      const view = split.subarray(i, Math.min(i + 1000, split.length));
      f.process([view], view.length);
    }
    let maxDiff = 0;
    for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(whole[i] - split[i]));
    check("分割処理でも波形が一致", maxDiff < 1e-6, `最大差 ${maxDiff.toExponential(1)}`);
  }

  console.log("\n[5] ノイズ低減 — 無音部のノイズが下がり声は残ること");
  {
    const ch = new Float32Array(SR * 2);
    for (let i = 0; i < ch.length; i++) {
      const noise = (Math.random() - 0.5) * 0.02;
      const voice = i >= SR ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0;
      ch[i] = noise + voice;
    }
    const noiseBefore = rmsDb(ch, 0, SR), voiceBefore = rmsDb(ch, SR);
    const an = new Analyzer(SR); an.push([ch], ch.length);
    const { noiseFloor } = an.result();
    new NoiseReducer(SR, noiseFloor).process([ch], ch.length);
    const noiseAfter = rmsDb(ch, 0, SR), voiceAfter = rmsDb(ch, SR + SR * 0.1);
    check("ノイズ区間が減衰する", noiseBefore - noiseAfter > 8, `${(noiseBefore - noiseAfter).toFixed(1)}dB 減衰`);
    check("声区間はほぼ無加工", Math.abs(voiceBefore - voiceAfter) < 1.5, `${(voiceBefore - voiceAfter).toFixed(2)}dB 変化`);
  }

  console.log("\n[6] 正規化ゲイン — 小さい録音が持ち上がりピークを超えないこと");
  {
    const quiet = new Float32Array(SR * 2);
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.02 * Math.sin(2 * Math.PI * 500 * i / SR);
    const an = new Analyzer(SR); an.push([quiet], quiet.length);
    const { gain } = an.result();
    applyGain([quiet], quiet.length, gain);
    let peak = 0; for (const v of quiet) peak = Math.max(peak, Math.abs(v));
    check("音量が持ち上がる", gain > 2, `ゲイン ${(20 * Math.log10(gain)).toFixed(1)}dB`);
    check("ピークが -1dBFS 以内", peak <= Math.pow(10, -1 / 20) + 1e-3, `ピーク ${(20 * Math.log10(peak)).toFixed(2)}dBFS`);
  }

  console.log("\n[7] 無音カット — 長い沈黙が詰まり、声が残ること");
  {
    const total = SR * 7; // 1秒 声 / 5秒 無音 / 1秒 声
    const ch = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const t = i / SR;
      const voiced = t < 1 || t >= 6;
      ch[i] = (voiced ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0) + (Math.random() - 0.5) * 0.001;
    }
    const an = new Analyzer(SR); an.push([ch], ch.length);
    const { noiseFloor } = an.result();
    const trimmer = new SilenceTrimmer(SR, 1, noiseFloor);
    const out: number[] = [];
    const emit = (chs: Float32Array[], len: number) => { for (let i = 0; i < len; i++) out.push(chs[0][i]); };
    // ブロック分割で流しても正しく動くこと
    for (let i = 0; i < total; i += SR * 0.7 | 0) {
      const n = Math.min((SR * 0.7) | 0, total - i);
      trimmer.process([ch.subarray(i, i + n)], n, emit);
    }
    const removedSec = trimmer.finish(emit) / SR;
    const outSec = out.length / SR;
    check("無音が削られる", removedSec > 3 && removedSec < 4.6, `${removedSec.toFixed(2)}秒 削除`);
    check("声の長さは保たれる", outSec > 2.4 && outSec < 4, `残り ${outSec.toFixed(2)}秒`);
    const arr = Float32Array.from(out);
    const loud = Array.from({ length: Math.floor(outSec * 10) }, (_, k) =>
      rmsDb(arr, k * SR * 0.1, Math.min((k + 1) * SR * 0.1, arr.length)) > -30);
    check("声が消えていない", loud.filter(Boolean).length >= 15, `${loud.filter(Boolean).length} フレームが有声`);
  }

  console.log("\n[8] 長い無音でも保留バッファが膨らまないこと");
  {
    const total = SR * 30; // 1秒 声 → 29秒 無音
    const ch = new Float32Array(total);
    for (let i = 0; i < SR; i++) ch[i] = 0.3 * Math.sin(2 * Math.PI * 1000 * i / SR);
    const trimmer = new SilenceTrimmer(SR, 1, 1e-5);
    let emitted = 0;
    const emit = (_c: Float32Array[], len: number) => { emitted += len; };
    for (let i = 0; i < total; i += SR) trimmer.process([ch.subarray(i, i + SR)], SR, emit);
    trimmer.finish(emit);
    check("29秒の無音がほぼ削除される", emitted / SR < 2.2, `出力 ${(emitted / SR).toFixed(2)}秒`);
  }

  console.log("\n[9] 全編無音・極小入力で落ちないこと");
  {
    const silent = [new Float32Array(SR), new Float32Array(SR)];
    const an = new Analyzer(SR); an.push(silent, SR);
    const r = an.result();
    new HighPassFilter(SR, 2).process(silent, SR);
    new NoiseReducer(SR, r.noiseFloor).process(silent, SR);
    applyGain(silent, SR, r.gain);
    const mp3 = await encodeMp3(silent, SR, 96);
    check("全編無音でも MP3 化できる", mp3.byteLength > 0 && Number.isFinite(r.gain), `gain=${r.gain}`);

    const tiny = [new Float32Array(10)];
    const an2 = new Analyzer(SR); an2.push(tiny, 10);
    check("10サンプルでも落ちない", Number.isFinite(an2.result().gain));
  }

  console.log("\n[10] 進捗と残り時間");
  {
    check("段階が進むと単調増加", overallProgress("analyze", 0.5) < overallProgress("process", 0.1));
    check("最後は1未満に収まる", overallProgress("generate", 1) < 1);
    check("序盤は推定しない", estimateRemainingMs(500, 0.01) === null);
    const rem = estimateRemainingMs(10000, 0.25);
    check("半分未満なら残りが経過より長い", rem !== null && rem > 10000, `残り ${rem && (rem / 1000).toFixed(0)}秒`);
    check("表示整形", formatDuration(65000) === "1分05秒" && formatDuration(30000) === "30秒");
  }

  console.log("\n[11] モデル一覧の絞り込みと優先順位");
  {
    const catalog = {
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash-preview-05-20", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/imagen-4.0", supportedGenerationMethods: ["generateContent"] },
        { name: "models/veo-3", supportedGenerationMethods: ["generateContent"] },
      ],
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(catalog), { status: 200 })) as typeof fetch;
    const models = await listModels("dummy");
    globalThis.fetch = original;

    const ids = models.map((m) => m.id);
    check("音声に使えないモデルを除く", !ids.some((i) => /embedding|imagen|veo/.test(i)), ids.join(", "));
    check("最新の安定版 flash が先頭", pickDefaultModel(models) === "gemini-3.5-flash", `先頭 ${ids[0]}`);
    check("プレビュー版は安定版より後", ids.indexOf("gemini-3.5-flash-preview-05-20") > ids.indexOf("gemini-3.5-flash"));
    check("古い世代は後ろ", ids.indexOf("gemini-2.5-flash") > ids.indexOf("gemini-3.5-flash"));
    check("空の一覧でも落ちない", pickDefaultModel([]) === null);
  }

  console.log("\n[12] プロンプト生成");
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
})();
