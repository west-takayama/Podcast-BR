import { beginHandoff, reconcile, type Delivery, type Destination } from "./model";
import { publisherTransaction } from "./store";

/** Provider boundary for acceptance fixtures. A live implementation requires an approved authenticated transport. */
export interface PublisherProvider {
  reserve(item: Delivery): Promise<string>;
  inspect(item: Delivery): Promise<{ state: "scheduled" | "published" | "cancelled" | "failed" | "unknown"; evidence: string }>;
  cancel(item: Delivery): Promise<void>;
}

export async function dispatch(provider: PublisherProvider, key: string, network: Destination, digest: string) {
  const { item, index } = await publisherTransaction(true, state => ({
    item: beginHandoff(state, key, network, digest, Date.now()), index: state.deliveries.length - 1,
  }));
  try {
    const id = await provider.reserve(item);
    await publisherTransaction(true, state => reconcile(state, index, "scheduled", id, Date.now()));
  } catch {
    // Treat an ambiguous response as a possible successful reservation.
    await publisherTransaction(true, state => reconcile(state, index, "unknown", "", Date.now()));
  }
  return index;
}

export async function inspectDelivery(provider: PublisherProvider, index: number, cancel = false) {
  const item = await publisherTransaction(false, state => state.deliveries[index]);
  if (!item || !["sending", "unknown", "scheduled"].includes(item.state)) throw new Error("照合対象を選んでください。");
  if (cancel && item.state !== "scheduled") throw new Error("外部で確認できた予約だけを取消できます。");
  let result: Awaited<ReturnType<PublisherProvider["inspect"]>>;
  try {
    if (cancel) await provider.cancel(item);
    result = await provider.inspect(item);
  } catch { result = { state: "unknown", evidence: "" }; }
  await publisherTransaction(true, state => {
    if (JSON.stringify(state.deliveries[index]) !== JSON.stringify(item)) throw new Error("投稿状態が変わりました。再照合してください。");
    reconcile(state, index, result.state, result.evidence, Date.now());
  });
}
