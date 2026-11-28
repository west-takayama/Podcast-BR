import type { Clip } from "../../lib/gemini";

export type Feature = {
  episodeId: string;
  selected: boolean;
  title: string;
  number: string;
  plannedAt: string;
  approval?: { digest: string; at: number; file?: string; sourceRevision?: string };
  handoff?: "pending" | "unknown" | "scheduled" | "published";
  youtubeId?: string;
  linkedPublication?: true;
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
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) {
      const id = ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname) && url.pathname === "/watch"
        ? url.searchParams.get("v")
        : url.hostname === "youtu.be" ? url.pathname.slice(1).replace(/\/$/, "") : null;
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

export function linkPublishedFeature(row: Feature, all: Record<string, Feature>, parent: ShortParent, video: string, at: number, now: number): Feature {
  if (row.episodeId !== parent.episodeId || !row.selected || row.handoff || row.approval) throw new Error("選抜、承認、または既存の配信結果を確認してください。");
  const checked = parseShortParent(parent)!;
  const id = youtubeId(video);
  if (!Number.isFinite(at) || at <= 0 || at > now) throw new Error("すでに公開された日本時間を指定してください。");
  if (Object.values(all).some(entry => entry.episodeId !== row.episodeId && entry.youtubeId === id)) {
    throw new Error("このYouTube本編は別の回に登録済みです。");
  }
  return { ...row, ...checked, youtubeId: id, publishedAt: at, handoff: "published", linkedPublication: true };
}

export function canHandoffShort(parent: ShortParent, feature: Feature | undefined, scheduled: number, now: number) {
  if (feature?.episodeId !== parent.episodeId || !feature.selected || (!feature.approval && !feature.linkedPublication) ||
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
