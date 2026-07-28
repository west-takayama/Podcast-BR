// WAV → 整音 → MP3 変換を UI スレッドから切り離す Web Worker。
//
// ファイルは File.slice() でブロックごとに読む。全体を展開すると 60分ステレオで
// 1GB を超え、スマホでは確実に落ちるため。
//
// 2パス構成:
//   1回目(analyze) 音声を保持せずノイズフロアと正規化ゲインだけを測る
//   2回目(process) 実際に整音して MP3 を2本書き出す
//     - 配信用: 設定のビットレート
//     - AI用  : モノラル 32kbps。アップロード量を約4分の1に減らすため
//
// 受信: { file: File, dsp: DspOptions, mono: boolean, bitrate: number }
// 送信: { type:"progress", stage, fraction } / { type:"done", ... } / { type:"error", message }

import {
  Analyzer,
  HighPassFilter,
  NoiseReducer,
  SilenceTrimmer,
  applyGain,
  type DspOptions,
} from "./audio/dsp";
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
  onBlock: (channels: Float32Array[], length: number, index: number, total: number) => Promise<void> | void,
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

self.onmessage = async (e: MessageEvent<Request>) => {
  try {
    const { file, dsp, mono, bitrate } = e.data;

    const head = await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer();
    const info = parseWavHeader(head);
    if (info.frameCount === 0) throw new Error("音声データが空です");

    // --- 1回目: 解析(ノイズフロアと正規化ゲインを決める) ---
    const analyzer = new Analyzer(info.sampleRate);
    const analyzeHp = dsp.highPass
      ? new HighPassFilter(info.sampleRate, info.numChannels)
      : null;
    await forEachBlock(file, info, (channels, length, index, total) => {
      // 解析側でもハイパスを通す。低域の暗騒音を含んだままだとノイズフロアを過大評価する
      if (analyzeHp) analyzeHp.process(channels, length);
      analyzer.push(channels, length);
      post("analyze", (index + 1) / total);
    });
    const { noiseFloor, gain } = analyzer.result();

    // --- 2回目: 整音して MP3 を書き出す ---
    const outChannels = mono ? 1 : info.numChannels;
    const publish = new Mp3Stream(outChannels, info.sampleRate, bitrate);
    const forAi = new Mp3Stream(1, info.sampleRate, AI_BITRATE_KBPS);

    const hp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    const nr = dsp.noiseReduction ? new NoiseReducer(info.sampleRate, noiseFloor) : null;
    const trimmer = dsp.trimSilence
      ? new SilenceTrimmer(info.sampleRate, info.numChannels, noiseFloor)
      : null;

    let outputFrames = 0;

    // 無音カットは 20ms 単位で出力してくる。そのまま流すとエンコーダへの
    // 呼び出しが細かすぎるので、ブロック分を溜めてからまとめて渡す。
    // 溜めた分は必ず同じブロックの終わりで書き出すので、伸び続けることはない。
    const queue: { channels: Float32Array[]; length: number }[] = [];
    let queuedFrames = 0;

    const writeOut = (channels: Float32Array[], length: number) => {
      if (length <= 0) return;
      queue.push({ channels: channels.map((ch) => ch.subarray(0, length)), length });
      queuedFrames += length;
      outputFrames += length;
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

      // AI 用のモノラル。ステレオ素材は左右を平均する
      let monoView: Float32Array;
      if (info.numChannels === 1) {
        monoView = merged[0];
      } else {
        monoView = new Float32Array(total);
        const l = merged[0];
        const r = merged[1];
        for (let i = 0; i < total; i++) monoView[i] = (l[i] + r[i]) * 0.5;
      }

      await publish.write(outChannels === 1 ? [monoView] : merged, total);
      await forAi.write([monoView], total);
    };

    await forEachBlock(file, info, async (channels, length, index, total) => {
      if (hp) hp.process(channels, length);
      if (nr) nr.process(channels, length);
      applyGain(channels, length, gain);

      if (trimmer) trimmer.process(channels, length, writeOut);
      else writeOut(channels, length);

      // ブロックごとに必ず書き出す。共有バッファが次のブロックで上書きされる前に
      // エンコーダへコピーさせる必要があるため。
      await drain();
      post("process", (index + 1) / total);
    });

    let removedSec = 0;
    if (trimmer) {
      const removedFrames = trimmer.finish(writeOut);
      removedSec = removedFrames / info.sampleRate;
    }
    await drain();

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
