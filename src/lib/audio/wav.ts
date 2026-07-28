// WAV (RIFF) パーサ。収録アプリが出力する PCM WAV を対象とする。
// 対応: 16bit / 24bit / 32bit 整数 PCM、32bit float PCM

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[]; // -1.0〜1.0 のチャンネル別サンプル
  durationSec: number;
}

export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  const readTag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

  if (readTag(0) !== "RIFF" || readTag(8) !== "WAVE") {
    throw new Error("WAVファイルではありません(RIFFヘッダが見つかりません)");
  }

  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readTag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE はサブフォーマットの先頭2バイトが実フォーマット
      if (format === 0xfffe && chunkSize >= 40) {
        format = view.getUint16(body + 24, true);
      }
    } else if (chunkId === "data") {
      dataOffset = body;
      dataLength = Math.min(chunkSize, view.byteLength - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error("WAVのdataチャンクが見つかりません");
  if (numChannels < 1 || numChannels > 2) {
    throw new Error(`${numChannels}チャンネルのWAVは未対応です(モノラル/ステレオのみ)`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channels: Float32Array[] = Array.from(
    { length: numChannels },
    () => new Float32Array(frameCount),
  );

  const isFloat = format === 3;
  const isPcm = format === 1;
  if (!isFloat && !isPcm) throw new Error(`未対応のWAVフォーマットです (format=${format})`);

  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const p = dataOffset + (i * numChannels + ch) * bytesPerSample;
      let v: number;
      if (isFloat && bitsPerSample === 32) {
        v = view.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getUint8(p + 2);
        let s = (b2 << 16) | (b1 << 8) | b0;
        if (s & 0x800000) s |= ~0xffffff;
        v = s / 8388608;
      } else if (bitsPerSample === 32) {
        v = view.getInt32(p, true) / 2147483648;
      } else {
        throw new Error(`未対応のビット深度です (${bitsPerSample}bit)`);
      }
      channels[ch][i] = v;
    }
  }

  return { sampleRate, channels, durationSec: frameCount / sampleRate };
}
