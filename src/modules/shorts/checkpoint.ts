import { parseTimestamp } from "../../lib/id3";
import type { CaptionCue } from "../../lib/video/captionAlignment";
import type { Speaker } from "../../lib/video/speakers";

export type ShortVideo = {
  blob: Blob;
  filename: string;
  title: string;
  post: string;
  description: string;
  hashtags: string[];
  startMs: number;
  endMs: number;
};

/** Subtitle cues are relative milliseconds on the original source's selected interval. */
export const captionRangeKey = (startSec: number, endSec: number) => JSON.stringify([startSec, endSec]);

export type ShortsCheckpoint = {
  nudges: Record<number, { start: number; end: number }>;
  captions: Record<number, CaptionCue[]>;
  ranges: [string, CaptionCue[]][];
  speakers: Speaker[];
  speakerLinks: Record<number, Record<string, string>>;
  videos: Record<number, ShortVideo>;
  withCaptions: boolean;
  resolution: 720 | 1080;
};

export function sourceClipRange(
  clip: { start: string; end: string },
  nudge: { start: number; end: number },
  sourceDuration?: number,
) {
  const rawStart = (parseTimestamp(clip.start) ?? 0) / 1000;
  const rawEnd = (parseTimestamp(clip.end) ?? (rawStart + 45) * 1000) / 1000;
  const limit = sourceDuration ?? rawEnd;
  const startSec = Math.min(Math.max(0, limit - 5), Math.max(0, rawStart + nudge.start));
  return { startSec, endSec: Math.min(limit, startSec + 90, Math.max(startSec + 5, rawEnd + nudge.end)) };
}
