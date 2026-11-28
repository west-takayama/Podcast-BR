import { ALL_FORMATS, AudioSampleSink, AudioSampleSource, BlobSource, EncodedPacket, EncodedVideoPacketSource,
  Input, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio } from "mediabunny";

export type VideoResolution = 720 | 1080;

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

async function coverFrame(title: string, number: string, cover?: Blob) {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d", { alpha: false })!;
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
    ctx.font = "bold 52px sans-serif";
    fittedText(ctx, title, 96, 464, bitmap ? 940 : 1600);
  } finally { bitmap?.close(); }
  return canvas;
}

async function encodeStill(canvas: HTMLCanvasElement, height: VideoResolution) {
  const width = height === 720 ? 1280 : 1920;
  const resized = document.createElement("canvas");
  resized.width = width;
  resized.height = height;
  resized.getContext("2d")!.drawImage(canvas, 0, 0, width, height);
  if (typeof VideoEncoder === "undefined") throw new Error("このブラウザーのH.264書き出しに対応していません。");
  const config: VideoEncoderConfig = { codec: "avc1.420028", width, height, bitrate: 3_000_000, framerate: 1, avc: { format: "avc" } };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error("この端末では選択した画質のH.264を書き出せません。");
  let still: EncodedPacket | undefined;
  let metadata: EncodedVideoChunkMetadata | undefined;
  let issue: DOMException | undefined;
  const encoder = new VideoEncoder({ error: error => { issue = error; }, output: (chunk, meta) => {
    still = EncodedPacket.fromEncodedChunk(chunk);
    metadata = meta;
  } });
  try {
    encoder.configure(config);
    const frame = new VideoFrame(resized, { timestamp: 0, duration: 1_000_000 });
    try { encoder.encode(frame, { keyFrame: true }); } finally { frame.close(); }
    await encoder.flush();
    if (issue) throw issue;
    if (!still || !metadata?.decoderConfig) throw new Error("カバー映像をエンコードできません。");
    return { still, metadata };
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
    const [duration, channels, sampleRate] = await Promise.all([track.computeDuration(), track.getNumberOfChannels(), track.getSampleRate()]);
    if (!Number.isFinite(duration) || duration < 1 || duration > 12 * 3600) throw new Error("1秒以上12時間以内の音源を選択してください。");
    const bitrate = channels > 1 ? 160000 : 96000;
    const audioConfig = { numberOfChannels: channels, sampleRate, bitrate };
    const nativeAac = await canEncodeAudio("aac", audioConfig);
    if (!nativeAac) {
      const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
      registerAacEncoder();
      if (!await canEncodeAudio("aac", audioConfig)) throw new Error("この端末ではAAC書き出しが利用できません。");
    }
    const { still, metadata } = await encodeStill(await coverFrame(title, number, cover), height);
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
    let boundary = 0;
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
          while (boundary + 2 <= end) {
            await picture.add(new EncodedPacket(still.data, "key", boundary, 2), boundary === 0 ? metadata : undefined);
            boundary += 2;
            onProgress(Math.min(0.99, boundary / duration));
          }
        } finally { sample.close(); }
      }
      if (!end) throw new Error("音声の有効なサンプルがありません。");
      if (end > boundary) await picture.add(new EncodedPacket(still.data, "key", boundary, end - boundary), boundary === 0 ? metadata : undefined);
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
