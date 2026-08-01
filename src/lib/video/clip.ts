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
  /** 配信用の MP3。ここから該当区間だけデコードする。 */
  mp3: ArrayBuffer;
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

/** 字幕を「開始秒つきの行」に均す。時刻が読めないものは捨てる。 */
interface Caption {
  atSec: number;
  text: string;
}

function toCaptions(transcript: TranscriptSegment[] | null | undefined): Caption[] {
  if (!transcript) return [];
  return transcript
    .map((s) => ({ atSec: (parseTimestamp(s.time) ?? -1) / 1000, text: s.text }))
    .filter((c) => c.atSec >= 0 && c.text)
    .sort((a, b) => a.atSec - b.atSec);
}

/**
 * 長い一文はそのままだと画面に入りきらないので、句読点で切って
 * 「読み上げの速さ」で時間を割り振る。字幕用の音声認識は無いため、
 * 文字数に比例させるのが実用上いちばん破綻しない。
 */
export function splitCaption(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if ("。！？!?".includes(ch) || (buf.length >= 22 && ch === "、")) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length > 0 ? parts : [text];
}

/** 区間に重なる字幕を、開始秒つきの行の列に展開する。 */
export function captionsForRange(
  transcript: TranscriptSegment[] | null | undefined,
  startSec: number,
  endSec: number,
): Caption[] {
  const all = toCaptions(transcript);
  const out: Caption[] = [];
  for (let i = 0; i < all.length; i++) {
    const seg = all[i];
    const nextAt = all[i + 1]?.atSec ?? seg.atSec + 12;
    if (nextAt <= startSec || seg.atSec >= endSec) continue;
    const pieces = splitCaption(seg.text);
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    // 次の発言が遠いと、分割した字幕が何十秒もかけて出ることになる。
    // 日本語の話速(おおむね毎秒7文字)で見積もった長さで頭打ちにする。
    const span = Math.max(0.8, Math.min(nextAt - seg.atSec, total / SPEECH_CHARS_PER_SEC));
    let cursor = seg.atSec;
    for (const piece of pieces) {
      out.push({ atSec: cursor, text: piece });
      cursor += (span * piece.length) / total;
    }
  }
  return out.sort((a, b) => a.atSec - b.atSec);
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
  mp3: ArrayBuffer,
  startSec: number,
  endSec: number,
): Promise<{ buffer: AudioBuffer; levels: Float32Array }> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(new Blob([mp3], { type: "audio/mpeg" })),
  });
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

/** 1フレーム描く。区間内の経過秒 t を受け取る。 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  opts: ClipOptions,
  captions: Caption[],
  levels: Float32Array,
  t: number,
  duration: number,
): void {
  const W = CLIP_WIDTH;
  const H = CLIP_HEIGHT;
  const pad = W * 0.075;
  const accent = opts.accent;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  if (opts.background) {
    const bg = opts.background;
    const scale = Math.max(W / bg.width, H / bg.height);
    ctx.drawImage(
      bg,
      (W - bg.width * scale) / 2,
      (H - bg.height * scale) / 2,
      bg.width * scale,
      bg.height * scale,
    );
  }

  // 上下を落として、見出しと字幕を必ず読ませる
  const scrim = ctx.createLinearGradient(0, 0, 0, H);
  scrim.addColorStop(0, "rgba(8, 8, 8, 0.82)");
  scrim.addColorStop(0.32, "rgba(8, 8, 8, 0.35)");
  scrim.addColorStop(0.62, "rgba(8, 8, 8, 0.55)");
  scrim.addColorStop(1, "rgba(8, 8, 8, 0.92)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, W, H);

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
    ctx.fillStyle = "#ffffff";
    for (const line of lines) {
      ctx.fillText(line, pad, y);
      y += size * 1.28;
    }
  }

  // 字幕。いま話している行だけを大きく出す
  const current = captions.filter((c) => c.atSec <= t).pop();
  if (current) {
    let size = W * 0.062;
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
      ctx.lineWidth = size * 0.18;
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
  const { buffer, levels } = await decodeRange(opts.mp3, startSec, endSec);
  if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
  onProgress?.(0.25);

  const captions = captionsForRange(opts.transcript, startSec, endSec).map((c) => ({
    ...c,
    atSec: c.atSec - startSec,
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
  videoSource.close();

  await output.finalize();
  onProgress?.(1);

  const bytes = (output.target as BufferTarget).buffer;
  if (!bytes) throw new Error("動画を書き出せませんでした");
  return new Blob([bytes], { type: cap.mp4 ? "video/mp4" : "video/webm" });
}
