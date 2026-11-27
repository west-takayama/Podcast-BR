import type { TranscriptSegment } from "../gemini";
import { parseTimestamp } from "../id3";
import type { CaptionCue } from "./captionAlignment";

/** Move archived absolute starts into the clip clock. End times remain unverified. */
export function archivedCaptionCues(
  transcript: TranscriptSegment[] | null | undefined,
  startSec: number,
  endSec: number,
  sourceDuration: number,
): CaptionCue[] | null {
  if (!transcript?.length) return null;
  const start = Math.round(startSec * 1000);
  const end = Math.round(endSec * 1000);
  const rows = transcript.flatMap(segment => {
    const at = parseTimestamp(segment.time);
    return at !== null && typeof segment.text === "string" && segment.text.trim() ? [{ ...segment, at }] : [];
  }).sort((a, b) => a.at - b.at);
  // Full transcription can be truncated. Only reuse ranges bounded by the available
  // transcript, with a short allowance for opening silence or the final utterance.
  if (!rows.length || rows[0].at > start + 3000 ||
      rows[rows.length - 1].at < Math.min(end, sourceDuration * 1000) - 3000) return null;
  const inside = rows.filter(row => row.at >= start && row.at < end);
  if (!inside.length) return null;
  return inside.map(row => ({
    startMs: row.at - start,
    endMs: null,
    text: row.text,
    speakerId: row.speaker?.trim() || "不明",
    emphasis: row.emphasis ?? [],
    needsReview: true,
  }));
}
