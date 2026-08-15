// 履歴の書き出しと読み込み。
//
// この道具は端末の中だけで完結する。サーバーが無いのは良いことだが、
// **逃げ場も無い**。端末を買い替えたら、閲覧履歴を消したら、
// 積み上げた回の記録(採用したタイトル・書き起こし・話題)が丸ごと消える。
// 収録し直せない類いのものなので、持ち出せるようにしておく。
//
// 音声は入れない。5回ぶんで数百MBになり、メールにも Drive にも載らない。
// そして音声は元ファイルから作り直せる。**作り直せないのは文章のほう。**

import type { EpisodeRecord } from "./history";
import { listEpisodes, saveEpisode } from "./history";

const FORMAT = "podcast-br-backup";
const VERSION = 1;

/** 書き出す1件。音声(Blob)は持たない。 */
export type BackupEpisode = Omit<EpisodeRecord, "audio">;

export interface Backup {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  episodes: BackupEpisode[];
}

/** いまの履歴を、持ち出せる形にする。 */
export async function buildBackup(records?: EpisodeRecord[]): Promise<Backup> {
  const all = records ?? (await listEpisodes());
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    episodes: all.map(({ audio: _audio, ...rest }) => rest),
  };
}

/** 書き出すファイルの名前。日付を入れて、複数世代を並べても分かるようにする。 */
export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `podcast-br-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.json`;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * 読み込んだ中身を確かめる。
 *
 * 他所の JSON を投げ込まれても壊れないようにする。ここで弾いておかないと、
 * 履歴が虫食いのまま残って、何が起きたのか分からなくなる。
 */
export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("読み取れないファイルです(JSON ではありません)");
  }
  const b = data as Partial<Backup>;
  if (b?.format !== FORMAT) {
    throw new Error("このアプリの控えではないようです");
  }
  if (typeof b.version !== "number" || b.version > VERSION) {
    throw new Error(
      `新しい版で作られた控えです(v${b.version})。アプリを更新してからお試しください。`,
    );
  }
  if (!Array.isArray(b.episodes)) {
    throw new Error("中身が壊れています(回の一覧がありません)");
  }
  const episodes = b.episodes.filter(
    (r): r is BackupEpisode =>
      !!r && typeof r.id === "string" && !!r.meta && Array.isArray(r.meta.titles),
  );
  if (episodes.length === 0) throw new Error("読み込める回がありませんでした");
  return { format: FORMAT, version: b.version, exportedAt: b.exportedAt ?? 0, episodes };
}

/**
 * 控えを履歴へ入れる。
 *
 * 同じ回が既にある場合は、**新しいほうを残す**。控えのほうが古ければ触らない。
 * 端末を移す途中で両方を触ってしまっても、あとから入れた古い控えで
 * 上書きされないようにするため。
 *
 * 端末に残っている音声は消さない(控えには入っていないだけで、
 * その端末では使えるため)。
 */
export async function restoreBackup(backup: Backup): Promise<ImportResult> {
  const current = await listEpisodes();
  const byId = new Map(current.map((r) => [r.id, r]));
  const result: ImportResult = { added: 0, updated: 0, skipped: 0 };

  for (const incoming of backup.episodes) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      await saveEpisode(incoming as EpisodeRecord);
      result.added++;
      continue;
    }
    if ((incoming.createdAt ?? 0) < (existing.createdAt ?? 0)) {
      result.skipped++;
      continue;
    }
    // 音声はその端末のものを残す。控えには入っていない
    await saveEpisode({ ...incoming, audio: existing.audio } as EpisodeRecord);
    result.updated++;
  }
  return result;
}
