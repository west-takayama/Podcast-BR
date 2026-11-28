// エピソード履歴の保存(IndexedDB)。
// localStorage ではなく IndexedDB を使うのは、MP3 の Blob をそのまま保持したいため。
// 保存はすべて端末内で完結し、外部には送信されない。

import type { EpisodeMeta, TranscriptSegment, UploadedAudio } from "./gemini";
import type { AudioReport } from "./audio/report";

const DB_NAME = "podcast-br";
const DB_VERSION = 3;
const STORE = "episodes";
/** 変換は済んだが文章が未完成の1件を置く場所。中断からの復帰に使う。 */
const PENDING_STORE = "pending";
const PENDING_KEY = "current";
/**
 * 読み込んだ写真を置く場所。
 * MP3のカバーと縦型ショートの背景で共有する素材なので、
 * タブを切り替えたり開き直したりしても残るようにする。
 */
const ASSET_STORE = "assets";
const ARTWORK_KEY = "artwork";
/** 端末のストレージを圧迫しないよう、音声を保持する件数を絞る。 */
const MAX_AUDIO_RETAINED = 5;

export interface EpisodeRecord {
  id: string;
  createdAt: number;
  /**
   * 最後に手を入れた時刻。
   *
   * 控えを戻すときに「どちらが新しいか」を決めるのに要る。
   * createdAt は作った瞬間の値で**あとから変わらない**ので、同じ回どうしを
   * 比べても必ず引き分けになり、判定として働かなかった。
   * 古い控えを読ませると、直したタイトルが黙って元に戻っていた。
   */
  updatedAt?: number;
  fileName: string;
  durationSec: number;
  removedSec: number;
  meta: EpisodeMeta;
  chosenTitle: string;
  originalAudio?: boolean;
  sourceRevision?: string;
  transcriptRevision?: string;
  audio?: Blob; // 古い履歴では削除されている場合がある
  /** 全文書き起こし。作った回だけ入る。 */
  transcript?: TranscriptSegment[];
  /** アップロード済み音声の参照。48時間以内なら文章だけ作り直せる。 */
  uploaded?: UploadedAudio;
  /** 端末側で検出した話の切り替わり候補(秒)。作り直しでも使う。 */
  pauses?: number[];
  /** 今回の出演者。説明文の頭に出すために回ごとに持つ。 */
  cast?: string;
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
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE, { keyPath: "id" });
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
        transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("履歴の操作を中断しました")); };
        req.onerror = () => reject(req.error ?? new Error("履歴の操作に失敗しました"));
        transaction.oncomplete = () => { db.close(); resolve(req.result); };
      }),
  );
}

export async function listEpisodes(): Promise<EpisodeRecord[]> {
  const all = await tx<EpisodeRecord[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function episodeIndex(): Promise<Pick<EpisodeRecord, "id" | "createdAt">[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const rows: Pick<EpisodeRecord, "id" | "createdAt">[] = [];
      const query = transaction.objectStore(STORE).openCursor();
      query.onsuccess = () => {
        const cursor = query.result;
        if (!cursor) return;
        const { id, createdAt } = cursor.value as EpisodeRecord;
        rows.push({ id, createdAt });
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(rows);
      transaction.onabort = () => reject(transaction.error ?? new Error("制作履歴を開けません。"));
    });
  } finally { db.close(); }
}

export const getEpisode = (id: string) => tx<EpisodeRecord | undefined>("readonly", (store) => store.get(id));

export async function readProductionEntry<T>(id: string): Promise<T | undefined> {
  const row = await tx<{ value: T } | undefined>("readonly", (store) => store.get(id), ASSET_STORE);
  return row?.value;
}

export const writeProductionEntry = (id: string, value: unknown) =>
  tx("readwrite", (store) => store.put({ id, value }), ASSET_STORE);

async function writeStores(names: string | string[], write: (transaction: IDBTransaction) => void) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(names, "readwrite");
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("端末に保存できませんでした")); };
    write(transaction);
  });
}

export function writeProductionSource(id: string, file: File, activeKey: string, active: unknown) {
  return writeStores(ASSET_STORE, transaction => {
    const store = transaction.objectStore(ASSET_STORE);
    store.put({ id, value: file });
    store.put({ id: activeKey, value: active });
  });
}

