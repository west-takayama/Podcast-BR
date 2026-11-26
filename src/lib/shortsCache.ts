import { isAudioUsable, type UploadedAudio } from './gemini';

/** One component session, never persisted; callers reset when the source changes. */
export class ShortsAudioCache {
  private entries = new Map<string, { mp3: ArrayBuffer; audio?: UploadedAudio; apiKey?: string }>();

  private version = 0;
  clear() { this.version++; this.entries.clear(); }

  async get(
    range: string,
    apiKey: string,
    extract: () => Promise<ArrayBuffer>,
    upload: (mp3: ArrayBuffer) => Promise<UploadedAudio>,
  ): Promise<UploadedAudio> {
    const version = this.version;
    const checkSource = () => {
      if (version !== this.version) throw new DOMException("素材が変更されました", "AbortError");
    };
    let entry = this.entries.get(range);
    if (!entry) {
      entry = { mp3: await extract() };
      checkSource();
      this.entries.set(range, entry);
      // Bounded memory even after many manual adjustments.
      if (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    }
    if (entry.apiKey === apiKey && isAudioUsable(entry.audio)) return entry.audio!;
    const audio = await upload(entry.mp3);
    checkSource();
    entry.audio = audio;
    entry.apiKey = apiKey;
    return audio;
  }
}
