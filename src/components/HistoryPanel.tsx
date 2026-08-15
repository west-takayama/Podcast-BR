import { useEffect, useMemo, useState } from "react";
import { hitToClip, searchEpisodes, type Hit } from "../lib/search";
import {
  listEpisodes,
  deleteEpisode,
  deleteAllEpisodes,
  dropAllAudio,
  formatDate,
  formatDuration,
  totalAudioBytes,
  type EpisodeRecord,
} from "../lib/history";
import ResultView from "./ResultView";
import { backupFileName, buildBackup, parseBackup, restoreBackup } from "../lib/backup";

interface Props {
  onChooseTitle: (id: string, title: string) => void;
  onEditMeta: (id: string, patch: Partial<EpisodeRecord["meta"]>) => void;
  /** 過去回の出演者をあとから足す・直す。 */
  onCastEdit: (id: string, cast: string) => void;
  showName: string;
  accentColor: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

const WHERE_LABEL: Record<string, string> = {
  title: "タイトル",
  chapter: "チャプター",
  notes: "説明・要約",
  transcript: "書き起こし",
};

const fmtTime = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export default function HistoryPanel({
  onChooseTitle,
  onEditMeta,
  onCastEdit,
  showName,
  accentColor,
}: Props) {
  const [records, setRecords] = useState<EpisodeRecord[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [backupNote, setBackupNote] = useState("");
  const [confirming, setConfirming] = useState<"all" | "audio" | null>(null);
  const [query, setQuery] = useState("");
  /** 検索から開いた場面。その回の切り抜き候補の先頭に差し込む。 */
  const [picked, setPicked] = useState<Hit | null>(null);

  const refresh = () => listEpisodes().then(setRecords);

  useEffect(() => {
    refresh();
  }, []);

  // 開いた履歴の音声だけ Blob URL を作り、閉じる/離脱時に解放する
  useEffect(() => {
    if (!openId || !records) return;
    const record = records.find((r) => r.id === openId);
    if (!record?.audio || audioUrls[openId]) return;
    const url = URL.createObjectURL(record.audio);
    setAudioUrls((prev) => ({ ...prev, [openId]: url }));
  }, [openId, records, audioUrls]);

  useEffect(() => {
    return () => {
      Object.values(audioUrls).forEach(URL.revokeObjectURL);
    };
  }, [audioUrls]);

  // フックは早期 return より前に置く(React のフックの規則)
  const found = useMemo(
    () => (records ? searchEpisodes(records, query) : null),
    [records, query],
  );

  const remove = async (id: string) => {
    await deleteEpisode(id);
    if (openId === id) setOpenId(null);
    setAudioUrls((prev) => {
      if (prev[id]) URL.revokeObjectURL(prev[id]);
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
    refresh();
  };

  if (records === null) {
    return <div className="card muted">履歴を読み込み中…</div>;
  }
  /** 履歴を1つのファイルにして持ち出す。 */
  const exportBackup = async () => {
    setBackupNote("");
    try {
      const backup = await buildBackup(records);
      const blob = new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setBackupNote(`${backup.episodes.length}件を書き出しました(${a.download})`);
    } catch (e) {
      setBackupNote(`⚠️ 書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 控えを読み込んで履歴に入れる。 */
  const importBackup = async (file: File) => {
    setBackupNote("");
    try {
      const backup = parseBackup(await file.text());
      const r = await restoreBackup(backup);
      const parts = [
        r.added > 0 && `${r.added}件を追加`,
        r.updated > 0 && `${r.updated}件を更新`,
        r.skipped > 0 && `${r.skipped}件はこちらが新しいのでそのまま`,
      ].filter(Boolean);
      setBackupNote(parts.length > 0 ? `✓ ${parts.join(" / ")}` : "✓ 変わりはありませんでした");
      refresh();
    } catch (e) {
      setBackupNote(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 履歴が空でも「控えを戻す」だけは出す。
  // 端末を替えた直後は必ず空で、**そのときこそ戻したい**
  if (records.length === 0) {
    return (
      <div className="card">
        <h2>履歴</h2>
        <p className="muted">
          まだエピソードがありません。音声を処理すると自動で保存されます。
          <br />
          別の端末で使っていた場合は、書き出しておいた控えをここから戻せます。
        </p>
        <label className="restore-pick">
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importBackup(f);
            }}
          />
          <span>⬆️ 控えを読み込む</span>
        </label>
        {backupNote && <p className="muted">{backupNote}</p>}
      </div>
    );
  }

  const openHit = (hit: Hit) => {
    setPicked(hit);
    setOpenId(hit.episodeId);
    // 開いた回まで送る。一覧の下のほうにあると気づけない
    setTimeout(() => {
      document.getElementById(`ep-${hit.episodeId}`)?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  const audioBytes = totalAudioBytes(records);
  const withAudio = records.filter((r) => r.audio).length;

  return (
    <>
      <div className="card">
        <h2>履歴({records.length}件)</h2>
        <p className="muted">
          この端末にのみ保存されます。音声は直近5件まで保持し、それ以前は本文だけが残ります。
          {audioBytes > 0 && ` 現在 ${withAudio}件の音声で ${formatBytes(audioBytes)} を使用中。`}
        </p>

        {confirming === null ? (
          <div className="row-buttons">
            {audioBytes > 0 && (
              <button onClick={() => setConfirming("audio")}>🎵 音声だけ全部消す</button>
            )}
            <button className="danger" onClick={() => setConfirming("all")}>
              🗑 履歴を全部消す
            </button>
          </div>
        ) : (
          <div className="confirm">
            <p>
              {confirming === "audio"
                ? `${withAudio}件の音声(${formatBytes(audioBytes)})を削除します。タイトルや説明文は残ります。`
                : `${records.length}件の履歴をすべて削除します。この操作は取り消せません。`}
            </p>
            <div className="row-buttons">
              <button onClick={() => setConfirming(null)}>やめる</button>
              <button
                className="danger"
                onClick={async () => {
                  if (confirming === "audio") await dropAllAudio();
                  else await deleteAllEpisodes();
                  Object.values(audioUrls).forEach(URL.revokeObjectURL);
                  setAudioUrls({});
                  setOpenId(null);
                  setConfirming(null);
                  refresh();
                }}
              >
                削除する
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>💾 控えを取る / 戻す</h2>
        <p className="muted">
          履歴はこの端末の中だけにあります。端末を替えたり、閲覧履歴を消したりすると
          <strong>全部消えます</strong>。書き出しておけば、別の端末でも戻せます。
          <br />
          入るのはタイトル・説明文・チャプター・書き起こし・出演者など
          <strong>作り直せないもの</strong>です。音声は入りません(元の録音から作り直せるうえ、
          数百MBになるため)。
        </p>
        <div className="row-buttons">
          <button onClick={exportBackup} disabled={records.length === 0}>
            ⬇️ 控えを書き出す
          </button>
          <label className="restore-pick">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importBackup(f);
              }}
            />
            <span>⬆️ 控えを読み込む</span>
          </label>
        </div>
        {backupNote && <p className="muted">{backupNote}</p>}
      </div>

      <div className="card">
        <h2>🔎 過去の回から探す</h2>
        <p className="muted">
          言葉で探すと、その場面の位置まで出ます。そのまま切り抜きの候補にできます。
          {found && found.totalEpisodes > 0 && (
            <>
              <br />
              全{found.totalEpisodes}回のうち<strong>{found.searchableEpisodes}回</strong>
              に書き起こしがあり、場面の位置まで引けます
              {found.searchableEpisodes < found.totalEpisodes &&
                "(残りはタイトル・チャプター・要約から探します)"}
              。
            </>
          )}
        </p>
        <input
          type="text"
          value={query}
          placeholder="例: ねぎ塩 / ジャガイモ / 失敗談"
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="muted" style={{ marginTop: 6 }}>
          カタカナとひらがな、全角と半角は同じものとして探します。ただし
          <strong>漢字とかなは別</strong>です(「ねぎ塩」と「ねぎしお」は別の語として扱います)。
          見つからないときは書き方を変えてみてください。空白で区切ると、その全部を含む文だけ出します。
        </p>

        {query.trim() && found && (
          found.hits.length === 0 ? (
            <p className="muted">見つかりませんでした。</p>
          ) : (
            <>
              <p className="muted">{found.hits.length}件</p>
              {found.hits.map((h, i) => (
                <div
                  key={`${h.episodeId}-${i}`}
                  className="hit"
                  onClick={() => openHit(h)}
                >
                  <div className="hit-text">{h.speaker ? `${h.speaker}: ` : ""}{h.text}</div>
                  <div className="muted">
                    {h.episodeTitle} ・ {formatDate(h.createdAt)}
                    {h.atSec !== null && ` ・ ${fmtTime(h.atSec)}`}
                    {h.where !== "transcript" && ` ・ ${WHERE_LABEL[h.where]}`}
                    {h.atSec !== null && !h.hasAudio && " ・ 音声は削除済み"}
                  </div>
                </div>
              ))}
            </>
          )
        )}
      </div>

      {records.map((r) => {
        const isOpen = openId === r.id;
        // 検索から開いた場面は、その回の切り抜き候補の先頭に置く
        const hit = picked && picked.episodeId === r.id && picked.atSec !== null ? picked : null;
        const meta = hit
          ? { ...r.meta, clips: [hitToClip(hit), ...(r.meta.clips ?? [])] }
          : r.meta;
        return (
          <div className="card" key={r.id} id={`ep-${r.id}`}>
            <div className="history-head">
              <div className="history-main" onClick={() => setOpenId(isOpen ? null : r.id)}>
                <div className="history-title">{r.chosenTitle || r.meta.titles[0]}</div>
                <div className="muted">
                  {formatDate(r.createdAt)} ・ {formatDuration(r.durationSec)}
                  {r.removedSec > 0 && ` ・ 無音カット ${Math.round(r.removedSec)}秒`}
                  {r.audio ? ` ・ ${formatBytes(r.audio.size)}` : " ・ 音声は削除済み"}
                </div>
              </div>
              {/* 開かなくても消せるよう、行に削除ボタンを置く */}
              <button
                className="icon-btn"
                aria-label="この履歴を削除"
                onClick={() => remove(r.id)}
              >
                🗑
              </button>
              <span className="chevron" onClick={() => setOpenId(isOpen ? null : r.id)}>
                {isOpen ? "▲" : "▼"}
              </span>
            </div>

            {isOpen && (
              <ResultView
                meta={meta}
                chosenTitle={r.chosenTitle}
                onChooseTitle={(title) => {
                  onChooseTitle(r.id, title);
                  setRecords((prev) =>
                    prev?.map((x) => (x.id === r.id ? { ...x, chosenTitle: title } : x)) ?? prev,
                  );
                }}
                audioUrl={audioUrls[r.id]}
                fileName={r.fileName.replace(/\.wav$/i, ".mp3")}
                showName={showName}
                accentColor={accentColor}
                transcript={r.transcript}
                onEdit={(patch) => {
                  onEditMeta(r.id, patch);
                  setRecords((prev) =>
                    prev?.map((x) => (x.id === r.id ? { ...x, meta: { ...x.meta, ...patch } } : x)) ??
                    prev,
                  );
                }}
                cast={r.cast ?? ""}
                onCastChange={(next) => {
                  onCastEdit(r.id, next.trim());
                  setRecords((prev) =>
                    prev?.map((x) => (x.id === r.id ? { ...x, cast: next.trim() || undefined } : x)) ??
                    prev,
                  );
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