export async function saveEpisode(record: EpisodeRecord, stagedAudioKey?: string): Promise<void> {
  const row = { updatedAt: Date.now(), ...record };
  if (stagedAudioKey) {
    await writeStores([STORE, ASSET_STORE], transaction => {
      transaction.objectStore(STORE).put(row);
      transaction.objectStore(ASSET_STORE).delete(stagedAudioKey);
    });
  } else {
    await tx("readwrite", (store) => store.put(row));
  }
  await pruneAudio();
}

// A revision event carries only the local episode ID. It invalidates open editors in other tabs.
const revisionListeners = new Set<(id: string) => void>();
let revisionChannel: BroadcastChannel | undefined;

function getRevisionChannel() {
  if (!revisionChannel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    revisionChannel = new BroadcastChannel("podcast-br-episode-revision");
    revisionChannel.onmessage = ({ data }) => {
      if (typeof data === "string") revisionListeners.forEach(listener => listener(data));
    };
  }
  return revisionChannel;
}

export function subscribeEpisodeRevisions(listener: (id: string) => void) {
  getRevisionChannel();
  revisionListeners.add(listener);
  return () => { revisionListeners.delete(listener); };
}

export async function updateEpisode(
  id: string,
  patch: Partial<EpisodeRecord> | ((existing: EpisodeRecord) => Partial<EpisodeRecord>),
  preserveSource = false,
): Promise<void> {
  let revisionChanged = false;
  await writeStores(STORE, transaction => {
    const store = transaction.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const existing = request.result as EpisodeRecord | undefined;
      if (!existing) return;
      const changes = typeof patch === "function" ? patch(existing) : patch;
      const updatedAt = "updatedAt" in changes ? changes.updatedAt : Date.now();
      const next = { ...existing, ...changes, id, updatedAt };
      if ("transcript" in changes) next.transcriptRevision = crypto.randomUUID();
      if ("audio" in changes && !preserveSource) {
        next.sourceRevision = crypto.randomUUID();
        if (!("transcript" in changes)) {
          delete next.transcript;
          delete next.transcriptRevision;
        }
      }
      revisionChanged = "transcript" in changes || ("audio" in changes && !preserveSource);
      store.put(next);
    };
  });
  if (revisionChanged) {
    revisionListeners.forEach(listener => listener(id));
    getRevisionChannel()?.postMessage(id);
  }
}

export async function deleteEpisode(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** 新しい順に MAX_AUDIO_RETAINED 件だけ音声を残し、それ以前は本文だけ残す。 */
async function pruneAudio(): Promise<void> {
  const all = await listEpisodes();
  const stale = all.slice(MAX_AUDIO_RETAINED).filter((r) => r.audio);
  for (const record of stale) {
    await updateEpisode(record.id, current => ({ audio: undefined, updatedAt: current.updatedAt }), true);
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
    await updateEpisode(record.id, current => ({ audio: undefined, updatedAt: current.updatedAt }), true);
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
  episodeId?: string;
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
  originalAudio?: boolean;
  report: AudioReport | null;
  /** アップロードまで済んでいれば、復帰後の送信も省ける。 */
  uploaded?: UploadedAudio;
  /** 変換前に打ち込んだ出演者。開き直しても消えないように控える。 */
  cast?: string;
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

/**
 * 読み込んだ写真。文字が描かれているかどうかも一緒に覚えておく。
 * これを覚えておかないと、開き直すたびに「そのまま使う」に戻ってしまう。
 */
export interface StoredArtwork {
  blob: Blob;
  /** 画像に文字まで描かれていて、こちらで重ねると二重になる状態か。 */
  asIs: boolean;
  savedAt: number;
}

export async function saveArtwork(blob: Blob, asIs: boolean): Promise<void> {
  await tx(
    "readwrite",
    (s) => s.put({ id: ARTWORK_KEY, blob, asIs, savedAt: Date.now() }),
    ASSET_STORE,
  );
}

export async function patchArtwork(patch: Partial<Pick<StoredArtwork, "asIs">>): Promise<void> {
  const existing = await loadArtwork();
  if (!existing) return;
  await tx(
    "readwrite",
    (s) => s.put({ ...existing, ...patch, id: ARTWORK_KEY }),
    ASSET_STORE,
  );
}

export async function loadArtwork(): Promise<StoredArtwork | null> {
  const found = await tx<StoredArtwork | undefined>(
    "readonly",
    (s) => s.get(ARTWORK_KEY),
    ASSET_STORE,
  );
  return found ?? null;
}

export async function clearArtwork(): Promise<void> {
  await tx("readwrite", (s) => s.delete(ARTWORK_KEY), ASSET_STORE);
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
