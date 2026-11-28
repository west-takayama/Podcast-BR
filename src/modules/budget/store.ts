import { beginRequest, emptyBudget, finishRequest, type BudgetState, type LedgerEntry, type RequestInfo, type RequestResult } from "./ledger";
import { japanMonth, scale, type UsageCounts } from "./pricing";

const storageName = "podcast-br-budget-v1";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function budgetChannel() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(storageName);
    channel.onmessage = () => listeners.forEach(listener => listener());
  }
  return channel;
}

export function subscribeBudget(listener: () => void) {
  budgetChannel();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function access<T>(mode: IDBTransactionMode, operation: (state: BudgetState) => T): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(storageName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("budget");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("budget", mode);
    const store = transaction.objectStore("budget");
    const request = store.get("state");
    let result: T;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const state: BudgetState = request.result ?? emptyBudget();
        result = operation(state);
        if (mode === "readwrite") store.put(state, "state");
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.onabort = () => { db.close(); reject(failure ?? transaction.error ?? new Error("予算台帳を更新できませんでした。")); };
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
      if (mode === "readwrite") {
        listeners.forEach(listener => listener());
        budgetChannel()?.postMessage("change");
      }
    };
  });
}

export const readBudget = () => access("readonly", state => state);
export const updateBudget = (change: (state: BudgetState) => void) => access("readwrite", change);

export const reserveRequest = (info: RequestInfo) =>
  access("readwrite", state => beginRequest(state, info, crypto.randomUUID(), Date.now()));

export const settleRequest = (id: string, counts: UsageCounts, result: RequestResult) =>
  updateBudget(state => {
    const entry = state.entries.find(item => item.id === id && item.state === "pending");
    if (entry) finishRequest(entry, counts, result);
  });

export const dropUnsentRequest = (id: string) =>
  updateBudget(state => { state.entries = state.entries.filter(entry => entry.id !== id); });

export function cacheRequest(purpose: string, episodeId?: string) {
  return updateBudget(state => {
    const at = Date.now();
    state.entries.push({ id: crypto.randomUUID(), mode: state.settings.mode, at, month: japanMonth(at),
      purpose, episodeId, attempt: 0, state: "cache", reserved: 0, estimate: 0, elapsedMs: 0, success: true });
  });
}

export function recordActual(state: BudgetState, month: string, yen: number, through: number, now = Date.now()) {
  state.actual[month] = { amount: Math.round(yen * scale), through, at: now };
  // The operator has checked the provider statement through this point. Keep the event and the uncertainty.
  for (const entry of state.entries) {
    if (entry.month === month && entry.state === "pending" && entry.at <= through && now - entry.at >= 10 * 60_000) {
      entry.state = "unknown";
      entry.error = "Interrupted";
      delete entry.requestKey;
    }
  }
}

export type { LedgerEntry };

export const markValidationFailure = (id: string) => updateBudget(state => {
  const entry = state.entries.find(item => item.id === id);
  if (entry?.success) {
    entry.success = false;
    entry.error = "ValidationError";
  }
});
