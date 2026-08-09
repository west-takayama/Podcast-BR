// 人ごとに分かれた音声を、音量を揃えてから1本にまとめる。
//
// オンライン収録の道具(Riverside / Zencastr / Zoom など)は、参加者ごとに
// 別ファイルで書き出せるものが多い。分かれていれば被りも混ざりも無いので、
// **それぞれ別々に音量を測って合わせられる**。1本に混ざった音から声を
// 分離するのとは難易度がまるで違う。
//
// 全部をメモリに展開すると 60分ステレオで 1GB を超えるため、
// 読み手を少しずつ進めながら足していく。

import type { BlockHandler, BlockReader } from "./source";

/**
 * 押し出し式の読み手(read(onBlock))を、引き出し式に変える受け渡し口。
 *
 * 読み手は onBlock を await するので、こちらが「受け取り終わった」と
 * 言うまで次に進まない。おかげでバッファを上書きされる心配が無く、
 * 余分に溜め込む必要も無い。
 */
class Handoff<T> {
  private value: T | null = null;
  private waitingConsumer: ((v: T | null) => void) | null = null;
  private waitingProducer: (() => void) | null = null;
  private closed = false;

  /** 読み手側。消費側が release するまで戻らない。 */
  async put(v: T): Promise<void> {
    if (this.waitingConsumer) {
      const c = this.waitingConsumer;
      this.waitingConsumer = null;
      c(v);
    } else {
      this.value = v;
    }
    await new Promise<void>((res) => (this.waitingProducer = res));
  }

  /** 消費側。値が来るまで待つ。終わっていれば null。 */
  async take(): Promise<T | null> {
    if (this.value !== null) {
      const v = this.value;
      this.value = null;
      return v;
    }
    if (this.closed) return null;
    return new Promise<T | null>((res) => (this.waitingConsumer = res));
  }

  /** 受け取った中身を使い終わったことを読み手に伝える。 */
  release(): void {
    if (this.waitingProducer) {
      const p = this.waitingProducer;
      this.waitingProducer = null;
      p();
    }
  }

  close(): void {
    this.closed = true;
    if (this.waitingConsumer) {
      const c = this.waitingConsumer;
      this.waitingConsumer = null;
      c(null);
    }
  }
}

interface Block {
  channels: Float32Array[];
  length: number;
}

/** 読み進めている途中の1トラック。 */
class Cursor {
  private readonly handoff = new Handoff<Block>();
  private block: Block | null = null;
  private offset = 0;
  private readonly running: Promise<void>;
  /** 読み終わったか。以降は無音を返す。 */
  private ended = false;

  constructor(reader: BlockReader, readonly gain: number) {
    const onBlock: BlockHandler = async (channels, length) => {
      await this.handoff.put({ channels, length });
    };
    this.running = reader
      .read(onBlock)
      .catch((e) => {
        this.error = e;
      })
      .finally(() => this.handoff.close());
  }

  private error: unknown = null;

  /**
   * 出力バッファへ frames ぶん足し込む。
   * 足りない(短いファイル)ぶんは無音として扱い、何も足さない。
   */
  async addInto(out: Float32Array[], at: number, frames: number): Promise<void> {
    let written = 0;
    while (written < frames) {
      if (this.error) throw this.error;
      if (!this.block) {
        if (this.ended) return; // 残りは無音
        const next = await this.handoff.take();
        if (!next) {
          this.ended = true;
          return;
        }
        this.block = next;
        this.offset = 0;
      }
      const take = Math.min(frames - written, this.block.length - this.offset);
      for (let c = 0; c < out.length; c++) {
        // モノラルのトラックは全チャンネルへ同じだけ足す(真ん中に置く)
        const src = this.block.channels[Math.min(c, this.block.channels.length - 1)];
        const dest = out[c];
        for (let i = 0; i < take; i++) dest[at + written + i] += src[this.offset + i] * this.gain;
      }
      written += take;
      this.offset += take;
      if (this.offset >= this.block.length) {
        this.block = null;
        this.offset = 0;
        // ここで初めて読み手を次へ進める。使い終わるまで待たせている
        this.handoff.release();
      }
    }
  }

