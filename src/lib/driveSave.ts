import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const CANDIDATE_FOLDER_ID = "14tBUxITSF8mdAx5eAtBqZvGeKbSq-oqu";
export const CANDIDATE_FOLDER_URL = `https://drive.google.com/drive/folders/${CANDIDATE_FOLDER_ID}`;
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,trashed,appProperties,createdTime";
const BLOB_DIGESTS = new WeakMap<Blob, string>();

export interface DriveShort {
  blob: Blob;
  title: string;
  description: string;
  hashtags: string[];
  startMs: number;
  endMs: number;
}

export interface SavedShort {
  candidateId: string;
  versionId: string;
  latestVersionId: string;
  videoId: string;
  manifestId: string;
  reused: boolean;
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  createdTime?: string;
  appProperties?: Record<string, string>;
  capabilities?: { canAddChildren?: boolean };
}
interface ReservedIds { video: string; manifest: string }
type Role = keyof ReservedIds;

export async function blobDigest(blob: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  let digest = BLOB_DIGESTS.get(blob);
  if (!digest) {
    const hash = sha256.create();
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
      }
      signal.throwIfAborted();
      digest = bytesToHex(hash.digest());
      BLOB_DIGESTS.set(blob, digest);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return digest;
}

export async function candidateIdentity(source: Blob, startMs: number, endMs: number, signal: AbortSignal) {
  const digest = await blobDigest(source, signal);
  return bytesToHex(sha256(utf8ToBytes(`short-v1:${digest}:${startMs}:${endMs}`)));
}

export async function versionIdentity(clip: DriveShort, signal: AbortSignal) {
  const digest = await blobDigest(clip.blob, signal);
  const content = JSON.stringify(["short-version-v1", digest, clip.blob.type, clip.title, clip.description, clip.hashtags]);
  return bytesToHex(sha256(utf8ToBytes(content)));
}

export class DriveSaveError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message ?? (status === 401 ? "Google認証の有効期限が切れました。再接続して再試行してください。"
      : status === 403 ? "保存先への書き込み権限・Google CloudのAPI設定・利用枠を確認してください。"
      : status === 429 ? "Google Driveの利用枠に達しました。時間をおいて再試行してください。"
      : status === 0 ? "通信が中断されました。再試行できます。"
      : `Google Driveとの通信に失敗しました（HTTP ${status}）。`));
  }
}

async function driveFetch(path: string, token: string, signal?: AbortSignal) {
  return fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal, cache: "no-store" });
}

export async function verifyCandidateFolder(token: string, signal?: AbortSignal) {
  const url = new URL(`${DRIVE}/files/${CANDIDATE_FOLDER_ID}`);
  url.search = new URLSearchParams({ fields: "id,mimeType,trashed,capabilities(canAddChildren)", supportsAllDrives: "true" }).toString();
  const res = await driveFetch(url.toString(), token, signal);
  if (res.status === 404) return false; // Folder not granted to this drive.file app yet.
  if (!res.ok) throw new DriveSaveError(res.status);
  const folder: DriveFile = await res.json();
  if (folder.id !== CANDIDATE_FOLDER_ID || folder.mimeType !== "application/vnd.google-apps.folder" ||
      folder.trashed || !folder.capabilities?.canAddChildren) {
    throw new DriveSaveError(403, "指定フォルダに保存できるGoogleアカウントで接続してください。");
  }
  return true;
}

async function openReservations(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("studio-drive-ids", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("ids");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("重複防止用の端末保存を利用できません。"));
  });
}

/** Atomic per origin: tabs reserve the same IDs before any write to Drive. */
async function reserveIds(key: string, proposed: ReservedIds): Promise<ReservedIds> {
  const db = await openReservations();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("ids", "readwrite");
      const store = tx.objectStore("ids");
      const lookup = store.get(key);
      let ids: ReservedIds;
      lookup.onsuccess = () => {
        ids = (lookup.result as ReservedIds | undefined) ?? proposed;
        if (!lookup.result) store.put(ids, key);
      };
      tx.oncomplete = () => resolve(ids);
      tx.onabort = () => reject(new Error("重複防止用の保存に失敗しました。"));
    });
  } finally { db.close(); }
}

