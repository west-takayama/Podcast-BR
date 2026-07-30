// WAV → 整音 → MP3 変換を UI スレッドから切り離す Web Worker。
//
// ファイルは File.slice() でブロックごとに読む。全体を展開すると 60分ステレオで
// 1GB を超え、スマホでは確実に落ちるため。
//
// 2パス構成:
//   1回目 ノイズフロアを測る
//   2回目 整音した状態の積分ラウドネス(LUFS)を測る
//   (必要時) リミッターで下がる分を試し処理で測り、ゲインを補正する
//   最後  整音 → 目標ラウドネスへ調整 → リミッター → MP3を2本書き出す
//     - 配信用: 設定のビットレート
//     - AI用  : モノラル 32kbps。アップロード量を約4分の1に減らすため
//
// ラウドネスは配信されるチャンネル構成で測る。モノラルに落とすと合算が減って
// 約3dB下がるため、ステレオのまま測ると目標を外す。
//
// 受信: { file, dsp, mono, bitrate }
// 送信: { type:"progress", stage, fraction } / { type:"done", ... } / { type:"error", message }

import {
  Analyzer,
  HighPassFilter,
  NoiseReducer,
  PauseDetector,
  SilenceTrimmer,
  applyGain,
  type DspOptions,
} from "./audio/dsp";
import { LoudnessMeter, gainForTarget, targetLufs } from "./audio/loudness";
import { CEILING_DBFS, Limiter } from "./audio/limiter";
import { HEADER_PROBE_BYTES, decodeBlock, parseWavHeader, type WavInfo } from "./audio/wav";
import { Mp3Stream } from "./audio/mp3";

const BLOCK_SECONDS = 10;
const AI_BITRATE_KBPS = 32;

interface Request {
  file: File;
  dsp: DspOptions;
  mono: boolean;
  bitrate: number;
}

function post(stage: "analyze" | "process", fraction: number) {
  self.postMessage({ type: "progress", stage, fraction });
}

/** ファイルをブロック単位で読み進め、デコード済みチャンネルを順に渡す。 */
async function forEachBlock(
  file: File,
  info: WavInfo,
  onBlock: (
    channels: Float32Array[],
    length: number,
    index: number,
    total: number,
  ) => Promise<void> | void,
): Promise<void> {
  const blockFrames = info.sampleRate * BLOCK_SECONDS;
  const totalBlocks = Math.max(1, Math.ceil(info.frameCount / blockFrames));
  const channels = Array.from({ length: info.numChannels }, () => new Float32Array(blockFrames));

  for (let b = 0; b < totalBlocks; b++) {
    const startFrame = b * blockFrames;
    const frames = Math.min(blockFrames, info.frameCount - startFrame);
    if (frames <= 0) break;
    const byteStart = info.dataOffset + startFrame * info.bytesPerFrame;
    const raw = await file.slice(byteStart, byteStart + frames * info.bytesPerFrame).arrayBuffer();
    decodeBlock(raw, info, frames, channels);
    await onBlock(channels, frames, b, totalBlocks);
  }
}

/** ステレオを平均してモノラルにする。左右で位相が揃った音声を前提とする。 */
function downmix(channels: Float32Array[], length: number, out: Float32Array): Float32Array {
  if (channels.length === 1) {
    out.set(channels[0].subarray(0, length));
  } else {
    const l = channels[0];
    const r = channels[1];
    for (let i = 0; i < length; i++) out[i] = (l[i] + r[i]) * 0.5;
  }
  return out.subarray(0, length);
}

