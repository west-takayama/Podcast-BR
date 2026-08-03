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
import { listModels, pickDefaultModel, pickImageModel, snapChapters, transcriptToText } from "../src/lib/gemini";
import { PauseDetector } from "../src/lib/audio/dsp";
import { overallProgress, estimateRemainingMs, formatDuration } from "../src/lib/progress";
import { wrapJapanese, PRESETS } from "../src/lib/image";
import { Diagnostics } from "../src/lib/audio/diagnostics";
import { buildImagePrompt } from "../src/lib/imagePrompt";
import { captionsForRange, speechRuns, splitCaption } from "../src/lib/video/clip";
import { decimationFactor } from "../src/lib/audio/mp3";
import { LowPassFilter } from "../src/lib/audio/dsp";
import { parseTimestamp } from "../src/lib/id3";
import { __testNormalizeClips } from "../src/lib/gemini";

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
        { name: "models/gemini-3.1-flash-image", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3-pro-image-preview", supportedGenerationMethods: ["generateContent"] },
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
    check("テキスト用に画像モデルを選ばない", !pickDefaultModel(models)!.includes("image"));
    check("イラストは無料枠のある flash 系", pickImageModel(models) === "gemini-3.1-flash-image", String(pickImageModel(models)));
    check("画像モデルが無ければ null", pickImageModel(models.filter((m) => !m.image)) === null);
  }

  console.log("\n[12] 告知画像の折り返しと禁則処理");
  {
    // measureText を全角1文字=1単位とみなす簡易実装で代用する
    const ctx = { measureText: (t: string) => ({ width: [...t].length }) } as CanvasRenderingContext2D;
    const lines = wrapJapanese(ctx, "AIに任せられる仕事、まだ無理な仕事。", 8);
    check("指定幅で折り返す", lines.every((l) => [...l].length <= 8), lines.join(" / "));
    check("全文が保たれる", lines.join("") === "AIに任せられる仕事、まだ無理な仕事。");
    check("行頭に句読点が来ない", lines.every((l) => !"、。".includes(l[0])), lines.join(" / "));

    const withBreaks = wrapJapanese(ctx, "一行目\n二行目", 20);
    check("改行を尊重する", withBreaks.length === 2 && withBreaks[0] === "一行目");
    check("空文字でも落ちない", wrapJapanese(ctx, "", 10).length === 0);
    check("プリセットは3種", PRESETS.length === 3 && PRESETS.some((p) => p.width === 3000));
  }

  console.log("\n[13] 話の切り替わり検出");
  {
    // 3秒 声 / 1.5秒 無音 / 3秒 声 / 0.2秒 無音(短いので候補にしない) / 2秒 声
    const total = SR * 10;
    const ch = new Float32Array(total);
    const voiced = (t: number) => (t < 3) || (t >= 4.5 && t < 7.5) || (t >= 7.7);
    for (let i = 0; i < total; i++) {
      const t = i / SR;
      ch[i] = (voiced(t) ? 0.3 * Math.sin(2*Math.PI*440*i/SR) : 0) + (Math.random()-0.5)*0.0005;
    }
    // ノイズフロアは実際の処理と同じく測って渡す
    const anP = new Analyzer(SR); anP.push([ch], ch.length);
    const det = new PauseDetector(SR, anP.result().noiseFloor);
    for (let i = 0; i < total; i += SR) det.push([ch.subarray(i, Math.min(i+SR, total))], Math.min(SR, total-i));
    const found = det.result();
    check("長い沈黙の後だけを候補にする", found.length === 1, `${found.map(v=>v.toFixed(2)).join(", ")} 秒`);
    check("再開位置がほぼ正しい", found.length === 1 && Math.abs(found[0] - 4.5) < 0.15, `${found[0]?.toFixed(2)} 秒 (期待 4.50)`);
  }

  console.log("\n[14] チャプター時刻の吸着");
  {
    const pauses = [0, 62.4, 185.1, 402.8];
    const r = snapChapters(
      [
        { time: "00:00", label: "オープニング" },
        { time: "01:08", label: "本題" },       // 68秒 → 62.4秒へ寄る
        { time: "03:00", label: "話題転換" },   // 180秒 → 185.1秒へ寄る
        { time: "09:00", label: "遠い" },       // 540秒 → 候補まで137秒あるので動かさない
      ],
      pauses,
    );
    const times = r.chapters.map((c) => c.time);
    check("冒頭は動かさない", times[0] === "00:00");
    check("近い候補へ寄せる", times[1] === "01:02" && times[2] === "03:05", times.join(" / "));
    check("遠い時刻は動かさない", times[3] === "09:00", times[3]);
    check("補正件数を報告する", r.movedCount === 2, `${r.movedCount}件`);
    check("候補が無ければそのまま", snapChapters([{ time: "01:08", label: "x" }], []).movedCount === 0);
    check("読めない時刻は素通し", snapChapters([{ time: "??", label: "x" }], pauses).chapters[0].time === "??");
  }

  console.log("\n[15] 書き起こしの整形");
  {
    const text = transcriptToText([
      { time: "00:00", speaker: "たかやま", text: "はじめます。" },
      { time: "00:12", speaker: "", text: "本題です。" },
    ]);
    check("時刻と話者が付く", text.includes("00:00 たかやま") && text.includes("はじめます。"));
    check("話者が空なら時刻だけ", text.includes("00:12\n本題です。"), JSON.stringify(text.slice(-20)));
  }

  console.log("\n[16] 2人別マイクの独立ノイズ低減");
  {
    // 実際の対話に近い形。8秒周期で:
    //   0-3s 左が話す / 3-3.5s 両方沈黙 / 3.5-6.5s 右が話す / 6.5-8s 両方沈黙
    // 各マイクには常に環境音が乗っている。
    const cycle = 8, n = SR * cycle * 3;
    const leftSpeaks = (t: number) => (t % cycle) < 3;
    const rightSpeaks = (t: number) => (t % cycle) >= 3.5 && (t % cycle) < 6.5;
    const make = () => {
      const l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        l[i] = (leftSpeaks(t) ? 0.25 * Math.sin(2*Math.PI*300*i/SR) : 0) + (Math.random()-0.5)*0.004;
        r[i] = (rightSpeaks(t) ? 0.25 * Math.sin(2*Math.PI*440*i/SR) : 0) + (Math.random()-0.5)*0.004;
      }
      return [l, r];
    };
    // 「左が話していて、右は話し終えて十分に時間が経っている」区間を測る。
    // リリース(150ms)があるため直後は減衰しない。これは語尾を切らないための挙動。
    const from = Math.round(SR * 9.5), to = Math.round(SR * 11);

    const linked = make(), independent = make();
    const an = new Analyzer(SR); an.push(linked, n);
    const floors = an.channelNoiseFloors();
    check("チャンネルごとのノイズフロアが取れる",
      floors.length === 2 && floors.every((f) => f > 0 && f < 0.01),
      floors.map((f) => f.toExponential(1)).join(", "));

    const beforeIdle = rmsDb(linked[1], from, to);
    const beforeVoice = rmsDb(linked[0], from, to);

    new NoiseReducer(SR, an.result().noiseFloor, false).process(linked, n);
    new NoiseReducer(SR, floors, true).process(independent, n);

    const idleLinked = rmsDb(linked[1], from, to), idleIndep = rmsDb(independent[1], from, to);
    const voiceLinked = rmsDb(linked[0], from, to), voiceIndep = rmsDb(independent[0], from, to);

    check("連動では話していない側の環境音が残る", idleLinked > beforeIdle - 2,
      `処理前 ${beforeIdle.toFixed(1)}dB → 連動 ${idleLinked.toFixed(1)}dB`);
    check("独立では話していない側の環境音が下がる", idleIndep < idleLinked - 6,
      `連動 ${idleLinked.toFixed(1)}dB → 独立 ${idleIndep.toFixed(1)}dB`);
    check("話している側はどちらでも保たれる",
      Math.abs(voiceIndep - beforeVoice) < 1 && Math.abs(voiceLinked - beforeVoice) < 1,
      `処理前 ${beforeVoice.toFixed(1)} / 連動 ${voiceLinked.toFixed(1)} / 独立 ${voiceIndep.toFixed(1)} dB`);
  }

  console.log("\n[17] プロンプト生成");
  {
    const p = buildPrompt({ ...DEFAULT_PROMPT_CONFIG, showName: "", showContext: "テスト番組", bannedWords: "超, 神回", fixedFooter: "お便りはこちら" });
    check("背景情報が入る", p.includes("テスト番組"));
    check("番組名が入る", buildPrompt({ ...DEFAULT_PROMPT_CONFIG, showName: "ブリッジラジオ" }).includes("番組名: ブリッジラジオ"));
    check("imageQuote がスキーマに入る", p.includes("imageQuote"));
    check("禁止語が入る", p.includes("超 / 神回"));
    check("定型文が入る", p.includes("お便りはこちら"));
    check("SNS項目が入る", p.includes('"social"'));
    const noSocial = buildPrompt({ ...DEFAULT_PROMPT_CONFIG, generateSocial: false });
    check("SNS無効時は含まれない", !noSocial.includes('"social"'));
    const withPauses = buildPrompt(DEFAULT_PROMPT_CONFIG, { pauses: [62.4, 185.1], durationSec: 600 });
    check("切り替わり候補が入る", withPauses.includes("01:02, 03:05"), "01:02, 03:05");
    check("音声長を伝える", withPauses.includes("10:00"));
    check("話者名が入る", buildPrompt({ ...DEFAULT_PROMPT_CONFIG, speakers: "たかやま" }).includes("話者: たかやま"));
    const withPrev = buildPrompt(DEFAULT_PROMPT_CONFIG, { previousTitles: ["#12 前回の話", "#11 その前"] });
    check("過去回のタイトルが入る", withPrev.includes("#12 前回の話") && withPrev.includes("続きの番号"));
    check("過去回が無ければ触れない", !buildPrompt(DEFAULT_PROMPT_CONFIG).includes("直近の回のタイトル"));
  }

  console.log("\n[18] 収録の診断");
  {
    const SR = 48000;
    // 声らしい信号を作る。無音区間にも暗騒音を入れる(実際の収録に合わせる)
    const speech = (n: number, amp: number) => {
      const out = new Float32Array(n);
      let seed = 3;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const t = i / SR;
        out[i] = amp * (Math.sin(2 * Math.PI * 190 * t) * 0.7 + (seed / 0x7fffffff - 0.5) * 0.2);
      }
      return out;
    };

    const titles = (f: ReturnType<Diagnostics["result"]>) => f.map((x) => x.title).join(" / ");
    const n = SR * 4;

    // 良好な収録では何も言わない
    {
      const d = new Diagnostics();
      const ch = speech(n, 0.4);
      d.push([ch, ch], n);
      const f = d.result(SR, -20, 0.002, 0.28);
      check("良好な音源では警告を出さない", f.length === 0, titles(f) || "(なし)");
    }

    // 位相反転はモノラル化で音が消えるため critical
    {
      const d = new Diagnostics();
      const l = speech(n, 0.4);
      const r = Float32Array.from(l, (v) => -v);
      d.push([l, r], n);
      const f = d.result(SR, -20, 0.002, 0.28);
      const phase = f.find((x) => x.title.includes("位相"));
      check("位相反転を検出する", !!phase, titles(f));
      check("位相反転は critical", phase?.severity === "critical", phase?.severity);
    }

    // 片チャンネルが録れていない
    {
      const d = new Diagnostics();
      d.push([speech(n, 0.4), new Float32Array(n)], n);
      const f = d.result(SR, -20, 0.002, 0.28);
      check("無音チャンネルを検出する", f.some((x) => x.title.includes("チャンネル")), titles(f));
    }

    // クリッピング
    {
      const d = new Diagnostics();
      const ch = Float32Array.from(speech(n, 1.6), (v) => Math.max(-1, Math.min(1, v)));
      d.push([ch], n);
      const f = d.result(SR, -12, 0.002, 0.6);
      const clip = f.find((x) => x.title.includes("クリッピング"));
      check("クリッピングを検出する", !!clip, titles(f));
      check("助言が付く", !!clip?.advice?.includes("レベル"), clip?.advice?.slice(0, 20));
    }

    // 直流オフセット
    {
      const d = new Diagnostics();
      const ch = Float32Array.from(speech(n, 0.3), (v) => v + 0.05);
      d.push([ch], n);
      const f = d.result(SR, -20, 0.002, 0.21);
      check("直流オフセットを検出する", f.some((x) => x.title.includes("直流")), titles(f));
    }

    // 録音レベルが低い / 環境音が大きい
    {
      const d = new Diagnostics();
      const ch = speech(n, 0.01);
      d.push([ch], n);
      const quiet = d.result(SR, -45, 0.004, 0.007);
      check("録音レベルの低さを検出する", quiet.some((x) => x.title.includes("レベル")), titles(quiet));
      check("環境音の大きさを検出する", quiet.some((x) => x.title.includes("環境音")), titles(quiet));
    }

    // 沈黙が多い回でも環境音の警告を誤って出さない(声の区間の RMS で比較する)
    {
      const d = new Diagnostics();
      const ch = new Float32Array(n);
      ch.set(speech(n / 4, 0.4)); // 4分の1だけ話している
      d.push([ch], n);
      const f = d.result(SR, -22, 0.002, 0.28);
      check("沈黙が多くても環境音の警告を出さない",
        !f.some((x) => x.title.includes("環境音")), titles(f) || "(なし)");
    }

    // 無音を渡しても落ちない
    check("空の入力で落ちない", new Diagnostics().result(SR, -Infinity, 0, 0).length === 0);
  }

  console.log("\n[19] 画像生成の注文文");
  {
    const scene = buildImagePrompt({
      headline: "ねぎ塩を超える最強のコラボを考える〜ジャガイモは全てを壊す〜 #64",
      showName: "ブリッジラジオ",
      subject: "ねぎ塩に勝てる食材の組み合わせを出し合う回",
      accent: "#ffd400",
      shape: "square",
      speakers: "たかやま, にし",
    });
    check("実写の写真だと伝える", scene.includes("実写の写真として仕上げて"));
    check("タイトルを渡す", scene.includes("「ねぎ塩を超える最強のコラボを考える〜ジャガイモは全てを壊す〜 #64」"));
    check("話している内容を渡す", scene.includes("ねぎ塩に勝てる食材の組み合わせを出し合う回"));
    check("場面に翻訳させる", scene.includes("実際に交わされている場面"));
    check("記号的な絵を避けさせる", scene.includes("記号的な比喩やアイコンではなく"));
    check("話者の人数を反映する", scene.includes("日本人 2人"), "たかやま/にし → 2人");
    check("撮影の指定を入れる", scene.includes("50mm") && scene.includes("f/2.0"));
    check("差し色を無理強いしない", scene.includes("無理に入れないでください"));
    check("題名は画像に載せさせない", scene.includes("題名やロゴを画像に載せないでください"));
    check("場面の中の文字は許す", scene.includes("ホワイトボードの手書き"));
    check("文字を置く余地を残させる", scene.includes("あとから文字を重ねます"));
    check("正方形の用途を伝える", scene.includes("正方形(1:1)"));

    const solo = buildImagePrompt({
      headline: "ひとりで話した回", showName: "", accent: "#ffd400", shape: "story", speakers: "たかやま",
    });
    check("1人なら1人と伝える", solo.includes("日本人 1人"));
    check("話者未設定なら2人にする",
      buildImagePrompt({ headline: "x", showName: "", accent: "#ffd400", shape: "square" }).includes("日本人 2人"));
    check("縦長では9:16を指定する", solo.includes("9:16"));
    check("縦長では下半分を空けさせる", solo.includes("下半分"));
    check("話題が無ければ触れない", !solo.includes("話している内容"));

    // 題名まで描かせるモード
    const poster = buildImagePrompt({
      headline: "AIに任せられる仕事", showName: "ブリッジラジオ",
      accent: "#ffd400", shape: "square", mode: "poster",
    });
    check("題名を鍵括弧で囲んで渡す", poster.includes("「AIに任せられる仕事」"));
    check("一字一句そのままと指示する", poster.includes("一字一句"));
    check("指定外の文字を足させない", poster.includes("透かし"));
    check("番組名を小さく入れる", poster.includes("小さく: 「ブリッジラジオ」"));
    check("ポスターでも実写を保つ", poster.includes("実写の写真として仕上げて"));
    check("ポスターでは余地の指示を出さない", !poster.includes("あとから文字を重ねます"));
  }

  console.log("\n[20] 切り抜きの字幕");
  {
    const long = "結論から言うと、ジャガイモは全てを壊します。理由は単純で、味が全部それになるからです。";
    const parts = splitCaption(long);
    check("長い発言を分ける", parts.length >= 2, parts.join(" / "));
    check("全文が保たれる", parts.join("") === long);
    check("短い行はそのまま", splitCaption("短い一言。").length === 1);
    check("句点が無くても落ちない", splitCaption("句点のない発言").length === 1);
    check("句読点が無い長文も分ける", splitCaption("あ".repeat(60)).length >= 2);
    check("行頭に句読点を置かない", parts.every((p) => !"、。".includes(p[0])), parts.join(" / "));
    check("端切れだけの行を作らない", parts.every((p) => p.length >= 6), parts.map((p) => p.length).join(","));

    // 語の途中で切らない。「〜という/ことです」で切れると読み手がつっかえる
    const natural = splitCaption("これはつまりネギ塩とジャガイモという組み合わせのことです。");
    check("助詞や句読点の後ろで切る",
      natural.every((p, i) => i === natural.length - 1 || /[はがのにをでともへやかねよなさばら、。]$/.test(p)),
      natural.join(" / "));

    const transcript = [
      { time: "00:04", speaker: "A", text: "結論から言うと、ジャガイモは全てを壊します。" },
      { time: "00:09", speaker: "B", text: "いや待ってください。なぜそこでジャガイモなんですか。" },
      { time: "02:00", speaker: "A", text: "区間の外の発言。" },
    ];
    const caps = captionsForRange(transcript, 5, 23);
    check("区間に重なる発言だけ拾う", caps.length >= 2, `${caps.length}行`);
    check("区間外は捨てる", !caps.some((c) => c.text.includes("区間の外")));
    check("時刻の順に並ぶ", caps.every((c, i) => i === 0 || caps[i - 1].atSec <= c.atSec));
    check("消える時刻が入る", caps.every((c) => c.endSec > c.atSec));
    check("出しっぱなしにしない", caps.every((c) => c.endSec - c.atSec <= 6.01),
      caps.map((c) => (c.endSec - c.atSec).toFixed(1)).join(" "));
    check("書き起こしが無ければ空", captionsForRange(null, 0, 60).length === 0);
    check("時刻が読めない行は捨てる",
      captionsForRange([{ time: "??", speaker: "", text: "x" }], 0, 60).length === 0);

    // 次の発言が遠くても、字幕が何十秒も先へずれないこと
    const drift = captionsForRange(
      [
        {
          time: "00:00",
          speaker: "A",
          text: "ここは長いので複数行に分かれます。二文目もそれなりの長さがあります。",
        },
        { time: "05:00", speaker: "B", text: "ずっと後の発言。" },
      ],
      0,
      30,
    );
    check("次の発言が遠くても字幕がずれない", drift[1].atSec < 5, `2行目 ${drift[1].atSec.toFixed(1)}秒`);

    // --- 実際の発話の上に置き直す ---
    // 50ms ごとの音量。2.0〜4.0秒と 6.0〜8.0秒だけ声が出ている想定
    const step = 0.05;
    const levels = new Float32Array(Math.round(20 / step));
    const loud = (from: number, to: number) => {
      for (let i = Math.round(from / step); i < Math.round(to / step); i++) levels[i] = 0.25;
    };
    for (let i = 0; i < levels.length; i++) levels[i] = 0.002; // 暗騒音
    loud(2, 4);
    loud(6, 8);

    const runs = speechRuns(levels, step);
    check("声の区間を2つ見つける", runs.length === 2,
      runs.map((r) => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(" "));
    check("区間の頭が合っている", Math.abs(runs[0].start - 2) < 0.1 && Math.abs(runs[1].start - 6) < 0.1);

    // AI が 0.7秒ずれた時刻を返してきた場合
    const snapped = captionsForRange(
      [
        { time: "00:02.7", speaker: "A", text: "最初の発言。" },
        { time: "00:05.4", speaker: "B", text: "次の発言。" },
      ],
      0,
      20,
      levels,
      step,
    );
    check("ずれた時刻を発話の頭へ寄せる", Math.abs(snapped[0].atSec - 2) < 0.2,
      `${snapped[0].atSec.toFixed(2)}秒(AIは2.70秒と返した)`);
    check("2行目も寄せる", Math.abs(snapped[1].atSec - 6) < 0.2,
      `${snapped[1].atSec.toFixed(2)}秒(AIは5.40秒と返した)`);
    check("声が止まったら消える", snapped[0].endSec < 4.6,
      `${snapped[0].endSec.toFixed(2)}秒(声は4.0秒で止まる)`);

    // 声が無いところに字幕を出さない。
    // AI が 11秒(完全な無音)と返しても、実際に声がある位置へ置き直す
    const far = captionsForRange(
      [{ time: "00:11.0", speaker: "A", text: "遠い発言。" }], 0, 20, levels, step);
    const inSpeechOf = (rs: { start: number; end: number }[], t: number) =>
      rs.some((r) => t >= r.start - 0.11 && t <= r.end);
    const inSpeech = (t: number) => inSpeechOf(runs, t);
    check("無音の位置に字幕を出さない", inSpeech(far[0].atSec),
      `${far[0].atSec.toFixed(2)}秒(AIは11.00秒と返した)`);

    // ここが今回の本題。AI の時刻が後ろへ行くほどずれても、字幕は溜め込まない。
    // 声は 1秒ずつ 6回。AI は毎回 +0.6秒ずつ余計にずれた時刻を返してくる
    const many = new Float32Array(Math.round(20 / step));
    for (let i = 0; i < many.length; i++) many[i] = 0.002;
    for (let k = 0; k < 6; k++) {
      for (let i = Math.round((k * 2 + 1) / step); i < Math.round((k * 2 + 2) / step); i++) many[i] = 0.25;
    }
    const manyRuns = speechRuns(many, step);
    const skewed = captionsForRange(
      Array.from({ length: 6 }, (_, k) => ({
        time: `00:${(k * 2 + 1 + k * 0.6).toFixed(1).padStart(4, "0")}`,
        speaker: "A",
        text: `${k + 1}番目の発言です。`,
      })),
      0,
      20,
      many,
      step,
    );
    const offs = skewed.map((c) => {
      const r = manyRuns.reduce((best, r) =>
        Math.abs(r.start - c.atSec) < Math.abs(best.start - c.atSec) ? r : best, manyRuns[0]);
      return Math.abs(c.atSec - r.start);
    });
    check("後ろの行ほどずれる、が起きない", Math.max(...offs) < 0.3,
      `各行のずれ ${offs.map((o) => o.toFixed(2)).join(" ")}秒(AI は最大 3.0秒ずれて返した)`);
    check("最後の行も声の上に乗る", inSpeechOf(manyRuns, skewed[skewed.length - 1].atSec),
      `${skewed[skewed.length - 1].atSec.toFixed(2)}秒`);

    // 単語の切れ目で一瞬音量が落ちても、文の途中で字幕を消さないこと
    const dips = new Float32Array(Math.round(20 / step));
    for (let i = 0; i < dips.length; i++) dips[i] = 0.002;
    for (let i = Math.round(2 / step); i < Math.round(8 / step); i++) {
      // 6秒間しゃべり続けるが、0.15秒の谷が何度も入る
      const t = i * step;
      dips[i] = t % 1 < 0.15 ? 0.002 : 0.25;
    }
    const kept = captionsForRange(
      [{ time: "00:02.0", speaker: "A", text: "文の途中で消えないこと。" }], 0, 20, dips, step);
    check("一瞬の谷では字幕を消さない", kept[0].endSec > 5,
      `${kept[0].endSec.toFixed(2)}秒まで表示(声は8.0秒まで続く)`);
  }

  console.log("\n[21] AI に聴かせる音声の速い経路");
  {
    check("44.1kHz は半分に間引く", decimationFactor(44100) === 2, `${44100 / decimationFactor(44100)}Hz`);
    check("48kHz は1/3に間引く", decimationFactor(48000) === 3, `${48000 / decimationFactor(48000)}Hz`);
    check("32kHz は半分に間引く", decimationFactor(32000) === 2, `${32000 / decimationFactor(32000)}Hz`);
    check("22.05kHz はそのまま", decimationFactor(22050) === 1);
    check("16kHz はそのまま", decimationFactor(16000) === 1);
    check("8kHz はそのまま(これ以上落とさない)", decimationFactor(8000) === 1);
    // 割り切れない変な値でも壊れない
    check("半端な周波数はそのまま", decimationFactor(37800) === 1);
    check("行き先は MPEG-2 が受け付ける値だけ",
      [44100, 48000, 32000, 22050, 16000, 8000, 37800]
        .every((r) => { const o = r / decimationFactor(r);
          return decimationFactor(r) === 1 || [16000, 22050, 24000, 32000].includes(o); }));

    // 折り返し防止のローパス。間引いたあとに化けて残る高い音を落とせているか
    const sr = 44100;
    const tone = (hz: number) => {
      const n = sr; // 1秒
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * hz * i) / sr);
      // ワーカーと同じ3段重ね
      for (let k = 0; k < 3; k++) new LowPassFilter(sr, 1, 22050 * 0.4).process([ch], n);
      // 立ち上がりを避けて後半だけ測る
      let sum = 0;
      for (let i = n / 2; i < n; i++) sum += ch[i] * ch[i];
      return Math.sqrt(sum / (n / 2));
    };
    const db = (v: number, ref: number) => 20 * Math.log10(v / ref);
    const pass = tone(1000);
    const voice = tone(6000);
    const edge = tone(12000); // 新しいナイキスト(11.025kHz)のすぐ上。ここが折り返す
    const high = tone(18000);
    check("声の帯域は通す(1kHz)", pass > 0.6, pass.toFixed(3));
    check("子音の帯域も残る(6kHz)", db(voice, pass) > -8, `${db(voice, pass).toFixed(1)}dB`);
    check("折り返す帯域を落とす(12kHz)", db(edge, pass) < -24, `${db(edge, pass).toFixed(1)}dB`);
    check("さらに上も落とす(18kHz)", db(high, pass) < -40, `${db(high, pass).toFixed(1)}dB`);
  }

  console.log("\n[22] 切り抜き候補の受け取り(AIの返し方の揺れ)");
  {
    const n = (raw: unknown, dur?: number) => __testNormalizeClips(raw, dur);

    check("MM:SS を受け取る",
      n([{ start: "00:10", end: "00:40", hook: "h", why: "w" }]).length === 1);
    check("秒の数値でも受け取る",
      n([{ start: 10, end: 40, hook: "h", why: "w" }]).length === 1, "start:10 end:40");
    check("秒の文字列でも受け取る",
      n([{ start: "10", end: "40", hook: "h", why: "w" }]).length === 1);
    check("小数の時刻でも受け取る",
      n([{ start: "00:10.5", end: "00:40.2", hook: "h", why: "w" }]).length === 1);

    const noEnd = n([{ start: "00:10", hook: "h", why: "w" }]);
    check("終了が無ければ補う", noEnd.length === 1 && noEnd[0].end === "00:55", noEnd[0]?.end);
    const reversed = n([{ start: "00:30", end: "00:10", hook: "h", why: "w" }]);
    check("逆転していても直す", reversed.length === 1 && reversed[0].end === "01:15", reversed[0]?.end);

    // 動画の長さに収める
    const over = n([{ start: "00:10", end: "10:00", hook: "h", why: "w" }], 40);
    check("動画の長さを超えたら切り詰める", over.length === 1 && over[0].end === "00:40",
      `${over[0]?.start}〜${over[0]?.end}`);
    const long = n([{ start: "00:00", end: "20:00", hook: "h", why: "w" }]);
    check("長すぎる候補は切り詰める(捨てない)", long.length === 1 && long[0].end === "01:30",
      long[0]?.end);

    check("短すぎる候補は捨てる",
      n([{ start: "00:10", end: "00:12", hook: "h", why: "w" }]).length === 0);
    check("読めない時刻は捨てる",
      n([{ start: "??", end: "00:40", hook: "h", why: "w" }]).length === 0);
    check("配列でなければ空", n({ nope: 1 }).length === 0);

    // 以前はここで全滅していた: 20秒の動画に 30〜60秒の候補
    const shortVideo = n(
      [
        { start: "00:00", end: "00:30", hook: "h", why: "w" },
        { start: "00:05", end: "00:45", hook: "h2", why: "w2" },
      ],
      20,
    );
    check("短い動画でも候補が残る", shortVideo.length === 2,
      shortVideo.map((c) => `${c.start}〜${c.end}`).join(" / "));
  }

  console.log(failures === 0 ? "\n✅ ALL OK\n" : `\n❌ ${failures} 件失敗\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
