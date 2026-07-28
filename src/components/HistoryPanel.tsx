import { useEffect, useState } from "react";
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

interface Props {
  onChooseTitle: (id: string, title: string) => void;
  showName: string;
  accentColor: string;
  apiKey?: string;
  imageModel?: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export default function HistoryPanel({
  onChooseTitle,
  showName,
  accentColor,
  apiKey,
  imageModel,
}: Props) {
  const [records, setRecords] = useState<EpisodeRecord[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<"all" | "audio" | null>(null);

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
  if (records.length === 0) {
    return (
      <div className="card">
        <h2>履歴</h2>
        <p className="muted">まだエピソードがありません。WAVを処理すると自動で保存されます。</p>
      </div>
    );
  }

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

      {records.map((r) => {
        const isOpen = openId === r.id;
        return (
          <div className="card" key={r.id}>
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
                showName={showName}
                accentColor={accentColor}
                apiKey={apiKey}
                imageModel={imageModel}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