async function listSaved(token: string, id: string, signal: AbortSignal) {
  const entries = new Map<string, Partial<Record<Role, DriveFile>>>();
  const url = new URL(`${DRIVE}/files`);
  url.search = new URLSearchParams({
    q: `'${CANDIDATE_FOLDER_ID}' in parents and trashed = false and appProperties has { key='candidateId' and value='${id}' }`,
    fields: "nextPageToken,files(id,name,mimeType,appProperties,createdTime)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    pageSize: "100",
  }).toString();
  do {
    const res = await driveFetch(url.toString(), token, signal);
    if (!res.ok) throw new DriveSaveError(res.status);
    const { files, nextPageToken }: { files: DriveFile[]; nextPageToken?: string } = await res.json();
    for (const f of files) {
      if (f.appProperties?.candidateId !== id) continue;
      const role = f.appProperties?.studioRole;
      if (role !== "video" && role !== "manifest") continue;
      const version = f.appProperties?.versionId;
      // Legacy files have no verifiable content identity. Leave them in Drive.
      if (!version) continue;
      const pair = entries.get(version) ?? {};
      if (pair[role] && pair[role]?.id !== f.id) {
        throw new Error("Driveに同じ候補・版IDのファイルが複数あります。管理担当者に確認してください。");
      }
      pair[role] = f;
      entries.set(version, pair);
    }
    if (!nextPageToken) break;
    url.searchParams.set("pageToken", nextPageToken);
  } while (true);
  return entries;
}

function latestVersion(versions: Awaited<ReturnType<typeof listSaved>>, fallback: string) {
  let latestTime = -Infinity;
  let latest = fallback;
  for (const [version, pair] of versions) {
    if (!pair.video || !pair.manifest) continue;
    const time = Date.parse(pair.manifest.createdTime ?? "");
    if (time > latestTime || (time === latestTime && version > latest)) {
      latestTime = time;
      latest = version;
    }
  }
  return latest;
}

async function readReservation(key: string): Promise<ReservedIds | undefined> {
  const db = await openReservations();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction("ids").objectStore("ids").get(key);
      req.onsuccess = () => resolve(req.result as ReservedIds | undefined);
      req.onerror = () => reject(new Error("重複防止用の保存を確認できません。"));
    });
  } finally { db.close(); }
}

async function newIds(token: string, signal: AbortSignal): Promise<ReservedIds> {
  const res = await driveFetch(`${DRIVE}/files/generateIds?count=2&space=drive&type=files`, token, signal);
  if (!res.ok) throw new DriveSaveError(res.status);
  const { ids } = await res.json() as { ids?: string[] };
  if (!ids?.[0] || !ids[1] || ids[0] === ids[1]) throw new Error("Driveの予約IDを取得できませんでした。");
  return { video: ids[0], manifest: ids[1] };
}

function putUpload(url: string, token: string, body: Blob, signal: AbortSignal, progress: (fraction: number) => void) {
  return new Promise<number>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", body.type);
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded / event.total); };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new DriveSaveError(0));
    xhr.onabort = () => reject(new DOMException("中断しました", "AbortError"));
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}

type VersionKey = { candidateId: string; versionId: string };

async function verifyUploaded(token: string, id: string, key: VersionKey, role: Role, signal: AbortSignal) {
  const res = await driveFetch(`${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${FIELDS}`, token, signal);
  if (!res.ok) throw new DriveSaveError(res.status);
  const file: DriveFile = await res.json();
  if (file.id !== id || file.trashed || !file.parents?.includes(CANDIDATE_FOLDER_ID) ||
      file.appProperties?.candidateId !== key.candidateId || file.appProperties?.versionId !== key.versionId ||
      file.appProperties?.studioRole !== role) {
    throw new Error("保存ファイルと候補の対応を確認できません。Driveの投稿候補フォルダを確認してください。");
  }
  return file;
}

