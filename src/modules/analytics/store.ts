import { merge, type Row } from "./model";

async function data<T>(write: boolean, action: (rows: Row[]) => { value: T; rows?: Row[] }): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("podcast-br-analytics", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("imports");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("imports", write ? "readwrite" : "readonly");
      const store = tx.objectStore("imports");
      const request = store.get("rows");
      let value: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const next = action(request.result ?? []);
          value = next.value;
          if (next.rows) store.put(next.rows, "rows");
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("指標台帳を開けません。"));
    });
  } finally { db.close(); }
}

export const readAnalytics = () => data(false, rows => ({ value: rows }));
export const importAnalytics = (incoming: Row[]) => data(true, rows => {
  const result = merge(rows, incoming);
  return { value: result, rows: result.rows };
});
