import { blobDigest, CANDIDATE_FOLDER_ID, DriveSaveError, versionIdentity } from "../../lib/driveSave";
import type { Candidate } from "./model";

const endpoint = "https://www.googleapis.com/drive/v3/files";
const driveId = /^[\w-]{1,200}$/;
const digest = /^[a-f0-9]{64}$/;
const fields = "id,name,mimeType,parents,trashed,appProperties,createdTime";
const media = (id: string) => `${endpoint}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;

async function read(url: string | URL, token: string, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal });
  if (!response.ok) throw new DriveSaveError(response.status);
  return response;
}

type FileInfo = { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean; createdTime?: string;
  appProperties?: { candidateId?: string; versionId?: string; studioRole?: string } };

export function parseCandidate(manifest: unknown, file: FileInfo, movie: FileInfo): Candidate {
  if (!manifest || typeof manifest !== "object") throw new Error("投稿情報を読めません。");
  const value = manifest as Record<string, unknown>;
  const video = value.video as { driveFileId?: unknown } | undefined;
  const range = value.range as { startMs?: unknown; endMs?: unknown } | undefined;
  const candidateId = file.appProperties?.candidateId ?? "";
  const versionId = file.appProperties?.versionId ?? "";
  if (!digest.test(candidateId) || !digest.test(versionId) || !driveId.test(movie.id) || !driveId.test(file.id) ||
    file.appProperties?.studioRole !== "manifest" || file.mimeType !== "application/json" || !file.parents?.includes(CANDIDATE_FOLDER_ID) || !movie.parents?.includes(CANDIDATE_FOLDER_ID) || file.trashed || movie.trashed ||
    movie.appProperties?.candidateId !== candidateId || movie.appProperties?.versionId !== versionId ||
    movie.appProperties?.studioRole !== "video" || !["video/mp4", "video/webm"].includes(movie.mimeType) ||
    value.schemaVersion !== 2 || value.status !== "pending_owner_approval" ||
    value.candidateId !== candidateId || value.versionId !== versionId || video?.driveFileId !== movie.id ||
    typeof value.title !== "string" || typeof value.description !== "string" ||
    !Array.isArray(value.hashtags) || !value.hashtags.every(tag => typeof tag === "string") ||
    typeof range?.startMs !== "number" || !Number.isSafeInteger(range.startMs) || range.startMs < 0 ||
    typeof range.endMs !== "number" || !Number.isSafeInteger(range.endMs) || range.endMs <= range.startMs) {
    throw new Error("Driveの動画と投稿情報の対応を確認できません。");
  }
  return { candidateId, versionId, manifestId: file.id, videoId: movie.id, title: value.title, description: value.description,
    hashtags: value.hashtags, filename: movie.name, mime: movie.mimeType, startMs: range.startMs, endMs: range.endMs };
}

export async function listCandidates(token: string, signal: AbortSignal) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ q: `'${CANDIDATE_FOLDER_ID}' in parents and trashed = false`, fields: `nextPageToken,files(${fields})`,
    supportsAllDrives: "true", includeItemsFromAllDrives: "true", pageSize: "100" }).toString();
  const files: FileInfo[] = [];
  do {
    const result = await (await read(url, token, signal)).json() as { files: FileInfo[]; nextPageToken?: string };
    files.push(...result.files);
    if (!result.nextPageToken) break;
    url.searchParams.set("pageToken", result.nextPageToken);
  } while (true);
  const pairs = new Map<string, FileInfo[]>();
  for (const file of files) {
    const key = JSON.stringify([file.appProperties?.candidateId, file.appProperties?.versionId]);
    if (!file.appProperties?.studioRole) continue;
    const group = pairs.get(key) ?? [];
    group.push(file);
    pairs.set(key, group);
  }
  const result: Candidate[] = [];
  let skipped = 0;
  for (const group of pairs.values()) {
    const manifest = group.find(file => file.appProperties?.studioRole === "manifest");
    const movie = group.find(file => file.appProperties?.studioRole === "video");
    if (group.length !== 2 || !manifest || !movie || !driveId.test(manifest.id)) { skipped++; continue; }
    const response = await read(media(manifest.id), token, signal);
    try { result.push(parseCandidate(await response.json(), manifest, movie)); } catch { skipped++; }
  }
  return { candidates: result, skipped };
}

export async function verifiedVideo(candidate: Candidate, token: string, signal: AbortSignal) {
  if (!driveId.test(candidate.videoId) || !driveId.test(candidate.manifestId)) throw new Error("動画IDを確認できません。");
  const info = async (id: string): Promise<FileInfo> => (await read(
    `${endpoint}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${fields}`, token, signal)).json();
  const [manifest, movie, metadata] = await Promise.all([
    info(candidate.manifestId), info(candidate.videoId), read(media(candidate.manifestId), token, signal).then(response => response.json()),
  ]);
  const live = parseCandidate(metadata, manifest, movie);
  if (JSON.stringify(live) !== JSON.stringify(candidate)) throw new Error("投稿情報が変わりました。再取得して承認してください。");
  const response = await read(media(candidate.videoId), token, signal);
  const downloaded = await response.blob();
  const blob = downloaded.type === candidate.mime ? downloaded : downloaded.slice(0, downloaded.size, candidate.mime);
  const version = await versionIdentity({ ...candidate, blob }, signal);
  if (!blob.size || version !== candidate.versionId) throw new Error("動画の版が変更されています。Driveから候補を再取得してください。");
  return { blob, digest: await blobDigest(blob, signal) };
}