async function upload(token: string, id: string, key: VersionKey, role: Role, name: string, body: Blob,
  signal: AbortSignal, progress: (fraction: number) => void) {
  const res = await fetch(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Upload-Content-Type": body.type, "X-Upload-Content-Length": String(body.size) },
    body: JSON.stringify({
      id, name, mimeType: body.type, parents: [CANDIDATE_FOLDER_ID],
      appProperties: { ...key, studioRole: role },
    }),
    signal,
  });
  if (res.status !== 409) {
    if (!res.ok) throw new DriveSaveError(res.status);
    const location = res.headers.get("Location");
    if (!location) throw new Error("Driveからアップロード先が返りませんでした。");
    const url = new URL(location);
    if (url.protocol !== "https:" || !["www.googleapis.com", "upload.googleapis.com"].includes(url.hostname) ||
        url.port || url.username || url.password || url.pathname !== "/upload/drive/v3/files") {
      throw new Error("Driveのアップロード先を確認できませんでした。");
    }
    const status = await putUpload(url.toString(), token, body, signal, progress);
    if (![200, 201, 409].includes(status)) throw new DriveSaveError(status);
  }
  return verifyUploaded(token, id, key, role, signal);
}

export async function saveShortToDrive(options: {
  token: string; project: string; source: Blob; clip: DriveShort; signal: AbortSignal;
  onProgress: (stage: string, fraction: number) => void;
}): Promise<SavedShort> {
  const { token, project, source, clip, signal, onProgress } = options;
  onProgress("候補と版を確認中", 0);
  const candidateId = await candidateIdentity(source, clip.startMs, clip.endMs, signal);
  const versionId = await versionIdentity(clip, signal);
  const key = { candidateId, versionId };
  const save = async () => {
    onProgress("保存済みか確認中", 0.03);
    const versions = await listSaved(token, candidateId, signal);
    const found = versions.get(versionId) ?? {};
    if (found.video && found.manifest) {
      onProgress("保存済み", 1);
      return { ...key, latestVersionId: latestVersion(versions, versionId), videoId: found.video.id, manifestId: found.manifest.id, reused: true };
    }
    if (found.manifest && !found.video) throw new Error("投稿情報だけが残っています。Driveで元動画の状態を確認してください。");
    const reservationKey = JSON.stringify([project, CANDIDATE_FOLDER_ID, candidateId, versionId]);
    let ids = await readReservation(reservationKey);
    if (!ids) {
      const proposed = await newIds(token, signal);
      ids = await reserveIds(reservationKey, {
        video: found.video?.id ?? proposed.video, manifest: found.manifest?.id ?? proposed.manifest,
      });
    }
    const videoId = found.video?.id ?? ids.video;
    const manifestId = found.manifest?.id ?? ids.manifest;
    const title = clip.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 50) || "short";
    const filename = `${candidateId.slice(0, 12)}-${versionId.slice(0, 12)}-${title}`;
    const ext = clip.blob.type === "video/mp4" ? "mp4" : "webm";
    let videoFile = found.video;
    if (!videoFile) {
      onProgress("動画を保存中", 0.05);
      videoFile = await upload(token, videoId, key, "video", `${filename}.${ext}`, clip.blob, signal,
        progress => onProgress("動画を保存中", 0.05 + 0.85 * progress));
    }
    onProgress("投稿情報を保存中", 0.93);
    const manifest = {
      schemaVersion: 2, ...key, status: "pending_owner_approval",
      title: clip.title, description: clip.description, hashtags: clip.hashtags,
      video: { driveFileId: videoId, filename: videoFile.name ?? `${filename}.${ext}`, mimeType: videoFile.mimeType ?? clip.blob.type },
      range: { startMs: clip.startMs, endMs: clip.endMs },
    };
    const manifestFile = await upload(token, manifestId, key, "manifest", `${filename}.json`, new Blob(
      [JSON.stringify(manifest, null, 2)], { type: "application/json" },
    ), signal, () => {});
    versions.set(versionId, { video: videoFile, manifest: manifestFile });
    onProgress("保存完了", 1);
    return { ...key, latestVersionId: latestVersion(versions, versionId), videoId, manifestId, reused: false };
  };
  // IDB reserves the same IDs even without Web Locks (e.g. older iOS).
  return navigator.locks
    ? navigator.locks.request(`studio-drive:${candidateId}`, { signal }, save)
    : save();
}
