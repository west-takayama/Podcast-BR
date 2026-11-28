import type { Clip, EpisodeMeta, UploadedAudio } from "../../lib/gemini";
export { findClips, generateSpotifyCopy } from "../../lib/gemini";

export type EpisodeAnalysis = {
  audio?: UploadedAudio;
  facts: string[];
  clips: Clip[];
  durationSec: number;
  copy?: Pick<EpisodeMeta, "titles" | "description">;
};
