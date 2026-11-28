import { fromJst } from "../model";

export const creatorsUrl = "https://creators.spotify.com/";
export type PodcastStatus = "draft" | "approved" | "handoff" | "spotify-draft" | "scheduled" | "published" | "unknown" | "absent";
export type Metadata = { title: string; description: string; number: string; plannedAt: string };
export type Cover = { blob: Blob; filename: string; revision: string };
export type Approval = { by: string; at: number; audioRevision: string; digest: string };
export type PodcastEntry = {
  episodeId: string; metadata: Metadata; cover?: Cover; approval?: Approval; status: PodcastStatus;
  updatedAt: number; evidence?: string; spotifyId?: string;
  history: { status: PodcastStatus; at: number; evidence?: string; approval?: Approval }[];
};

export const emptyMetadata = (): Metadata => ({ title: "", description: "", number: "", plannedAt: "" });
export const newPodcast = (episodeId: string, metadata: Metadata, now: number): PodcastEntry =>
  ({ episodeId, metadata, status: "draft", updatedAt: now, history: [] });
export const canEdit = (status: PodcastStatus) => status === "draft" || status === "approved" || status === "absent";

export function podcastVersion(entry: PodcastEntry) {
  return JSON.stringify([entry.metadata, entry.cover?.revision, entry.approval, entry.status, entry.updatedAt, entry.history.length]);
}

function changeStatus(entry: PodcastEntry, status: PodcastStatus, now: number, evidence?: string) {
  entry.status = status;
  entry.updatedAt = now;
  entry.history.push({ status, at: now, evidence, approval: entry.approval });
}

export function revise(entry: PodcastEntry, metadata: Metadata, cover: Cover | undefined, now: number) {
  if (!canEdit(entry.status)) throw new Error("先にSpotify for Creatorsで既存の結果を照合してください。");
  const changed = JSON.stringify(metadata) !== JSON.stringify(entry.metadata) || cover?.revision !== entry.cover?.revision;
  if (!changed) return;
  entry.metadata = metadata;
  entry.cover = cover;
  entry.approval = undefined;
  changeStatus(entry, "draft", now);
}

export function validatePodcast(entry: PodcastEntry, now: number) {
  const meta = entry.metadata;
  if (!meta.title.trim() || !meta.description.trim() || !/^\d{1,9}$/.test(meta.number) || Number(meta.number) < 1) {
    throw new Error("タイトル・説明文・正のエピソード番号を確認してください。");
  }
  if (!(fromJst(meta.plannedAt) > now)) throw new Error("配信予定日時は日本時間で未来を指定してください。");
  if (!entry.cover?.blob.size || !["image/jpeg", "image/png"].includes(entry.cover.blob.type)) throw new Error("JPEGかPNGのエピソード画像を確認してください。");
}

export function approvePodcast(entry: PodcastEntry, by: string, audioRevision: string, digest: string, now: number) {
  if (!canEdit(entry.status)) throw new Error("照合が必要な配信の再承認はできません。");
  validatePodcast(entry, now);
  if (!by.trim() || !audioRevision || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("承認者と編集済みMP3を確認してください。");
  entry.approval = { by: by.trim().slice(0, 80), audioRevision, digest, at: now };
  changeStatus(entry, "approved", now);
}

export function startHandoff(entry: PodcastEntry, all: PodcastEntry[], audioRevision: string, digest: string, now: number) {
  if (entry.status !== "approved" || entry.approval?.audioRevision !== audioRevision || entry.approval.digest !== digest) {
    throw new Error("内容と現在の編集済みMP3を確認し、改めて承認してください。");
  }
  validatePodcast(entry, now);
  if (all.some(other => other.episodeId !== entry.episodeId && !canEdit(other.status) &&
    (other.approval?.digest === digest || Number(other.metadata.number) === Number(entry.metadata.number)))) {
    throw new Error("同じ音源またはエピソード番号で照合中・登録済みの回があります。");
  }
  changeStatus(entry, "handoff", now);
}

export function revoke(entry: PodcastEntry, now: number) {
  if (entry.status !== "approved") throw new Error("引き渡し後はSpotify側の確認が必要です。");
  entry.approval = undefined;
  changeStatus(entry, "draft", now);
}

type Outcome = "spotify-draft" | "scheduled" | "published" | "unknown" | "absent";
const transitions: Partial<Record<PodcastStatus, Outcome[]>> = {
  handoff: ["spotify-draft", "scheduled", "published", "unknown", "absent"],
  "spotify-draft": ["scheduled", "published", "unknown", "absent"],
  scheduled: ["published", "unknown", "absent"],
  unknown: ["spotify-draft", "scheduled", "published", "absent"],
};
export function recordPodcast(entry: PodcastEntry, all: PodcastEntry[], status: Outcome, evidence: string, id: string, now: number) {
  if (!transitions[entry.status]?.includes(status)) throw new Error("現在の状態からその結果は記録できません。");
  if (!evidence.trim() || (id && !/^[A-Za-z0-9]{10,64}$/.test(id))) throw new Error("確認内容とSpotifyエピソードIDを確認してください。");
  if (status === "published" && !id && !entry.spotifyId) throw new Error("公開済みのSpotifyエピソードIDを入力してください。");
  if (entry.spotifyId && id && id !== entry.spotifyId) throw new Error("既存のSpotifyエピソードIDと一致しません。");
  if (id && all.some(other => other.episodeId !== entry.episodeId && other.spotifyId === id)) throw new Error("そのSpotifyエピソードIDは記録済みです。");
  entry.spotifyId = id || entry.spotifyId;
  entry.evidence = evidence.trim().slice(0, 500);
  if (status === "absent") { entry.approval = undefined; entry.spotifyId = undefined; }
  changeStatus(entry, status, now, entry.evidence);
}
