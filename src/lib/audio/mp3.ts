// MP3 エンコーダ。mediabunny + WASM 版 LAME を使う。
//
// 純 JS の lamejs から乗り換えた。実測で約3.3倍速く、エンコードは処理時間の
// 大半を占めるため体感差が大きい。端末がネイティブの MP3 エンコードに対応して
// いればそちらが優先され、WASM は非対応時のフォールバックとして働く。

import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp3OutputFormat,
  Output,
  canEncodeAudio,
} from "mediabunny";
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";

let encoderReady: Promise<void> | null = null;

function ensureEncoder(): Promise<void> {
  if (!encoderReady) {
    encoderReady = (async () => {
      // ネイティブに対応している端末では上書きしない
      if (!(await canEncodeAudio("mp3"))) registerMp3Encoder();
    })();
  }
  return encoderReady;
}

/**
 * ブロックを順次流し込んで MP3 を組み立てる。
 * 入力全体をメモリに載せずに済むよう、開始・追加・完了を分けている。
 */
export class Mp3Stream {
  private output: Output<Mp3OutputFormat, BufferTarget>;
  private source: AudioSampleSource;
  private started: Promise<void>;
  private framesWritten = 0;

  constructor(
    private readonly numChannels: number,
    private readonly sampleRate: number,
    bitrateKbps: number,
  ) {
    this.output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
    this.source = new AudioSampleSource({ codec: "mp3", bitrate: bitrateKbps * 1000 });
    this.output.addAudioTrack(this.source);
    this.started = ensureEncoder().then(() => this.output.start());
  }

  /**
   * 呼び出し側のバッファは使い回されるため、インターリーブ用のコピーは
   * 最初の await より前に済ませる。こうすると write() から戻った時点で
   * 引数のバッファを上書きしても安全になる。
   */
  async write(channels: Float32Array[], length: number): Promise<void> {
    if (length <= 0) return;

    // mediabunny はインターリーブされた 1本の配列を受け取る
    const interleaved = new Float32Array(length * this.numChannels);
    if (this.numChannels === 1) {
      interleaved.set(channels[0].subarray(0, length));
    } else {
      const l = channels[0];
      const r = channels[1];
      for (let i = 0, p = 0; i < length; i++, p += 2) {
        interleaved[p] = l[i];
        interleaved[p + 1] = r[i];
      }
    }

    const sample = new AudioSample({
      data: interleaved,
      format: "f32",
      numberOfChannels: this.numChannels,
      sampleRate: this.sampleRate,
      timestamp: this.framesWritten / this.sampleRate,
    });
    this.framesWritten += length;

    await this.started;
    try {
      await this.source.add(sample);
    } finally {
      // 明示的に解放しないと WASM 側のバッファが GC 任せになり警告が出る
      sample.close();
    }
  }

  async finish(): Promise<ArrayBuffer> {
    await this.started;
    this.source.close();
    await this.output.finalize();
    const buffer = this.output.target.buffer;
    if (!buffer) throw new Error("MP3の生成に失敗しました");
    return buffer;
  }
}

/** 単発エンコード。短い素材の検証用途にのみ使う。 */
export async function encodeMp3(
  channels: Float32Array[],
  sampleRate: number,
  bitrateKbps: number,
): Promise<ArrayBuffer> {
  const stream = new Mp3Stream(channels.length, sampleRate, bitrateKbps);
  const CHUNK = 1152 * 32;
  for (let i = 0; i < channels[0].length; i += CHUNK) {
    const n = Math.min(CHUNK, channels[0].length - i);
    await stream.write(
      channels.map((ch) => ch.subarray(i, i + n)),
      n,
    );
  }
  return stream.finish();
}
