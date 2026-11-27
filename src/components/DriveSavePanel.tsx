import { useEffect, useRef, useState } from "react";
import { CANDIDATE_FOLDER_URL, DriveSaveError, saveShortToDrive, verifyCandidateFolder, type DriveShort, type SavedShort } from "../lib/driveSave";
import { chooseCandidateFolder, loadDriveLibraries, requestDriveToken, type DriveConfig } from "../lib/driveOAuth";

type CompletedShort = DriveShort & { url: string };
type SaveRow =
  | { state: "saving"; stage: string; fraction: number }
  | { state: "saved"; receipt: SavedShort }
  | { state: "failed"; reason: string };
type Connection = { token: string; expiresAt: number; writable: boolean };

const emptyConfig: DriveConfig = { clientId: "", project: "", pickerKey: "" };
const messageOf = (error: unknown) => error instanceof TypeError
  ? "Google Driveに接続できませんでした。通信を確認して再試行してください。"
  : error instanceof Error ? error.message : "保存できませんでした。";

export default function DriveSavePanel({ videos, source, encoding }: {
  videos: CompletedShort[];
  source: Blob;
  encoding: boolean;
}) {
  const [config, setConfig] = useState<DriveConfig>(emptyConfig);
  const [librariesReady, setLibrariesReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [connection, setConnection] = useState<Connection>();
  const [connecting, setConnecting] = useState(false);
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
  const ready = connection?.writable && connection.expiresAt > Date.now();
  const valid = /^[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(config.clientId) &&
    /^\d+$/.test(config.project) && !!config.pickerKey;
  const unfinished = videos.filter(video => rows[video.url]?.state !== "saved");
  const failures = videos.filter(video => rows[video.url]?.state === "failed");

  const prepare = async () => {
    setPreparing(true);
    setStatus("");
    try {
      await loadDriveLibraries();
      if (mounted.current) setLibrariesReady(true);
    } catch (error) {
      if (mounted.current) setStatus(messageOf(error));
    } finally { if (mounted.current) setPreparing(false); }
  };

  const connect = async () => {
    setConnecting(true);
    setStatus("");
    try {
      const session = await requestDriveToken(config.clientId);
      const writable = await verifyCandidateFolder(session.token);
      if (mounted.current) setConnection({ ...session, writable });
    } catch (error) {
      if (mounted.current) {
        setConnection(undefined);
        setStatus(messageOf(error));
      }
    } finally { if (mounted.current) setConnecting(false); }
  };

  const grantFolder = async () => {
    if (!connection || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setConnecting(true);
    setStatus("");
    try {
      await chooseCandidateFolder(config, connection.token, controller.signal);
      if (!await verifyCandidateFolder(connection.token, controller.signal)) {
        throw new Error("指定フォルダの利用許可を確認できませんでした。Google Cloudの設定を確認してください。");
      }
      if (mounted.current) setConnection({ ...connection, writable: true });
    } catch (error) {
      if (mounted.current && !(error instanceof DOMException && error.name === "AbortError")) setStatus(messageOf(error));
    } finally {
      operation.current = undefined;
      if (mounted.current) setConnecting(false);
    }
  };

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
        try {
          const receipt = await saveShortToDrive({
            token: connection.token, project: config.project, source, clip, signal: controller.signal,
            onProgress: (stage, fraction) => {
              setRows(prev => ({ ...prev, [clip.url]: { state: "saving", stage, fraction } }));
            },
          });
          completed++;
          if (mounted.current) setRows(prev => ({ ...prev, [clip.url]: { state: "saved", receipt } }));
        } catch (error) {
          if (!mounted.current) return;
          const reason = controller.signal.aborted ? "中断しました。再試行できます。" : messageOf(error);
          setRows(prev => ({ ...prev, [clip.url]: { state: "failed", reason } }));
          if (controller.signal.aborted) break;
          failed++;
          if (error instanceof DriveSaveError && error.status === 401) {
            setConnection(undefined);
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
        if (error instanceof DriveSaveError && error.status === 401) setConnection(undefined);
      }
    } finally {
      operation.current = undefined;
      if (mounted.current) setBatch(undefined);
    }
  };

  return (
    <details className="card fold">
      <summary>Googleドライブへ保存</summary>
      <p>保存先 <a href={CANDIDATE_FOLDER_URL} target="_blank" rel="noreferrer">01_投稿候補</a>。動画と投稿情報を承認待ちの候補として保存します。</p>
      {!connection && <details className="fold">
        <summary>Google接続設定</summary>
        <p className="muted">Google Cloudで発行した値を入力してください。ページを再読み込みすると接続設定は消えます。</p>
        <label>OAuthクライアントID<input value={config.clientId} autoComplete="off" spellCheck={false} onChange={e => setConfig({ ...config, clientId: e.target.value.trim() })} /></label>
        <label>Google Cloudプロジェクト番号<input value={config.project} inputMode="numeric" onChange={e => setConfig({ ...config, project: e.target.value.trim() })} /></label>
        <label>Picker用ブラウザ制限キー<input type="password" value={config.pickerKey} autoComplete="off" onChange={e => setConfig({ ...config, pickerKey: e.target.value.trim() })} /></label>
        {!librariesReady && <button type="button" disabled={!valid || preparing} onClick={() => void prepare()}>
          {preparing ? "準備中…" : "Google接続を準備"}
        </button>}
      </details>}
      {librariesReady && (!connection || connection.expiresAt <= Date.now()) && (
        <button type="button" disabled={!valid || connecting || !!batch} onClick={() => void connect()}>Googleに接続</button>
      )}
      {connection && !connection.writable && connection.expiresAt > Date.now() && (
        <button type="button" disabled={connecting} onClick={() => void grantFolder()}>投稿候補フォルダを選択</button>
      )}
      {connection && !batch && !connecting && (
        <button type="button" onClick={() => { setConnection(undefined); setStatus(""); }}>Google接続を切る</button>
      )}
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
          const row = rows[video.url];
          return <li key={video.url}>
            <strong>{video.title}</strong>
            {row?.state === "saving" && <>　{row.stage} <progress aria-label={`${video.title}の保存進捗`} value={row.fraction} max={1} /></>}
            {row?.state === "failed" && <p role="alert">{row.reason}</p>}
            {row?.state === "saved" && <p>{row.receipt.reused ? "保存済みの候補を再利用" : "保存完了"} · ID <code>{row.receipt.candidateId.slice(0, 12)}</code></p>}
            {ready && row?.state !== "saved" && <button type="button" disabled={!!batch || encoding} onClick={() => void save([video])}>
              {row?.state === "failed" ? "この動画を再試行" : "この動画をDriveに保存"}
            </button>}
          </li>;
        })}
      </ul>
    </details>
  );
}
