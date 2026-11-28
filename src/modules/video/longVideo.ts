import { ALL_FORMATS, AudioSampleSink, AudioSampleSource, BlobSource, EncodedPacket, EncodedVideoPacketSource,
  Input, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio } from "mediabunny";

export type VideoResolution = 360 | 480 | 720;
const widths: Record<VideoResolution, number> = { 360: 640, 480: 854, 720: 1280 };
const fps = 24;
const gopSize = fps * 2;
const videoBitrates: Record<VideoResolution, number> = { 360: 350_000, 480: 500_000, 720: 750_000 };

function fittedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number) {
  const lines: string[] = [""];
  for (const char of text) {
    const last = lines.length - 1;
    if (ctx.measureText(lines[last] + char).width > width) {
      if (lines.length === 4) { lines[last] = lines[last].slice(0, -1) + "…"; break; }
      lines.push(char);
    } else lines[last] += char;
  }
  lines.forEach((line, index) => ctx.fillText(line, x, y + 62 * index, width));
}

async function coverFrame(title: string, number: string, height: VideoResolution, cover?: Blob) {
  const canvas = document.createElement("canvas");
  canvas.width = widths[height];
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.scale(canvas.width / 1920, canvas.height / 1080);
  ctx.fillStyle = "#121212";
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.fillStyle = "#ffd400";
  ctx.fillRect(96, 704, 142, 8);
  ctx.font = "bold 50px sans-serif";
  ctx.fillText("BRIDGE RADIO", 190, 256);
  ctx.font = "bold 34px sans-serif";
  ctx.fillText("EPISODE  " + number, 96, 373);
  const logo = await fetch(new URL("icon-192.png", document.baseURI)).then(r => r.ok ? r.blob().then(blob => createImageBitmap(blob)) : undefined).catch(() => undefined);
  try { if (logo) ctx.drawImage(logo, 96, 192, 74, 74); } finally { logo?.close(); }
  const bitmap = cover ? await createImageBitmap(cover) : undefined;
  try {
    if (bitmap) {
      const factor = 640 / Math.max(bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 1438 - bitmap.width * factor / 2, 540 - bitmap.height * factor / 2, bitmap.width * factor, bitmap.height * factor);
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 60px sans-serif";
    fittedText(ctx, title, 96, 464, bitmap ? 940 : 1600);
  } finally { bitmap?.close(); }
  return canvas;
}

async function encodeStill(canvas: HTMLCanvasElement, height: VideoResolution) {
  const width = canvas.width;
  const unsupported = () => new DOMException("この端末では選択した画質のH.264を書き出せません。", "NotSupportedError");
  if (typeof VideoEncoder === "undefined") throw unsupported();
  const config: VideoEncoderConfig = { codec: "avc1.420028", width, height, bitrate: videoBitrates[height], framerate: fps,
    latencyMode: "realtime", avc: { format: "avc" } };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw unsupported();
  const gop: EncodedPacket[] = [];
  let metadata: EncodedVideoChunkMetadata | undefined;
  let issue: DOMException | undefined;
  const encoder = new VideoEncoder({ error: error => { issue = error; }, output: (chunk, meta) => {
    gop.push(EncodedPacket.fromEncodedChunk(chunk));
    if (!metadata && meta?.decoderConfig) metadata = meta;
  } });
  try {
    encoder.configure(config);
    const still = new VideoFrame(canvas, { timestamp: 0 });
    try {
      for (let i = 0; i < gopSize; i++) {
        const timestamp = Math.round(i * 1_000_000 / fps);
        const duration = Math.round((i + 1) * 1_000_000 / fps) - timestamp;
        const frame = new VideoFrame(still, { timestamp, duration });
        try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
      }
    } finally { still.close(); }
    await encoder.flush();
    if (issue) throw issue;
    if (gop.length !== gopSize || gop[0].type !== "key" || !metadata?.decoderConfig ||
      gop.some((packet, index) => packet.microsecondTimestamp !== Math.round(index * 1_000_000 / fps))) {
      throw unsupported();
    }
    return { gop, metadata };
  } finally { if (encoder.state !== "closed") encoder.close(); }
}

export async function generateLongVideo(args: {
  file: File; title: string; number: string; cover?: Blob; height: VideoResolution;
  signal: AbortSignal; onProgress: (progress: number) => void;
}) {
  const { file, title, number, cover, height, signal, onProgress } = args;
  signal.throwIfAborted();
  const dir = await navigator.storage.getDirectory();
  const name = `studio-feature-${crypto.randomUUID()}.mp4`;
  const handle = await dir.getFileHandle(name, { create: true });
  let writer: FileSystemWritableFileStream | undefined;
  let finished = false;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) throw new Error("編集済みのMP3またはWAVを読み込めません。");
    const [channels, sampleRate] = await Promise.all([track.getNumberOfChannels(), track.getSampleRate()]);
    const bitrate = channels > 1 ? 160000 : 96000;
    const audioConfig = { numberOfChannels: channels, sampleRate, bitrate };
    const nativeAac = await canEncodeAudio("aac", audioConfig);
    if (!nativeAac) throw new DOMException("このブラウザーはAAC書き出しに対応していません。編集済み音源は保存されています。対応する端末で本編を書き出してください。", "NotSupportedError");
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration < 1 || duration > 12 * 3600) throw new Error("1秒以上12時間以内の音源を選択してください。");
    const { gop, metadata } = await encodeStill(await coverFrame(title, number, height, cover), height);
    signal.throwIfAborted();
    writer = await handle.createWritable();
    const target = new StreamTarget(new WritableStream({
      write: chunk => writer!.write({ type: "write", position: chunk.position, data: chunk.data }),
    }));
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
    const sound = new AudioSampleSource({ codec: "aac", bitrate });
    const picture = new EncodedVideoPacketSource("avc");
    output.addAudioTrack(sound);
    output.addVideoTrack(picture);
    await output.start();
    // Reuse a closed baseline AVC GOP. Its first IDR resets references at every boundary.
    let frameIndex = 0;
    const emitFrames = async (until: number) => {
      while (frameIndex / fps < until) {
        signal.throwIfAborted();
        const frame = gop[frameIndex % gopSize];
        const start = frameIndex / fps;
        const finish = Math.min(until, (frameIndex + 1) / fps);
        await picture.add(new EncodedPacket(frame.data, frame.type, start, finish - start), frameIndex === 0 ? metadata : undefined);
        frameIndex++;
      }
    };
    let end = 0;
    let first: number | undefined;
    try {
      for await (const sample of new AudioSampleSink(track).samples()) {
        try {
          signal.throwIfAborted();
          first ??= sample.timestamp;
          sample.setTimestamp(sample.timestamp - first);
          end = Math.max(end, sample.timestamp + sample.duration);
          await sound.add(sample);
          const boundary = Math.floor(end / 2) * 2;
          if (boundary > frameIndex / fps) {
            await emitFrames(boundary);
            onProgress(Math.min(0.99, boundary / duration));
          }
        } finally { sample.close(); }
      }
      if (!end) throw new Error("音声の有効なサンプルがありません。");
      await emitFrames(end);
      signal.throwIfAborted();
      await output.finalize();
      await writer.close();
      finished = true;
      onProgress(1);
      return { file: await handle.getFile(), duration: end, nativeAac };
    } catch (error) {
      await output.cancel().catch(() => {});
      throw error;
    }
  } finally {
    input.dispose();
    if (!finished) {
      await writer?.abort().catch(() => {});
      await dir.removeEntry(name).catch(() => {});
    }
  }
}
