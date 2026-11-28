import { getEpisode, loadArtwork } from "../../../lib/history";
import { readProductionCheckpoint, type ProductionSession } from "../../../core/productionSession";
import type { PodcastEntry } from "./model";

export async function podcastTransaction<T>(write: boolean, action: (rows: PodcastEntry[]) => T): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("podcast-br-spotify", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("packages");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("packages", write ? "readwrite" : "readonly");
      const store = tx.objectStore("packages");
      const request = store.get("episodes");
      let value: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const rows: PodcastEntry[] = request.result ?? [];
          value = action(rows);
          if (write) store.put(rows, "episodes");
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("配信台帳を保存できません。"));
      tx.oncomplete = () => resolve(value);
    });
  } finally { db.close(); }
}

export async function existingCopy(session: ProductionSession) {
  const history = await getEpisode(session.id);
  if (history) return { title: history.chosenTitle || history.meta.titles[0] || "", description: history.meta.description };
  if (!session.original) return;
  const checkpoint = await readProductionCheckpoint(session.id, session.original.id);
  const copy = checkpoint?.analysis?.copy;
  if (copy) return { title: copy.titles[0] || "", description: copy.description };
}

export const existingCover = loadArtwork;
