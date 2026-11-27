import type { CaptionCue } from "./captionAlignment";

// Only immutable AI drafts cross editors. No media, credentials or speaker links are stored here.
const drafts = new Map<string, CaptionCue[]>();
const key = (episodeId: string, range: string) => JSON.stringify([episodeId, range]);

export function readEpisodeDraft(episodeId: string, range: string) {
  return drafts.get(key(episodeId, range));
}

export function saveEpisodeDraft(episodeId: string, range: string, cues: CaptionCue[]) {
  drafts.set(key(episodeId, range), cues);
  if (drafts.size > 24) {
    const oldest = drafts.keys().next().value;
    if (oldest !== undefined) drafts.delete(oldest);
  }
}