self.onmessage = async (e: MessageEvent<Request>) => {
  try {
    const { file, dsp, mono, bitrate } = e.data;

    const head = await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer();
    const info = parseWavHeader(head);
    if (info.frameCount === 0) throw new Error("音声データが空です");

    const outChannels = mono ? 1 : info.numChannels;
    const target = targetLufs(outChannels);

    const monoScratch = new Float32Array(info.sampleRate * BLOCK_SECONDS);

    // --- 1回目: ノイズフロアを測る ---
    // ハイパスを通してから測る。低域の暗騒音を含んだままだと過大評価になる。
    const analyzer = new Analyzer(info.sampleRate);
    const floorHp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    await forEachBlock(file, info, (channels, length, index, total) => {
      if (floorHp) floorHp.process(channels, length);
      analyzer.push(channels, length);
      post("analyze", ((index + 1) / total) / 3);
    });
    const { noiseFloor } = analyzer.result();

    // --- 2回目: 整音後のラウドネスを測る ---
    // ノイズ低減は信号の音量を下げるため、その後の状態で測らないと
    // 目標ラウドネスを外す(実測で 9dB 以上ずれた)。
    // ノイズ低減にはノイズフロアが必要で、それには全体を見る必要があるため、
    // 解析を2回に分けている。読み込みは軽く、変換に比べれば僅かな時間で済む。
    const meter = new LoudnessMeter(info.sampleRate, outChannels);
    const measureHp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    const measureNr = dsp.noiseReduction ? new NoiseReducer(info.sampleRate, noiseFloor) : null;
    await forEachBlock(file, info, (channels, length, index, total) => {
      if (measureHp) measureHp.process(channels, length);
      if (measureNr) measureNr.process(channels, length);
      // ラウドネスは配信されるチャンネル構成で測る
      meter.push(
        outChannels === 1 ? [downmix(channels, length, monoScratch)] : channels,
        length,
      );
      post("analyze", 1 / 3 + ((index + 1) / total) / 3);
    });

    const measuredLufs = meter.integratedLufs();
    let gain = gainForTarget(measuredLufs, target);
    let correctionDb = 0;

    // --- 必要なときだけ: リミッターの効きを見て音量を補正する ---
    //
    // 突発的な大音量(笑い声など)は全体エネルギーの多くを占めることがあり、
    // それをリミッターで抑えると積分ラウドネスが目標より下がる(実測で 1.9dB)。
    // そこで一度だけ試し処理をして、下がった分を足し戻す。
    //
    // ゲインを掛けてもピークが上限に届かない素材ではリミッターが働かないので、
    // その場合はこのパスを省いて時間を無駄にしない。会話中心の録音では
    // ピーク余裕が大きく、多くの場合ここは省かれる。
    const peakAfterGainDb = meter.peakDbfs() + 20 * Math.log10(gain);
    const needsCorrection = Number.isFinite(measuredLufs) && peakAfterGainDb > CEILING_DBFS;

    if (needsCorrection) {
      const trialMeter = new LoudnessMeter(info.sampleRate, outChannels);
      const trialLimiter = new Limiter(info.sampleRate, outChannels);
      const trialHp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
      const trialNr = dsp.noiseReduction ? new NoiseReducer(info.sampleRate, noiseFloor) : null;

      await forEachBlock(file, info, (channels, length, index, total) => {
        if (trialHp) trialHp.process(channels, length);
        if (trialNr) trialNr.process(channels, length);
        const shaped =
          outChannels === 1 ? [downmix(channels, length, monoScratch)] : channels;
        applyGain(shaped, length, gain);
        trialLimiter.process(shaped, length, (limited, len) => trialMeter.push(limited, len));
        post("analyze", 2 / 3 + ((index + 1) / total) / 3);
      });
      trialLimiter.flush((limited, len) => trialMeter.push(limited, len));

      const achieved = trialMeter.integratedLufs();
      if (Number.isFinite(achieved)) {
        // 足し戻しは +6dB までに制限する。これを超えるほど抑制が必要な素材は
        // 無理に持ち上げると抑揚が失われるため、狙いを外したまま報告する
        correctionDb = Math.min(6, Math.max(0, target - achieved));
        gain *= Math.pow(10, correctionDb / 20);
      }
    }
    post("analyze", 1);

    // --- 3回目: 整音して MP3 を書き出す ---
    const publish = new Mp3Stream(outChannels, info.sampleRate, bitrate);
    const forAi = new Mp3Stream(1, info.sampleRate, AI_BITRATE_KBPS);

    const hp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    const nr = dsp.noiseReduction ? new NoiseReducer(info.sampleRate, noiseFloor) : null;
    const trimmer = dsp.trimSilence
      ? new SilenceTrimmer(info.sampleRate, info.numChannels, noiseFloor)
      : null;
    const limiter = new Limiter(info.sampleRate, outChannels);
    // 仕上がりのラウドネスを実測して報告する。リミッターが働いた分だけ
    // 目標から下がるため、狙い通りかを利用者が確認できるようにする
    const outMeter = new LoudnessMeter(info.sampleRate, outChannels);
    // 話の切り替わり候補。出力の時間軸で拾うので、無音カット後でも再生位置と一致する
    const pauses = new PauseDetector(info.sampleRate, noiseFloor);

    let outputFrames = 0;

    // 無音カットは 20ms 単位で出力してくる。そのまま流すとエンコーダへの
    // 呼び出しが細かすぎるので、ブロック分を溜めてからまとめて渡す。
    const queue: { channels: Float32Array[]; length: number }[] = [];
    let queuedFrames = 0;

    const collect = (channels: Float32Array[], length: number) => {
      if (length <= 0) return;
      queue.push({ channels: channels.map((ch) => ch.subarray(0, length)), length });
      queuedFrames += length;
    };

    const monoOut = new Float32Array(info.sampleRate * (BLOCK_SECONDS + 2));

    /** リミッター通過後のサンプルをエンコーダへ渡す。 */
    const writeLimited = async (limited: Float32Array[], length: number) => {
      outputFrames += length;
      outMeter.push(limited, length);
      pauses.push(limited, length);
      const monoView =
        outChannels === 1 ? limited[0].subarray(0, length) : downmix(limited, length, monoOut);
      await publish.write(limited, length);
      await forAi.write([monoView], length);
    };

    const drain = async () => {
      if (queuedFrames === 0) return;
      const total = queuedFrames;
      const merged = Array.from({ length: info.numChannels }, () => new Float32Array(total));
      let at = 0;
      for (const item of queue) {
        for (let c = 0; c < info.numChannels; c++) merged[c].set(item.channels[c], at);
        at += item.length;
      }
      queue.length = 0;
      queuedFrames = 0;

      // 配信チャンネル数へ落としてからゲインとリミッターを通す
      const shaped =
        outChannels === 1 ? [downmix(merged, total, monoOut)] : merged;
      applyGain(shaped, total, gain);

      const pending: Promise<void>[] = [];
      limiter.process(shaped, total, (limited, len) => {
        pending.push(writeLimited(limited, len));
      });
      await Promise.all(pending);
    };

    await forEachBlock(file, info, async (channels, length, index, total) => {
      if (hp) hp.process(channels, length);
      if (nr) nr.process(channels, length);

      if (trimmer) trimmer.process(channels, length, collect);
      else collect(channels, length);

      // ブロックごとに必ず書き出す。共有バッファが次のブロックで
      // 上書きされる前にエンコーダへコピーさせる必要があるため。
      await drain();
      post("process", (index + 1) / total);
    });

    let removedSec = 0;
    if (trimmer) {
      const removedFrames = trimmer.finish(collect);
      removedSec = removedFrames / info.sampleRate;
    }
    await drain();

    // 先読み分の残りを出し切る
    const tail: Promise<void>[] = [];
    limiter.flush((limited, len) => {
      tail.push(writeLimited(limited, len));
    });
    await Promise.all(tail);

    const [publishMp3, aiMp3] = await Promise.all([publish.finish(), forAi.finish()]);

    self.postMessage(
      {
        type: "done",
        mp3: publishMp3,
        aiMp3,
        durationSec: outputFrames / info.sampleRate,
        sourceDurationSec: info.durationSec,
        removedSec,
        channels: outChannels,
        sampleRate: info.sampleRate,
        // 音量の実測値。UI で狙い通りか示すために返す
        sourceLufs: measuredLufs,
        outputLufs: outMeter.integratedLufs(),
        targetLufs: target,
        correctionDb,
        peakDbfs: outMeter.peakDbfs(),
        limitedSamples: limiter.reducedSamples,
        // チャプター時刻を吸着させるための候補位置(秒)
        pauses: pauses.result(),
      },
      [publishMp3, aiMp3],
    );
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
