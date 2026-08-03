// 切り抜きの縦型動画を端末内で書き出す。
//
// ポッドキャストが伸びない一番の理由は「聴くまで中身が分からない」こと。
// 30〜60秒の縦型動画は、音声を聴かない人にも中身が届く唯一の入り口なので、
// ここだけは手数をかける価値がある。
//
// 変換と同じく端末内で完結させる。動画をどこかへ送る必要は無いし、
// 60分の音声から60秒を切り出すだけなので、必要な計算量も小さい。
//
// 書き出しは mediabunny(既に入力のデコードで使っている)の Output でまとめる。
// 第一希望は H.264 + AAC の MP4。Instagram と TikTok はこれしか受け付けない。

import {
  ALL_FORMATS,
  VideoSampleSink,
  AudioBufferSource,
  AudioSampleSink,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { TranscriptSegment } from "../gemini";
import { parseTimestamp } from "../id3";
import { wrapJapanese } from "../image";

/** 縦型ショートの標準寸法。TikTok / Reels / Shorts すべてこれで通る。 */
export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;
const FPS = 30;

const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif`;

export interface ClipOptions {
  /**
   * 音声の入り口。MP3(音声だけの回)か、動画ファイルそのもの。
   * 動画を渡した場合は、その映像を切り出して縦型に収める。
   */
  mp3?: ArrayBuffer;
  /** 動画から作る場合の元ファイル。映像と音声の両方をここから取る。 */
  videoFile?: Blob;
  startSec: number;
  endSec: number;
  /** 画面上部に大きく出す見出し。 */
  hook: string;
  showName: string;
  accent: string;
  /** 背景に敷く画像(取り込んだ写真)。無ければ暗い単色。 */
  background?: CanvasImageSource & { width: number; height: number };
  /** 字幕。区間に重なるものだけ使う。 */
  transcript?: TranscriptSegment[] | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** 事前に調べたコーデック。省くとこの場で調べる。 */
  capability?: ClipCapability;
}

/**
 * この端末で使えるコーデックを決める。
 *
 * H.264 + AAC の MP4 が第一希望。Instagram と TikTok はこれしか受け付けない。
 * ただし H.264 は特許の都合で載っていないブラウザがあるため(実際に
 * 手元の headless Chromium には無かった)、その場合は VP9 + Opus の WebM に
 * 落とす。WebM は YouTube には上げられるので、出せないよりはるかにましで、
 * 「この端末では無理です」とだけ言って終わるのは避けたい。
 */
export interface ClipCapability {
  videoCodec: "avc" | "vp9" | "vp8";
  audioCodec: "aac" | "opus";
  container: "mp4" | "webm";
  /** MP4 でないと投稿できない先があるため、UI で伝えるために持つ。 */
  mp4: boolean;
}

export async function detectCapability(): Promise<ClipCapability | null> {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return null;
  try {
    const video = await getFirstEncodableVideoCodec(["avc", "vp9", "vp8"], {
      width: CLIP_WIDTH,
      height: CLIP_HEIGHT,
    });
    const audio = await getFirstEncodableAudioCodec(["aac", "opus"]);
    if (!video || !audio) return null;
    const mp4 = video === "avc" && audio === "aac";
    return {
      videoCodec: video as ClipCapability["videoCodec"],
      audioCodec: audio as ClipCapability["audioCodec"],
      container: mp4 ? "mp4" : "webm",
      mp4,
    };
  } catch {
    return null;
  }
}

/** 日本語の話速の目安。字幕の表示時間を見積もるために使う。 */
const SPEECH_CHARS_PER_SEC = 7;
/** 1枚の字幕に載せる文字数の上限。これを超えたら分割する。 */
const CAPTION_MAX_CHARS = 24;
/** 字幕を実際の発話開始へ寄せる許容範囲。AI の時刻はこの程度ずれる。 */
const SNAP_TOLERANCE_SEC = 1.2;
/** 声が止まってからこれだけ経ったら字幕を消す。出しっぱなしにしない。 */
const CAPTION_TAIL_SEC = 0.4;
/**
 * 「声が止まった」とみなすのに必要な無音の長さ。
 * 単語の切れ目や促音でも音量は一瞬落ちるため、短い谷で消すと
 * 文の途中で字幕が消える(実際に書き出して確認した)。
 */
const MIN_SILENCE_SEC = 0.45;
/** 1枚の字幕を出し続ける上限。 */
const CAPTION_MAX_SEC = 6;

/** 字幕を「開始秒つきの行」に均す。時刻が読めないものは捨てる。 */
interface Caption {
  atSec: number;
  /** 消す時刻。声が止まったところで消えるようにする。 */
  endSec: number;
  text: string;
}

function toCaptions(transcript: TranscriptSegment[] | null | undefined): { atSec: number; text: string }[] {
  if (!transcript) return [];
  return transcript
    .map((s) => ({ atSec: (parseTimestamp(s.time) ?? -1) / 1000, text: s.text }))
    .filter((c) => c.atSec >= 0 && c.text)
    .sort((a, b) => a.atSec - b.atSec);
}

/**
 * 長い一文はそのままだと画面に入りきらないので、句読点で切る。
 * 書き起こし側にも短く区切るよう頼んでいるが、守られないことがあるため
 * ここでも保険をかけておく。
 */
export function splitCaption(text: string): string[] {
  if (text.length <= CAPTION_MAX_CHARS) return [text];
  const parts: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    const atBreak = "。！？!?".includes(ch) || (buf.length >= CAPTION_MAX_CHARS * 0.7 && "、,".includes(ch));
    if (atBreak || buf.length >= CAPTION_MAX_CHARS) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length > 0 ? parts : [text];
}

/**
 * 声が出ている区間を音量から求める。
 *
 * 字幕の時刻は AI が耳で推定したもので、1秒前後ずれる。ずれた字幕は
 * 無いより気になるので、実際に声が始まった位置へ寄せる。
 * チャプターを沈黙の位置へ吸着させているのと同じ考え方。
 */
function speechFlags(levels: Float32Array): boolean[] {
  if (levels.length === 0) return [];
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const peak = sorted[sorted.length - 1];
  const threshold = Math.max(floor * 3, peak * 0.06, 1e-4);
  return Array.from(levels, (v) => v > threshold);
}

/** 声が始まる位置(無音 → 有音の変わり目)を秒で返す。 */
function speechOnsets(flags: boolean[], stepSec: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] && !flags[i - 1]) out.push(i * stepSec);
  }
  if (flags[0]) out.unshift(0);
  return out;
}

/**
 * at 以降で声が途切れる位置。字幕を消す時刻に使う。
 * 一瞬の谷では切らず、MIN_SILENCE_SEC 続けて無音になったところを終わりとする。
 */
function speechEndAfter(flags: boolean[], stepSec: number, at: number): number {
  const need = Math.max(1, Math.round(MIN_SILENCE_SEC / stepSec));
  let i = Math.max(0, Math.round(at / stepSec));
  // まだ声が始まっていなければ、まず始まるところまで進む
  while (i < flags.length && !flags[i]) i++;

  let silentFrom = -1;
  for (; i < flags.length; i++) {
    if (flags[i]) {
      silentFrom = -1;
      continue;
    }
    if (silentFrom < 0) silentFrom = i;
    if (i - silentFrom + 1 >= need) return silentFrom * stepSec;
  }
  return flags.length * stepSec;
}

/**
 * 区間に重なる字幕を、実際の発話に合わせて並べ直す。
 * levels は 50ms ごとの音量(波形の描画で作ったものを使い回す)。
 */
export function captionsForRange(
  transcript: TranscriptSegment[] | null | undefined,
  startSec: number,
  endSec: number,
  levels?: Float32Array,
  stepSec = 0.05,
): Caption[] {
  const all = toCaptions(transcript);
  const rough: { atSec: number; text: string }[] = [];
  for (let i = 0; i < all.length; i++) {
    const seg = all[i];
    const nextAt = all[i + 1]?.atSec ?? seg.atSec + 12;
    if (nextAt <= startSec || seg.atSec >= endSec) continue;
    const pieces = splitCaption(seg.text);
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    // 次の発言が遠いと、分割した字幕が何十秒もかけて出ることになる。
    // 日本語の話速で見積もった長さで頭打ちにする。
    const span = Math.max(0.8, Math.min(nextAt - seg.atSec, total / SPEECH_CHARS_PER_SEC));
    let cursor = seg.atSec;
    for (const piece of pieces) {
      rough.push({ atSec: cursor, text: piece });
      cursor += (span * piece.length) / total;
    }
  }
  rough.sort((a, b) => a.atSec - b.atSec);

  const flags = levels ? speechFlags(levels) : [];
  const onsets = flags.length > 0 ? speechOnsets(flags, stepSec) : [];

  const out: Caption[] = [];
  for (let i = 0; i < rough.length; i++) {
    const c = rough[i];
    let at = c.atSec;

    // 実際に声が始まった位置が近くにあれば、そこへ寄せる
    if (onsets.length > 0) {
      const rel = at - startSec;
      let best = -1;
      let bestDiff = SNAP_TOLERANCE_SEC;
      for (const onset of onsets) {
        const diff = Math.abs(onset - rel);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = onset;
        }
      }
      if (best >= 0) at = startSec + best;
    }

    // 前の字幕より前には出さない
    if (out.length > 0 && at <= out[out.length - 1].atSec) {
      at = out[out.length - 1].atSec + 0.25;
    }

    const nextAt = rough[i + 1]?.atSec ?? Infinity;
    // 声が途切れたら消す。次の字幕が来るまで出しっぱなしにしない
    const silence =
      flags.length > 0
        ? startSec + speechEndAfter(flags, stepSec, at - startSec) + CAPTION_TAIL_SEC
        : Infinity;
    const end = Math.min(nextAt - 0.05, silence, at + CAPTION_MAX_SEC);

    out.push({ atSec: at, endSec: Math.max(at + 0.4, end), text: c.text });
  }
  return out;
}

/** 波形の帯。音が鳴っていることを目で分からせる(無音再生への対策)。 */
function drawBars(
  ctx: CanvasRenderingContext2D,
  levels: Float32Array,
  at: number,
  accent: string,
): void {
  const bars = 48;
  const width = CLIP_WIDTH * 0.72;
  const x0 = (CLIP_WIDTH - width) / 2;
  const y = CLIP_HEIGHT * 0.845;
  const gap = width / bars;
  const barWidth = gap * 0.5;
  const maxHeight = CLIP_HEIGHT * 0.05;
  ctx.fillStyle = accent;
  for (let i = 0; i < bars; i++) {
    // 現在位置を中心に前後の音量を並べ、流れているように見せる
    const idx = Math.round((at - (bars / 2 - i) * 0.05) / 0.05);
    const v = levels[Math.max(0, Math.min(levels.length - 1, idx))] ?? 0;
    const h = Math.max(6, maxHeight * Math.min(1, v * 3.2));
    ctx.globalAlpha = 0.35 + Math.min(0.65, v * 2.2);
    ctx.beginPath();
    ctx.roundRect(x0 + i * gap, y - h / 2, barWidth, h, barWidth / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * 区間の音声だけをデコードする。
 * 60分ぶんを丸ごと展開するとスマホでは落ちるため、必要な秒数だけ取り出す。
 */
async function decodeRange(
  input: Input,
  startSec: number,
  endSec: number,
): Promise<{ buffer: AudioBuffer; levels: Float32Array }> {
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("音声を読み取れませんでした");

  const sink = new AudioSampleSink(track);
  const sampleRate = track.sampleRate;
  const channels = Math.min(2, track.numberOfChannels);
  const frames = Math.ceil((endSec - startSec) * sampleRate);
  const buffer = new AudioContext({ sampleRate }).createBuffer(channels, frames, sampleRate);
  const planes = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));

  for await (const sample of sink.samples(startSec, endSec)) {
    const offset = Math.round((sample.timestamp - startSec) * sampleRate);
    const count = Math.min(sample.numberOfFrames, frames - offset);
    if (count <= 0) {
      sample.close();
      continue;
    }
    const tmp = new Float32Array(sample.numberOfFrames);
    for (let c = 0; c < channels; c++) {
      sample.copyTo(tmp, {
        planeIndex: Math.min(c, sample.numberOfChannels - 1),
        format: "f32-planar",
      });
      const dest = planes[c];
      for (let i = 0; i < count; i++) {
        const at = offset + i;
        if (at >= 0 && at < frames) dest[at] = tmp[i];
      }
    }
    sample.close();
  }

  // 50ms ごとの音量。波形の描画に使う
  const step = Math.round(sampleRate * 0.05);
  const levels = new Float32Array(Math.ceil(frames / step));
  for (let i = 0; i < levels.length; i++) {
    let sum = 0;
    const from = i * step;
    const to = Math.min(frames, from + step);
    for (let j = from; j < to; j++) sum += planes[0][j] * planes[0][j];
    levels[i] = Math.sqrt(sum / Math.max(1, to - from));
  }

  return { buffer, levels };
}

/** 元動画のコマ。VideoSample は width/height を持たないので別扱いにする。 */
interface Frame {
  width: number;
  height: number;
  image: CanvasImageSource;
}

/** 1フレーム描く。区間内の経過秒 t を受け取る。 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  opts: ClipOptions,
  captions: Caption[],
  levels: Float32Array,
  t: number,
  duration: number,
  frame?: Frame | null,
): void {
  const W = CLIP_WIDTH;
  const H = CLIP_HEIGHT;
  const pad = W * 0.075;
  const accent = opts.accent;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  // 元動画のコマがあればそれを、無ければ静止画を敷く。
  // どちらも短辺に合わせて中央で切り出す(横長の動画は左右が切れる)
  const bg = frame ?? opts.background;
  if (bg) {
    const image = "image" in bg ? bg.image : bg;
    const scale = Math.max(W / bg.width, H / bg.height);
    ctx.drawImage(
      image,
      (W - bg.width * scale) / 2,
      (H - bg.height * scale) / 2,
      bg.width * scale,
      bg.height * scale,
    );
  }

  // 文字を読ませるための暗幕は、上下の帯だけに掛ける。
  // 全面に掛けると元の映像が潰れる。動画から作る場合はそれが主役なので、
  // 中央は触らない(字幕は縁取りで読ませる)。
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.26);
  top.addColorStop(0, "rgba(8, 8, 8, 0.7)");
  top.addColorStop(1, "rgba(8, 8, 8, 0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H * 0.26);

  const bottom = ctx.createLinearGradient(0, H * 0.74, 0, H);
  bottom.addColorStop(0, "rgba(8, 8, 8, 0)");
  bottom.addColorStop(1, "rgba(8, 8, 8, 0.8)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H * 0.74, W, H * 0.26);

  ctx.textBaseline = "top";

  // 番組名(小さく・字間を開けて)
  let y = H * 0.085;
  if (opts.showName) {
    const size = W * 0.03;
    ctx.font = `700 ${size}px ${FONT_STACK}`;
    ctx.fillStyle = accent;
    ctx.fillText(opts.showName, pad, y);
    y += size * 1.9;
  }

  // 見出し。最初の2秒で読ませたいので画面上部に置く
  if (opts.hook) {
    let size = W * 0.082;
    let lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      ctx.font = `bold ${size}px ${FONT_STACK}`;
      lines = wrapJapanese(ctx, opts.hook, W - pad * 2);
      if (lines.length <= 3) break;
      size = Math.round(size * 0.92);
    }
    // 明るい映像の上でも読めるよう、見出しにも縁取りを入れる
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = "rgba(8, 8, 8, 0.8)";
    ctx.lineJoin = "round";
    for (const line of lines) {
      ctx.strokeText(line, pad, y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, pad, y);
      y += size * 1.28;
    }
  }

  // 字幕。いま話している行だけを出す(声が止まったら消える)
  const current = captions.find((c) => c.atSec <= t && t < c.endSec);
  if (current) {
    let size = W * 0.068;
    let lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      ctx.font = `bold ${size}px ${FONT_STACK}`;
      lines = wrapJapanese(ctx, current.text, W - pad * 2);
      if (lines.length <= 4) break;
      size = Math.round(size * 0.92);
    }
    const lineHeight = size * 1.36;
    const blockTop = H * 0.63 - (lines.length * lineHeight) / 2;
    ctx.textAlign = "center";
    for (let i = 0; i < lines.length; i++) {
      const ly = blockTop + i * lineHeight;
      // 背景がどんな写真でも読めるよう、縁取りしてから塗る
      ctx.lineWidth = size * 0.2;
      ctx.strokeStyle = "rgba(8, 8, 8, 0.85)";
      ctx.lineJoin = "round";
      ctx.strokeText(lines[i], W / 2, ly);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(lines[i], W / 2, ly);
    }
    ctx.textAlign = "left";
  }

  drawBars(ctx, levels, t, accent);

  // 残り時間のバー。最後まで見てもらうため
  const barY = H - H * 0.045;
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.fillRect(pad, barY, W - pad * 2, 8);
  ctx.fillStyle = accent;
  ctx.fillRect(pad, barY, (W - pad * 2) * Math.min(1, t / duration), 8);
}

/**
 * 縦型動画を書き出す。返り値は MP4 の Blob。
 *
 * 音声は AAC、映像は H.264。Instagram / TikTok / YouTube が
 * そのまま受け取れる組み合わせにしている。
 */
export async function renderClip(opts: ClipOptions): Promise<Blob> {
  const { startSec, endSec, onProgress, signal } = opts;
  const duration = Math.max(1, endSec - startSec);

  onProgress?.(0.02);
  const source = opts.videoFile ?? new Blob([opts.mp3!], { type: "audio/mpeg" });
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source) });
  const { buffer, levels } = await decodeRange(input, startSec, endSec);
  // 動画から作る場合は、その映像を背景として使う
  const videoTrack = opts.videoFile ? await input.getPrimaryVideoTrack() : null;
  const frameSink = videoTrack ? new VideoSampleSink(videoTrack) : null;
  if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
  onProgress?.(0.25);

  const captions = captionsForRange(opts.transcript, startSec, endSec, levels).map((c) => ({
    ...c,
    atSec: c.atSec - startSec,
    endSec: c.endSec - startSec,
  }));

  const canvas = document.createElement("canvas");
  canvas.width = CLIP_WIDTH;
  canvas.height = CLIP_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("描画できませんでした");

  const cap = opts.capability ?? (await detectCapability());
  if (!cap) throw new Error("この端末では動画を書き出せません");
  const output = new Output({
    format: cap.mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: cap.videoCodec, bitrate: QUALITY_HIGH });
  const audioSource = new AudioBufferSource({ codec: cap.audioCodec, bitrate: 128e3 });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  output.addAudioTrack(audioSource);
  await output.start();

  await audioSource.add(buffer);
  audioSource.close();

  const totalFrames = Math.round(duration * FPS);

  if (frameSink) {
    // 元動画のコマを1枚ずつ受け取りながら書き出す。
    // samplesAtTimestamps は時刻が昇順なら各パケットを一度しかデコードしないので、
    // 1コマずつ getSample を呼ぶより桁違いに速い。
    const stamps = Array.from({ length: totalFrames }, (_, i) => startSec + i / FPS);
    let i = 0;
    let last: Frame | null = null;
    for await (const sample of frameSink.samplesAtTimestamps(stamps)) {
      if (signal?.aborted) {
        sample?.close();
        await output.cancel();
        throw new DOMException("中止しました", "AbortError");
      }
      const t = i / FPS;
      if (sample) {
        last = {
          width: sample.displayWidth,
          height: sample.displayHeight,
          image: sample.toCanvasImageSource(),
        };
        drawFrame(ctx, opts, captions, levels, t, duration, last);
        sample.close();
      } else {
        // コマが取れない時刻は直前のコマを出す(黒落ちさせない)
        drawFrame(ctx, opts, captions, levels, t, duration, last);
      }
      await videoSource.add(t, 1 / FPS);
      if (i % 15 === 0) onProgress?.(0.25 + 0.7 * (i / totalFrames));
      i++;
    }
  } else {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) {
        await output.cancel();
        throw new DOMException("中止しました", "AbortError");
      }
      const t = i / FPS;
      drawFrame(ctx, opts, captions, levels, t, duration);
      await videoSource.add(t, 1 / FPS);
      if (i % 15 === 0) onProgress?.(0.25 + 0.7 * (i / totalFrames));
    }
  }
  videoSource.close();

  await output.finalize();
  onProgress?.(1);

  const bytes = (output.target as BufferTarget).buffer;
  if (!bytes) throw new Error("動画を書き出せませんでした");
  return new Blob([bytes], { type: cap.mp4 ? "video/mp4" : "video/webm" });
}
