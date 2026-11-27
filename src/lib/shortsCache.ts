import { isAudioUsable, type UploadedAudio } from './gemini';

/** One component session, never persisted; callers reset when the source changes. */
export class ShortsAudioCache {
  constructor(private readonly maxEntries = 8) {}

  private entries = new Map<string, { bytes: ArrayBuffer; audio?: UploadedAudio; apiKey?: string }>();

  private version = 0;
  clear() { this.version++; this.entries.clear(); }

  private async entryFor(range: string, extract: () => Promise<ArrayBuffer>) {
    const version = this.version;
    const checkSource = () => {
      if (version !== this.version) throw new DOMException("素材が変更されました", "AbortError");
    };
    let entry = this.entries.get(range);
    if (!entry) {
      entry = { bytes: await extract() };
      checkSource();
      this.entries.set(range, entry);
      // Bounded memory even after many manual adjustments.
      if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return entry;
  }

  async getBytes(range: string, extract: () => Promise<ArrayBuffer>) {
    return (await this.entryFor(range, extract)).bytes;
  }

  async get(
    range: string,
    apiKey: string,
    extract: () => Promise<ArrayBuffer>,
    upload: (bytes: ArrayBuffer) => Promise<UploadedAudio>,
  ): Promise<UploadedAudio> {
    const version = this.version;
    const entry = await this.entryFor(range, extract);
    if (version !== this.version) throw new DOMException("素材が変更されました", "AbortError");
    if (entry.apiKey === apiKey && isAudioUsable(entry.audio)) return entry.audio!;
    const audio = await upload(entry.bytes);
    if (version !== this.version) throw new DOMException("素材が変更されました", "AbortError");
    entry.audio = audio;
    entry.apiKey = apiKey;
    return audio;
  }
}
