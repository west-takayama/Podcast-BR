// 入力音声の読み取り。ブロック単位で何度でも先頭から読み直せる形にしている。
//
// WAV 以外(m4a / mp3 / aac など)も扱えるようにしたのは、通話録音をそのまま
// 投げ込めるようにするため。Zoom や Discord、スマホの録音アプリの多くは
// WAV ではなく圧縮形式で書き出す。
//
// WAV は専用の速い経路を残している。バイト列を TypedArray で直接読めるので、
// デコーダを通すより速く、収録の主な形式でもあるため。

import { AudioSampleSink, ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { HEADER_PROBE_BYTES, decodeBlock, parseWavHeader, type WavInfo } from "./wav";

export type BlockHandler = (
  channels: Float32Array[],
  length: number,
  fraction: number,
) => Promise<void> | void;

export interface BlockReader {
  sampleRate: number;
  numChannels: number;
  durationSec: number;
  /** 表示用の形式名。 */
  formatLabel: string;
  /** 先頭から読み進める。パスごとに呼び直せる。 */
  read(onBlock: BlockHandler): Promise<void>;
}

class WavReader implements BlockReader {
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly durationSec: number;
  readonly formatLabel: string;

  constructor(
    private readonly file: File,
    private readonly info: WavInfo,
    private readonly blockFrames: number,
  ) {
    this.sampleRate = info.sampleRate;
    this.numChannels = info.numChannels;
    this.durationSec = info.durationSec;
    this.formatLabel = `WAV ${info.bitsPerSample}bit`;
  }

  async read(onBlock: BlockHandler): Promise<void> {
    const { info, blockFrames } = this;
    const totalBlocks = Math.max(1, Math.ceil(info.frameCount / blockFrames));
    const channels = Array.from({ length: info.numChannels }, () => new Float32Array(blockFrames));

    for (let b = 0; b < totalBlocks; b++) {
      const startFrame = b * blockFrames;
      const frames = Math.min(blockFrames, info.frameCount - startFrame);
      if (frames <= 0) break;
      const byteStart = info.dataOffset + startFrame * info.bytesPerFrame;
      const raw = await this.file
        .slice(byteStart, byteStart + frames * info.bytesPerFrame)
        .arrayBuffer();
      decodeBlock(raw, info, frames, channels);
      await onBlock(channels, frames, (b + 1) / totalBlocks);
    }
  }
}

class DecodedReader implements BlockReader {
  constructor(
    private readonly file: File,
    readonly sampleRate: number,
    readonly numChannels: number,
    readonly durationSec: number,
    readonly formatLabel: string,
    private readonly blockFrames: number,
  ) {}

  async read(onBlock: BlockHandler): Promise<void> {
    // パスごとに読み直すため、毎回入力を開き直す
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(this.file) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error("音声トラックが見つかりません");

      const sink = new AudioSampleSink(track);
      const channels = Array.from(
        { length: this.numChannels },
        () => new Float32Array(this.blockFrames),
      );
      // デコーダが返す単位は codec 依存(1024フレーム等)なので、
      // ブロック分になるまで溜めてから渡す
      let filled = 0;
      let plane = new Float32Array(0);

      for await (const sample of sink.samples()) {
        try {
          const frames = sample.numberOfFrames;
          if (plane.length < frames) plane = new Float32Array(frames);

          let consumed = 0;
          while (consumed < frames) {
            const take = Math.min(frames - consumed, this.blockFrames - filled);
            for (let c = 0; c < this.numChannels; c++) {
              // チャンネルごとに取り出す(平面形式)。sample 側のチャンネル数が
              // 足りない場合は最後のチャンネルを流用する
              const planeIndex = Math.min(c, sample.numberOfChannels - 1);
              sample.copyTo(plane, {
                planeIndex,
                format: "f32-planar",
                frameOffset: consumed,
                frameCount: take,
              });
              channels[c].set(plane.subarray(0, take), filled);
            }
            filled += take;
            consumed += take;

            if (filled === this.blockFrames) {
              const at = sample.timestamp + sample.duration;
              await onBlock(
                channels,
                filled,
                this.durationSec > 0 ? Math.min(1, at / this.durationSec) : 1,
              );
              filled = 0;
            }
          }
        } finally {
          sample.close();
        }
      }

      if (filled > 0) await onBlock(channels, filled, 1);
    } finally {
      input.dispose?.();
    }
  }
}

/** 拡張子とコーデックから表示用の形式名を作る。同じなら重ねない。 */
function labelFor(file: File, codec: string | null): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toUpperCase();
  const c = codec?.toUpperCase();
  const parts = [...new Set([ext, c].filter(Boolean))];
  return parts.join(" / ") || "音声";
}

/**
 * 入力を開く。WAV なら専用経路、それ以外はデコーダを通す。
 * blockSeconds はブロックの長さ(秒)。
 */
export async function openAudio(file: File, blockSeconds: number): Promise<BlockReader> {
  // まず WAV として読めるか試す。読めれば速い経路を使う
  try {
    const head = await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer();
    const info = parseWavHeader(head);
    if (info.frameCount > 0) {
      return new WavReader(file, info, info.sampleRate * blockSeconds);
    }
  } catch {
    // WAV ではないのでデコーダに任せる
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw new Error(
        "音声トラックが見つかりませんでした。WAV / MP3 / M4A / AAC などの音声ファイルを選んでください。",
      );
    }
    if (!(await track.canDecode())) {
      const codec = await track.getCodec();
      throw new Error(
        `この端末では ${codec ?? "この形式"} を再生用に変換できません。WAV か MP3 でお試しください。`,
      );
    }
    const numChannels = Math.min(2, Math.max(1, track.numberOfChannels));
    const duration = await track.computeDuration();
    if (!(duration > 0)) throw new Error("音声の長さを取得できませんでした");

    return new DecodedReader(
      file,
      track.sampleRate,
      numChannels,
      duration,
      labelFor(file, await track.getCodec()),
      track.sampleRate * blockSeconds,
    );
  } finally {
    input.dispose?.();
  }
}
