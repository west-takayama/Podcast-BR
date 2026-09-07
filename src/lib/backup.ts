// 履歴と設定の書き出し・読み込み。
//
// この道具は端末の中だけで完結する。サーバーが無いのは良いことだが、
// **逃げ場も無い**。端末を買い替えたら、閲覧履歴を消したら、
// 積み上げた回の記録(採用したタイトル・書き起こし・話題)が丸ごと消える。
// 収録し直せない類いのものなので、持ち出せるようにしておく。
//
// 音声は入れない。5回ぶんで数百MBになり、メールにも Drive にも載らない。
// そして音声は元ファイルから作り直せる。**作り直せないのは文章のほう。**
//
// 設定も同じ理由で入れる。番組の背景・想定している聴き手・よく出る言葉は
// 手で書いたもので、しかも毎回の生成の質を決めている。端末を替えるたびに
// 書き直させるなら、控えを取る意味が半分しかない。
// **ただしAPIキーは入れない。** 控えはメールや Drive に載せて運ぶものなので、
// 鍵を同じ袋に入れると、ファイルが漏れた時点で鍵も漏れる。

import type { EpisodeRecord } from "./history";
import { listEpisodes, saveEpisode } from "./history";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  portableSettings,
  saveSettings,
  type PortableSettings,
  type Settings,
} from "./settings";

const FORMAT = "podcast-br-backup";
/** v2 で設定を足した。v1 の控えも読めるようにしてある。 */
const VERSION = 2;

/** 書き出す1件。音声(Blob)は持たない。 */
export type BackupEpisode = Omit<EpisodeRecord, "audio">;

export interface Backup {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  episodes: BackupEpisode[];
  /** 番組の設定。APIキーは含まない。v1 の控えには無い。 */
  settings?: PortableSettings;
}

/** いまの履歴と設定を、持ち出せる形にする。 */
export async function buildBackup(records?: EpisodeRecord[]): Promise<Backup> {
  const all = records ?? (await listEpisodes());
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    episodes: all.map(({ audio: _audio, ...rest }) => rest),
    settings: portableSettings(loadSettings()),
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
  /** 設定をどう扱ったか。 */
  settings: "restored" | "kept-newer" | "none";
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
  const settings =
    b.settings && typeof b.settings === "object" ? (b.settings as PortableSettings) : undefined;
  if (episodes.length === 0 && !settings) {
    throw new Error("読み込める回がありませんでした");
  }
  return {
    format: FORMAT,
    version: b.version,
    exportedAt: b.exportedAt ?? 0,
    episodes,
    settings,
  };
}

/** その回を最後に触った時刻。古い記録には無いので、作った時刻で代える。 */
function touchedAt(r: { updatedAt?: number; createdAt?: number }): number {
  return r.updatedAt ?? r.createdAt ?? 0;
}

/**
 * 控えを履歴と設定へ入れる。
 *
 * 同じ回が既にある場合は、**最後に触ったほうを残す**。控えのほうが古ければ触らない。
 * 端末を移す途中で両方を触ってしまっても、あとから入れた古い控えで
 * 上書きされないようにするため。
 *
 * 以前はここで作成日時を比べていたが、作成日時は**あとから変わらない**ので
 * 同じ回どうしでは必ず引き分けになり、判定が働いていなかった。
 * 古い控えを読ませると、直したタイトルが黙って元に戻っていた。
 *
 * 引き分けのときは手元を残す。どちらが新しいか分からないなら、
 * いま使っているほうを消さないのが安全。
 *
 * 端末に残っている音声は消さない(控えには入っていないだけで、
 * その端末では使えるため)。
 */
export async function restoreBackup(backup: Backup): Promise<ImportResult> {
  const current = await listEpisodes();
  const byId = new Map(current.map((r) => [r.id, r]));
  const result: ImportResult = { added: 0, updated: 0, skipped: 0, settings: "none" };

  for (const incoming of backup.episodes) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      await saveEpisode(incoming as EpisodeRecord);
      result.added++;
      continue;
    }
    if (touchedAt(incoming) <= touchedAt(existing)) {
      result.skipped++;
      continue;
    }
    // 音声はその端末のものを残す。控えには入っていない
    await saveEpisode({ ...incoming, audio: existing.audio } as EpisodeRecord);
    result.updated++;
  }

  if (backup.settings) {
    const local = loadSettings();
    // 設定にも同じ決まりを当てる。手元を最近いじっているなら触らない
    if ((backup.settings.savedAt ?? 0) > (local.savedAt ?? 0)) {
      // APIキーは控えに入っていない。手元のものをそのまま使う
      const merged: Settings = {
        ...DEFAULT_SETTINGS,
        ...backup.settings,
        prompt: { ...DEFAULT_SETTINGS.prompt, ...backup.settings.prompt },
        dsp: { ...DEFAULT_SETTINGS.dsp, ...backup.settings.dsp },
        apiKey: local.apiKey,
      };
      saveSettings(merged);
      result.settings = "restored";
    } else {
      result.settings = "kept-newer";
    }
  }
  return result;
}

/**
 * 最後に控えを取った時刻。
 *
 * 控えは「取ってあれば助かる」ではなく「取っていなければ意味が無い」もの。
 * 書き出したことを覚えておいて、そこから何回ぶん増えたかを画面に出す。
 * 覚えているかどうかに頼る作りだと、いちばん要るときに空になっている。
 */
const LAST_BACKUP_KEY = "podcast-br-last-backup";

export function markBackedUp(at = Date.now()): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(at));
  } catch {
    // 覚えられなくても書き出しそのものは済んでいる
  }
}

export function lastBackupAt(): number | null {
  try {
    const raw = Number(localStorage.getItem(LAST_BACKUP_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** 前回の控えのあとに作られた・触られた回の数。 */
export function unsavedSince(records: EpisodeRecord[], since: number | null): number {
  if (since === null) return records.length;
  return records.filter((r) => touchedAt(r) > since).length;
}
