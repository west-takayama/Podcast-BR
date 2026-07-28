// WAV (RIFF) の解析とブロック単位デコード。
//
// 全体を一度に Float32 へ展開すると 60分ステレオで 1GB を超え、スマホでは
// メモリ不足で落ちる。そのためヘッダ解析とブロックデコードを分離し、
// 呼び出し側がファイルを少しずつ読み進められるようにしている。
//
// 対応: 16bit / 24bit / 32bit 整数 PCM、32bit float PCM

export interface WavInfo {
  format: number; // 1 = 整数PCM, 3 = float
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  bytesPerFrame: number;
  dataOffset: number; // ファイル先頭からの data チャンク本体の位置
  frameCount: number;
  durationSec: number;
}

/** ヘッダ解析に必要なだけの先頭バイト数。通常は 100 バイト未満で足りる。 */
export const HEADER_PROBE_BYTES = 64 * 1024;

export function parseWavHeader(head: ArrayBuffer): WavInfo {
  const view = new DataView(head);
  const readTag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

  if (view.byteLength < 44 || readTag(0) !== "RIFF" || readTag(8) !== "WAVE") {
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
      dataLength = chunkSize;
      break; // data 以降は本体なのでヘッダ走査を終える
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error("WAVのdataチャンクが見つかりません");
  if (numChannels < 1 || numChannels > 2) {
    throw new Error(`${numChannels}チャンネルのWAVは未対応です(モノラル/ステレオのみ)`);
  }
  if (format !== 1 && format !== 3) {
    throw new Error(`未対応のWAVフォーマットです (format=${format})`);
  }
  if (![16, 24, 32].includes(bitsPerSample)) {
    throw new Error(`未対応のビット深度です (${bitsPerSample}bit)`);
  }

  const bytesPerFrame = (bitsPerSample / 8) * numChannels;
  const frameCount = Math.floor(dataLength / bytesPerFrame);
  return {
    format,
    numChannels,
    sampleRate,
    bitsPerSample,
    bytesPerFrame,
    dataOffset,
    frameCount,
    durationSec: frameCount / sampleRate,
  };
}

/**
 * 生バイト列を Float32 のチャンネル配列へ展開する。
 *
 * 16bit / 32bit は TypedArray ビューで一括参照する。DataView で1サンプルずつ
 * 読むより大幅に速い(WAV も対象プラットフォームもリトルエンディアンのため、
 * ビューのバイト順をそのまま使える)。アライメントが合わない場合のみ
 * DataView にフォールバックする。
 */
export function decodeBlock(
  raw: ArrayBuffer,
  info: WavInfo,
  frameCount: number,
  out: Float32Array[],
): void {
  const { numChannels, bitsPerSample, format } = info;
  const isFloat = format === 3;
  const sampleCount = frameCount * numChannels;

  if (bitsPerSample === 16 && raw.byteLength >= sampleCount * 2 && raw.byteLength % 2 === 0) {
    const src = new Int16Array(raw, 0, sampleCount);
    if (numChannels === 1) {
      const ch = out[0];
      for (let i = 0; i < frameCount; i++) ch[i] = src[i] / 32768;
    } else {
      const l = out[0];
      const r = out[1];
      for (let i = 0, p = 0; i < frameCount; i++, p += 2) {
        l[i] = src[p] / 32768;
        r[i] = src[p + 1] / 32768;
      }
    }
    return;
  }

  if (bitsPerSample === 32 && raw.byteLength >= sampleCount * 4 && raw.byteLength % 4 === 0) {
    const src = isFloat
      ? new Float32Array(raw, 0, sampleCount)
      : new Int32Array(raw, 0, sampleCount);
    const scale = isFloat ? 1 : 1 / 2147483648;
    for (let i = 0, p = 0; i < frameCount; i++) {
      for (let c = 0; c < numChannels; c++, p++) out[c][i] = src[p] * scale;
    }
    return;
  }

  // 24bit と、アライメントが合わない場合のフォールバック
  const bytes = new Uint8Array(raw);
  const bytesPerSample = bitsPerSample / 8;
  const view = new DataView(raw);
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      const p = (i * numChannels + c) * bytesPerSample;
      let v: number;
      if (bitsPerSample === 24) {
        let s = (bytes[p + 2] << 16) | (bytes[p + 1] << 8) | bytes[p];
        if (s & 0x800000) s |= ~0xffffff;
        v = s / 8388608;
      } else if (bitsPerSample === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (isFloat) {
        v = view.getFloat32(p, true);
      } else {
        v = view.getInt32(p, true) / 2147483648;
      }
      out[c][i] = v;
    }
  }
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
  durationSec: number;
}

/** 全体を一括デコードする。短い素材の検証用途にのみ使う。 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const info = parseWavHeader(buffer);
  const channels = Array.from(
    { length: info.numChannels },
    () => new Float32Array(info.frameCount),
  );
  const raw = buffer.slice(
    info.dataOffset,
    info.dataOffset + info.frameCount * info.bytesPerFrame,
  );
  decodeBlock(raw, info, info.frameCount, channels);
  return { sampleRate: info.sampleRate, channels, durationSec: info.durationSec };
}
