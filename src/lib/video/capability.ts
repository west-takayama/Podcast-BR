export interface ClipCapability {
  videoCodec: "avc" | "vp9" | "vp8";
  audioCodec: "aac" | "opus";
  container: "mp4" | "webm";
  mp4: boolean;
}

/** Probe complete container-compatible pairs; individual codec support is insufficient. */
export async function chooseClipCapability(
  video: (codecs: ClipCapability['videoCodec'][]) => Promise<string | null>,
  audio: (codecs: ClipCapability['audioCodec'][]) => Promise<string | null>,
): Promise<ClipCapability | null> {
  const [avc, aac] = await Promise.all([video(['avc']), audio(['aac'])]);
  if (avc && aac) return { videoCodec: 'avc', audioCodec: 'aac', container: 'mp4', mp4: true };
  const [webVideo, opus] = await Promise.all([video(['vp9', 'vp8']), audio(['opus'])]);
  if ((webVideo === 'vp9' || webVideo === 'vp8') && opus) {
    return { videoCodec: webVideo, audioCodec: 'opus', container: 'webm', mp4: false };
  }
  return null;
}
