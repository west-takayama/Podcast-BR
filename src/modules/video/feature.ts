import type { Clip } from "../../lib/gemini";

export type Feature = {
  episodeId: string;
  selected: boolean;
  title: string;
  number: string;
  plannedAt: string;
  approval?: { digest: string; at: number; file?: string };
  handoff?: "pending" | "unknown" | "scheduled" | "published";
  youtubeId?: string;
  publishedAt?: number;
  relatedShorts?: string[];
};
export type ShortParent = { episodeId: string; title: string; number: string };
const youtubePattern = /^[A-Za-z0-9_-]{11}$/;
export const validEpisodeId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{1,100}$/.test(id);
export const newFeature = (episodeId: string): Feature => ({ episodeId, selected: false, title: "", number: "", plannedAt: "" });
export const youtubeURL = (id: string) => "https://www.youtube.com/watch?v=" + id;
export function youtubeId(value: string) {
  const text = value.trim();
  if (youtubePattern.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && ["www.youtube.com", "youtube.com"].includes(url.hostname) && url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      if (id && youtubePattern.test(id)) return id;
    }
  } catch { /* invalid URL */ }
  throw new Error("YouTube本編の動画IDまたは視聴URLを入力してください。");
}

export function qualityClips(clips: Clip[]) {
  return clips.filter(({ scores, needsReview }) => scores && !needsReview && scores.completeness >= 10 &&
    scores.interest + scores.insight + scores.hook + scores.empathy + scores.completeness >= 75);
}

export function parseShortParent(value: unknown): ShortParent | undefined {
  if (value === undefined) return;
  const parent = value as ShortParent;
  if (!parent || !validEpisodeId(parent.episodeId) || typeof parent.title !== "string" ||
    !parent.title.trim() || parent.title.length > 100 || typeof parent.number !== "string" || !/^[0-9]{1,6}$/.test(parent.number)) {
    throw new Error("ショートと本編の対応情報を確認してください。");
  }
  return { episodeId: parent.episodeId, title: parent.title, number: parent.number };
}

export function canHandoffShort(parent: ShortParent, feature: Feature | undefined, scheduled: number, now: number) {
  if (feature?.episodeId !== parent.episodeId || !feature.selected || !feature.approval ||
    feature.handoff !== "published" || !feature.youtubeId || !youtubePattern.test(feature.youtubeId) ||
    !feature.publishedAt || feature.publishedAt > now || !Number.isFinite(scheduled) || scheduled <= feature.publishedAt ||
    feature.title !== parent.title || feature.number !== parent.number) {
    throw new Error("選抜とYouTube本編の公開確認、本編より後の日時、承認済みのタイトル・回番号を確認してください。");
  }
  return { ...parent, youtubeId: feature.youtubeId, publishedAt: feature.publishedAt };
}

export function withParentTitle(description: string, parent?: ShortParent) {
  const ending = parent ? `本編 #${parent.number}「${parent.title}」` : "";
  return ending && !description.includes(ending) ? [description.trim(), ending].filter(Boolean).join("\n\n") : description;
}
