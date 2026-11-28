import { emptyPublisher, type PublisherState } from "./model";

export async function publisherTransaction<T>(write: boolean, action: (state: PublisherState) => T): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("podcast-br-publisher", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("studio");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("studio", write ? "readwrite" : "readonly");
      const store = transaction.objectStore("studio");
      const request = store.get("state");
      let value: T;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const state: PublisherState = request.result ?? emptyPublisher();
          value = action(state);
          if (write) store.put(state, "state");
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("投稿台帳を保存できません。"));
    });
  } finally { database.close(); }
}
