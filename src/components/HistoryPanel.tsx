import { useEffect, useState } from "react";
import {
  listEpisodes,
  deleteEpisode,
  formatDate,
  formatDuration,
  type EpisodeRecord,
} from "../lib/history";
import ResultView from "./ResultView";

export default function HistoryPanel({ onChooseTitle }: { onChooseTitle: (id: string, title: string) => void }) {
  const [records, setRecords] = useState<EpisodeRecord[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});

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

  if (records === null) {
    return <div className="card muted">履歴を読み込み中…</div>;
  }
  if (records.length === 0) {
    return (
      <div className="card">
        <h2>履歴</h2>
        <p className="muted">まだエピソードがありません。WAVを処理すると自動で保存されます。</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>履歴({records.length}件)</h2>
        <p className="muted">
          生成結果はこの端末に保存されます。音声は直近5件のみ保持され、それ以前は本文だけが残ります。
        </p>
      </div>

      {records.map((r) => {
        const isOpen = openId === r.id;
        return (
          <div className="card" key={r.id}>
            <div className="history-head" onClick={() => setOpenId(isOpen ? null : r.id)}>
              <div>
                <div className="history-title">{r.chosenTitle || r.meta.titles[0]}</div>
                <div className="muted">
                  {formatDate(r.createdAt)} ・ {formatDuration(r.durationSec)}
                  {r.removedSec > 0 && ` ・ 無音カット ${Math.round(r.removedSec)}秒`}
                  {!r.audio && " ・ 音声は削除済み"}
                </div>
              </div>
              <span className="chevron">{isOpen ? "▲" : "▼"}</span>
            </div>

            {isOpen && (
              <>
                <ResultView
                  meta={r.meta}
                  chosenTitle={r.chosenTitle}
                  onChooseTitle={(title) => {
                    onChooseTitle(r.id, title);
                    setRecords((prev) =>
                      prev?.map((x) => (x.id === r.id ? { ...x, chosenTitle: title } : x)) ?? prev,
                    );
                  }}
                  audioUrl={audioUrls[r.id]}
                  fileName={r.fileName.replace(/\.wav$/i, ".mp3")}
                />
                <button
                  onClick={async () => {
                    await deleteEpisode(r.id);
                    setOpenId(null);
                    refresh();
                  }}
                >
                  🗑 この履歴を削除
                </button>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
