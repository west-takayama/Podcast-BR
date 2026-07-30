// エピソード履歴の保存(IndexedDB)。
// localStorage ではなく IndexedDB を使うのは、MP3 の Blob をそのまま保持したいため。
// 保存はすべて端末内で完結し、外部には送信されない。

import type { EpisodeMeta, TranscriptSegment, UploadedAudio } from "./gemini";
import type { AudioReport } from "./audio/report";

const DB_NAME = "podcast-br";
const DB_VERSION = 2;
const STORE = "episodes";
/** 変換は済んだが文章が未完成の1件を置く場所。中断からの復帰に使う。 */
const PENDING_STORE = "pending";
const PENDING_KEY = "current";
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
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("履歴データベースを開けませんでした"));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const req = fn(transaction.objectStore(storeName));
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

/**
 * 変換は終わったが文章がまだ無い1件。
 *
 * 60分の回では変換だけで数分かかる。生成の途中でアプリが落ちたり、
 * 画面を切り替えてブラウザに止められたりすると、それまでの変換が消えていた。
 * ここに置いておけば、開き直したときに変換をやり直さずに続けられる。
 *
 * 音声は ArrayBuffer ではなく Blob で持つ。IndexedDB はどちらも保存できるが、
 * Blob なら実体をディスクに持てるうえ、そのまま再生や添付に使える。
 */
export interface PendingConversion {
  id: typeof PENDING_KEY;
  createdAt: number;
  fileName: string;
  /** 書き出すファイル名。復帰後のダウンロードで使う。 */
  outputName: string;
  /** 「◯◯.wav(120 MB)」の表示。 */
  fileInfo: string;
  durationSec: number;
  removedSec: number;
  pauses: number[];
  /** 配信用の MP3(タグはまだ付いていない)。 */
  mp3: Blob;
  /** AI 送信用の 32kbps モノラル。 */
  aiMp3: Blob;
  report: AudioReport;
  /** アップロードまで済んでいれば、復帰後の送信も省ける。 */
  uploaded?: UploadedAudio;
}

/** 保持するのは常に1件。新しい変換を始めたら前のものは用済みになる。 */
export async function savePending(record: Omit<PendingConversion, "id">): Promise<void> {
  await tx("readwrite", (s) => s.put({ ...record, id: PENDING_KEY }), PENDING_STORE);
}

export async function patchPending(patch: Partial<PendingConversion>): Promise<void> {
  const existing = await loadPending();
  if (!existing) return;
  await tx("readwrite", (s) => s.put({ ...existing, ...patch, id: PENDING_KEY }), PENDING_STORE);
}

export async function loadPending(): Promise<PendingConversion | null> {
  const found = await tx<PendingConversion | undefined>(
    "readonly",
    (s) => s.get(PENDING_KEY),
    PENDING_STORE,
  );
  return found ?? null;
}

export async function clearPending(): Promise<void> {
  await tx("readwrite", (s) => s.delete(PENDING_KEY), PENDING_STORE);
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
