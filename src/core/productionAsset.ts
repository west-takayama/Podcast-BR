export type ProductionAsset = Readonly<{
  id: string;
  revision: string;
  kind: "audio" | "video";
  file: File;
}>;

/** Retain the original File handle. Existing history owns durable audio storage. */
export function createProductionAsset(file: File): ProductionAsset {
  return { id: crypto.randomUUID(), revision: "1", kind: file.type.startsWith("video/") ? "video" : "audio", file };
}

export function validateAudioOutput(file: File): boolean {
  return file.size > 0 && /\.(mp3|wav)$/i.test(file.name) &&
    (!file.type || /^(?:audio\/|application\/octet-stream$)/i.test(file.type));
}
