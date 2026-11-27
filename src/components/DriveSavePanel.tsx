import { useEffect, useRef, useState } from "react";
import { DriveSaveError, saveShortToDrive, verifyCandidateFolder, type DriveShort, type SavedShort } from "../lib/driveSave";
import { useDriveConnection } from "./DriveConnection";

type CompletedShort = DriveShort & { url: string };
type SaveRow =
  | { state: "saving"; stage: string; fraction: number }
  | { state: "saved"; receipt: SavedShort }
  | { state: "failed"; reason: string };
const rowKey = (clip: CompletedShort) => JSON.stringify([clip.url, clip.title, clip.description, clip.hashtags]);
const messageOf = (error: unknown) => error instanceof TypeError
  ? "Google Driveに接続できませんでした。通信を確認して再試行してください。"
  : error instanceof Error ? error.message : "保存できませんでした。";

export default function DriveSavePanel({ videos, source, encoding }: {
  videos: CompletedShort[];
  source: Blob;
  encoding: boolean;
}) {
  const { config, connection, ready, statusText, openSettings, invalidate } = useDriveConnection();
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Record<string, SaveRow>>({});
  const [batch, setBatch] = useState<{ number: number; total: number }>();
  const operation = useRef<AbortController>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
    };
  }, []);
  useEffect(() => () => operation.current?.abort(), [connection?.token]);
  const unfinished = videos.filter(video => rows[rowKey(video)]?.state !== "saved");
  const failures = videos.filter(video => rows[rowKey(video)]?.state === "failed");

  const save = async (targets: CompletedShort[]) => {
    if (!ready || !connection || operation.current || encoding) return;
    const controller = new AbortController();
    operation.current = controller;
    setStatus("");
    setBatch({ number: 1, total: targets.length });
    let completed = 0;
    let failed = 0;
    try {
      if (!await verifyCandidateFolder(connection.token, controller.signal)) throw new Error("保存先フォルダを選び直してください。");
      for (const [index, clip] of targets.entries()) {
        if (controller.signal.aborted) break;
        setBatch({ number: index + 1, total: targets.length });
        const key = rowKey(clip);
        try {
          const receipt = await saveShortToDrive({
            token: connection.token, project: config.project, source, clip, signal: controller.signal,
            onProgress: (stage, fraction) => {
              if (mounted.current) setRows(prev => ({ ...prev, [key]: { state: "saving", stage, fraction } }));
            },
          });
          completed++;
          if (mounted.current) setRows(prev => ({ ...prev, [key]: { state: "saved", receipt } }));
        } catch (error) {
          if (!mounted.current) return;
          const reason = controller.signal.aborted ? "中断しました。再試行できます。" : messageOf(error);
          setRows(prev => ({ ...prev, [key]: { state: "failed", reason } }));
          if (controller.signal.aborted) break;
          failed++;
          if (error instanceof DriveSaveError && error.status === 401) {
            invalidate(connection.token);
            break;
          }
        }
      }
      if (mounted.current) setStatus(
        `${controller.signal.aborted ? "保存を中断しました。" : ""}完了 ${completed}本、失敗 ${failed}本、未処理・中断 ${targets.length - completed - failed}本。`,
      );
    } catch (error) {
      if (mounted.current) {
        setStatus(messageOf(error));
        if (error instanceof DriveSaveError && error.status === 401) invalidate(connection.token);
      }
    } finally {
      operation.current = undefined;
      if (mounted.current) setBatch(undefined);
    }
  };

  return (
    <details className="card fold">
      <summary>Googleドライブへ保存</summary>
      <p role="status">Google Drive：{statusText}</p>
      {!ready && <button type="button" onClick={openSettings}>設定でGoogle Drive連携を開く</button>}
      {ready && <div className="row-buttons">
        <button type="button" className="primary" disabled={!unfinished.length || !!batch || encoding} onClick={() => void save(unfinished)}>
          完成動画をまとめてGoogleドライブに保存
        </button>
        {!!failures.length && <button type="button" disabled={!!batch || encoding} onClick={() => void save(failures)}>失敗分だけ再試行</button>}
      </div>}
      {batch && <>
        <p role="status">{batch.number}本目 / 全{batch.total}本</p>
        <button type="button" onClick={() => operation.current?.abort()}>Drive保存を中断</button>
      </>}
      {status && <p role="status">{status}</p>}
      <ul>
        {videos.map(video => {
          const row = rows[rowKey(video)];
          return <li key={video.url}>
            <strong>{video.title}</strong>
            {row?.state === "saving" && <>　{row.stage} <progress aria-label={`${video.title}の保存進捗`} value={row.fraction} max={1} /></>}
            {row?.state === "failed" && <p role="alert">{row.reason}</p>}
            {row?.state === "saved" && <p>
              {row.receipt.reused ? "保存済みの版を再利用" : "保存完了"} · 候補 <code>{row.receipt.candidateId.slice(0, 12)}</code>
              {" · 版 "}<a href={"https://drive.google.com/open?id=" + encodeURIComponent(row.receipt.manifestId)} target="_blank" rel="noreferrer">{row.receipt.versionId.slice(0, 12)}</a>
              {row.receipt.latestVersionId === row.receipt.versionId ? "（保存時の最新版）" : `（保存時の最新版 ${row.receipt.latestVersionId.slice(0, 12)}）`}
            </p>}
            {ready && row?.state !== "saved" && <button type="button" disabled={!!batch || encoding} onClick={() => void save([video])}>
              {row?.state === "failed" ? "この動画を再試行" : "この動画をDriveに保存"}
            </button>}
          </li>;
        })}
      </ul>
    </details>
  );
}