  async finish(): Promise<void> {
    // 読み手が途中で止まっていると終われないので、最後まで流しきる
    this.block = null;
    this.handoff.release();
    for (;;) {
      const next = await this.handoff.take();
      if (!next) break;
      this.handoff.release();
    }
    await this.running;
    if (this.error) throw this.error;
  }
}

export interface MixSource {
  reader: BlockReader;
  /** このトラックに掛ける倍率(音量を揃えるためのもの)。 */
  gain: number;
}

/**
 * 複数トラックを足して1本の読み手にする。
 *
 * BlockReader として振る舞うので、これまでの変換の流れ(解析2回 →
 * 整音 → MP3)をそのまま通せる。呼び出すたびに読み直せる点も同じ。
 */
export class MixedReader implements BlockReader {
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly durationSec: number;
  readonly formatLabel: string;

  constructor(
    private readonly open: () => Promise<MixSource[]>,
    info: { sampleRate: number; numChannels: number; durationSec: number; formatLabel: string },
    private readonly blockFrames: number,
  ) {
    this.sampleRate = info.sampleRate;
    this.numChannels = info.numChannels;
    this.durationSec = info.durationSec;
    this.formatLabel = info.formatLabel;
  }

  async read(onBlock: BlockHandler): Promise<void> {
    const sources = await this.open();
    const cursors = sources.map((s) => new Cursor(s.reader, s.gain));
    const total = Math.ceil(this.durationSec * this.sampleRate);
    const out = Array.from({ length: this.numChannels }, () => new Float32Array(this.blockFrames));

    try {
      let done = 0;
      while (done < total) {
        const frames = Math.min(this.blockFrames, total - done);
        for (const ch of out) ch.fill(0, 0, frames);
        // トラックごとに足し込む。短いトラックは無音として扱われる
        for (const cur of cursors) await cur.addInto(out, 0, frames);
        done += frames;
        await onBlock(out, frames, done / total);
      }
    } finally {
      // 途中で止めた場合も読み手を解放する
      for (const cur of cursors) {
        try {
          await cur.finish();
        } catch {
          // 片付けの失敗で本体のエラーを覆い隠さない
        }
      }
    }
  }
}

/**
 * 測ったラウドネスから、各トラックに掛ける倍率を決める。
 *
 * 合わせ先は**平均**にする。誰か一人を基準にすると、その人以外が
 * 全員片方向へ動くことになり、上限(下記)に当たって差が埋まりきらない。
 * 平均なら移動量が両側へ分かれるので、同じ上限でもより広い差を吸収できる
 * (例: 20dB 差の2人 → 平均基準なら ±10dB で揃うが、
 *  大きいほうを基準にすると +20dB が要り、上限で 8dB 残る)。
 *
 * なお最終的な音量は、このあとの −19 LUFS への調整で決まる。
 * ここで決めているのは**人と人の相対差**だけで、どちらを基準にしても
 * 仕上がりの環境音の量は変わらない。上限を設けているのは、
 * 極端に静かなトラック(ほとんど喋っていないファイルなど)を
 * 無理に持ち上げてリミッターを働かせすぎないため。
 */
export const MAX_BOOST_DB = 12;
export const MAX_CUT_DB = 12;

export function matchGainsDb(lufs: number[], manualDb: number[] = []): number[] {
  const usable = lufs.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return lufs.map((_, i) => manualDb[i] ?? 0);
  const target = usable.reduce((a, b) => a + b, 0) / usable.length;

  return lufs.map((v, i) => {
    const manual = manualDb[i] ?? 0;
    if (!Number.isFinite(v)) return manual;
    const diff = target - v;
    const clamped = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, diff));
    return clamped + manual;
  });
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
