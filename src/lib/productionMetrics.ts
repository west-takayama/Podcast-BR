export type ProductionStage = "conversion" | "video-export" | "podcast-prep";
export type ProductionMetric = { stage: ProductionStage; at: number; ms: number; success: boolean };

async function openMetrics() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("podcast-br-production-metrics", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("timings", { autoIncrement: true }).createIndex("at", "at");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export function captureProduction(stage: string, ms: number, success: boolean) {
  if (typeof indexedDB === "undefined" || !Number.isFinite(ms) ||
    (stage !== "conversion" && stage !== "video-export" && stage !== "podcast-prep")) return;
  const metric: ProductionMetric = { stage, at: Date.now(), ms: Math.round(ms), success };
  void openMetrics().then(db => {
    try {
      const tx = db.transaction("timings", "readwrite");
      tx.objectStore("timings").add(metric);
    } finally { db.close(); }
  }).catch(() => {});
}

export async function readProductionMetrics(since: number) {
  const db = await openMetrics();
  try {
    return await new Promise<ProductionMetric[]>((resolve, reject) => {
      const req = db.transaction("timings").objectStore("timings").index("at").getAll(IDBKeyRange.lowerBound(since));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
