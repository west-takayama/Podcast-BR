// エピソード履歴の保存(IndexedDB)。
// localStorage ではなく IndexedDB を使うのは、MP3 の Blob をそのまま保持したいため。
// 保存はすべて端末内で完結し、外部には送信されない。

import type { EpisodeMeta, TranscriptSegment, UploadedAudio } from "./gemini";

const DB_NAME = "podcast-br";
const DB_VERSION = 1;
const STORE = "episodes";
/** 端末のストレージを圧迫しないよう、音声を保持する件数を絞る。 */
const MAX_AUDIO_RETAINED = 5;

export interface EpisodeRecord {
  id: string;
  createdAt: number;
  fileName: string;
  durationSec: number;
  removedSec: number;
  meta: EpisodeMeta;
  chosenTitle: string;
  audio?: Blob; // 古い履歴では削除されている場合がある
  /** 全文書き起こし。作った回だけ入る。 */
  transcript?: TranscriptSegment[];
  /** アップロード済み音声の参照。48時間以内なら文章だけ作り直せる。 */
  uploaded?: UploadedAudio;
  /** 端末側で検出した話の切り替わり候補(秒)。作り直しでも使う。 */
  pauses?: number[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("履歴データベースを開けませんでした"));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const req = fn(transaction.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("履歴の操作に失敗しました"));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function listEpisodes(): Promise<EpisodeRecord[]> {
  const all = await tx<EpisodeRecord[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveEpisode(record: EpisodeRecord): Promise<void> {
  await tx("readwrite", (s) => s.put(record));
  await pruneAudio();
}

export async function updateEpisode(
  id: string,
  patch: Partial<EpisodeRecord>,
): Promise<void> {
  const existing = await tx<EpisodeRecord | undefined>("readonly", (s) => s.get(id));
  if (!existing) return;
  await tx("readwrite", (s) => s.put({ ...existing, ...patch, id }));
}

export async function deleteEpisode(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** 新しい順に MAX_AUDIO_RETAINED 件だけ音声を残し、それ以前は本文だけ残す。 */
async function pruneAudio(): Promise<void> {
  const all = await listEpisodes();
  const stale = all.slice(MAX_AUDIO_RETAINED).filter((r) => r.audio);
  for (const record of stale) {
    const { audio: _audio, ...rest } = record;
    await tx("readwrite", (s) => s.put(rest as EpisodeRecord));
  }
}

/** 履歴をすべて消す。 */
export async function deleteAllEpisodes(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
}

/** 本文は残したまま音声だけ消す。端末の空き容量を取り戻すため。 */
export async function dropAllAudio(): Promise<void> {
  const all = await listEpisodes();
  for (const record of all) {
    if (!record.audio) continue;
    const { audio: _audio, ...rest } = record;
    await tx("readwrite", (s) => s.put(rest as EpisodeRecord));
  }
}

export function totalAudioBytes(records: EpisodeRecord[]): number {
  return records.reduce((n, r) => n + (r.audio?.size ?? 0), 0);
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${String(s).padStart(2, "0")}秒`;
}
