import type { CaptionCue } from "./captionAlignment";

// Only immutable range drafts cross editors. Full transcripts are read from history.
const drafts = new Map<string, CaptionCue[]>();
const key = (episodeId: string, sourceId: string, range: string) => JSON.stringify([episodeId, sourceId, "range", range]);

export function readEpisodeDraft(episodeId: string, sourceId: string, range: string) {
  return drafts.get(key(episodeId, sourceId, range));
}

export function saveEpisodeDraft(episodeId: string, sourceId: string, range: string, cues: CaptionCue[]) {
  drafts.set(key(episodeId, sourceId, range), cues);
  if (drafts.size > 24) {
    const oldest = drafts.keys().next().value;
    if (oldest !== undefined) drafts.delete(oldest);
  }
}
