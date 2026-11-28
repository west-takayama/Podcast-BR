import { getEpisode, readProductionEntry, writeProductionEntry, writeProductionSource } from "../lib/history";
import type { EpisodeAnalysis } from "../modules/editorial/analysis";
import type { ShortsCheckpoint } from "../modules/shorts/checkpoint";
import { createProductionAsset, type ProductionAsset } from "./productionAsset";

export type ProductionSession = {
  id: string;
  original?: ProductionAsset;
  edited?: ProductionAsset;
};

export type ProductionCheckpoint = {
  revision: string;
  analysis?: EpisodeAnalysis;
  shorts?: ShortsCheckpoint;
};

export const originalKey = (id: string) => `production:${id}:original`;
export const editedKey = (id: string) => `production:${id}:edited`;
const activeKey = "production:current";
const checkpointKey = (id: string) => `production:${id}:checkpoint`;

type AssetReference = Omit<ProductionAsset, "file"> & Pick<File, "name" | "type" | "lastModified">;
type SessionReference = { id: string; original?: AssetReference; edited?: AssetReference };

function reference({ file, ...asset }: ProductionAsset): AssetReference {
  return { ...asset, name: file.name, type: file.type, lastModified: file.lastModified };
}

export function selectOriginal(current: ProductionSession | undefined, file: File): ProductionSession {
  if (current?.original?.file === file) return current;
  return { id: current && !current.original ? current.id : crypto.randomUUID(), original: createProductionAsset(file),
    edited: current?.original ? undefined : current?.edited };
}

export async function saveProductionSource(session: ProductionSession, role: "original" | "edited") {
  const asset = session[role];
  if (!asset) return;
  const key = role === "original" ? originalKey(session.id) : editedKey(session.id);
  await writeProductionSource(key, asset.file, activeKey, {
    id: session.id,
    original: session.original && reference(session.original),
    edited: session.edited && reference(session.edited),
  } satisfies SessionReference);
}

export async function restoreProductionSession(): Promise<ProductionSession | undefined> {
  const stored = await readProductionEntry<SessionReference>(activeKey);
  if (!stored) return;
  const id = stored.id;
  async function load(ref: AssetReference | undefined, key: string, history = false) {
    if (!ref) return;
    const data = await readProductionEntry<Blob>(key)
      ?? (history ? (await getEpisode(id))?.audio : undefined);
    if (!data) return;
    const { name, type, lastModified, ...asset } = ref;
    return { ...asset, file: data instanceof File ? data : new File([data], name, { type, lastModified }) };
  }
  const [original, edited] = await Promise.all([
    load(stored.original, originalKey(stored.id), true),
    load(stored.edited, editedKey(stored.id)),
  ]);
  // If history no longer holds the original, its saved offsets cannot be used with a replacement.
  return { id: stored.original && !original ? crypto.randomUUID() : stored.id, original, edited };
}

export const saveProductionCheckpoint = (id: string, checkpoint: ProductionCheckpoint) =>
  writeProductionEntry(checkpointKey(id), checkpoint);

export async function readProductionCheckpoint(id: string, revision?: string) {
  const checkpoint = await readProductionEntry<ProductionCheckpoint>(checkpointKey(id));
  return revision === undefined || checkpoint?.revision === revision ? checkpoint : undefined;
}
