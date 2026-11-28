import type { Feature } from "./feature";
import { newFeature } from "./feature";

export async function featureTransaction<T>(write: boolean, run: (rows: Record<string, Feature>) => T): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("podcast-br-video-features", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("features");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("features", write ? "readwrite" : "readonly");
      const store = tx.objectStore("features");
      const request = store.get("episodes");
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const rows: Record<string, Feature> = Object.assign(Object.create(null), request.result);
          result = run(rows);
          if (write) store.put(rows, "episodes");
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("動画制作台帳を開けません。"));
    });
  } finally { db.close(); }
}

export const getFeature = (id: string) => featureTransaction(false, rows => rows[id]);
export async function updateFeature(id: string, action: (row: Feature, all: Record<string, Feature>) => Feature) {
  const row = await featureTransaction(true, rows => rows[id] = action(rows[id] ?? newFeature(id), rows));
  window.dispatchEvent(new CustomEvent("studio-video-feature", { detail: id }));
  return row;
}
