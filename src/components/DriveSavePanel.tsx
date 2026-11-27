import { useEffect, useRef, useState } from "react";
import { CANDIDATE_FOLDER_URL, DriveSaveError, saveShortToDrive, verifyCandidateFolder, type DriveShort, type SavedShort } from "../lib/driveSave";
import { chooseCandidateFolder, emptyDriveConfig, loadDriveLibraries, readDriveConfig, requestDriveToken, validDriveConfig, writeDriveConfig, type DriveConfig } from "../lib/driveOAuth";

type CompletedShort = DriveShort & { url: string };
type SaveRow =
  | { state: "saving"; stage: string; fraction: number }
  | { state: "saved"; receipt: SavedShort }
  | { state: "failed"; reason: string };
type Connection = { token: string; expiresAt: number; writable: boolean };

let pageConnection: { configKey: string; session: Connection } | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const configKey = (config: DriveConfig) => JSON.stringify([config.clientId, config.project, config.pickerKey]);
const rowKey = (clip: CompletedShort) => JSON.stringify([clip.url, clip.title, clip.description, clip.hashtags]);
const messageOf = (error: unknown) => error instanceof TypeError
  ? "Google Driveに接続できませんでした。通信を確認して再試行してください。"
  : error instanceof Error ? error.message : "保存できませんでした。";

export default function DriveSavePanel({ videos, source, encoding }: {
  videos: CompletedShort[];
  source: Blob;
  encoding: boolean;
}) {
  const [config, setConfig] = useState(readDriveConfig);
  const [draft, setDraft] = useState(config);
  const [open, setOpen] = useState(false);
  const [librariesReady, setLibrariesReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [connection, setConnection] = useState<Connection | undefined>(() =>
    pageConnection?.configKey === configKey(config) ? pageConnection.session : undefined);
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
  const updateConnection = (session?: Connection) => {
    clearTimeout(expiryTimer);
    pageConnection = session ? { configKey: configKey(config), session } : undefined;
    if (session) expiryTimer = setTimeout(() => { pageConnection = undefined; }, Math.max(0, session.expiresAt - Date.now()));
    setConnection(session);
  };
  useEffect(() => {
    if (!connection) return;
    const timer = setTimeout(() => setConnection(undefined), Math.max(0, connection.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [connection]);
  const ready = connection?.writable && connection.expiresAt > Date.now();
  const valid = validDriveConfig(config);
  const unfinished = videos.filter(video => rows[rowKey(video)]?.state !== "saved");
  const failures = videos.filter(video => rows[rowKey(video)]?.state === "failed");

  const prepare = async () => {
    setPreparing(true);
    try {
      await loadDriveLibraries();
      if (mounted.current) setLibrariesReady(true);
    } catch (error) {
      if (mounted.current) setStatus(messageOf(error));
    } finally { if (mounted.current) setPreparing(false); }
  };
  useEffect(() => {
    if (open && valid && !librariesReady) void prepare();
  }, [open, valid, librariesReady]);

  const applyConfig = (next?: DriveConfig) => {
    updateConnection();
    setRows({});
    setConfig(next ?? emptyDriveConfig);
    if (!next) setDraft(emptyDriveConfig);
    try {
      writeDriveConfig(next);
      setStatus(next ? "Google接続設定をこの端末に保存しました。" : "Google接続設定をこの端末から消去しました。");
    } catch {
      setStatus(next ? "端末に設定を保存できませんでした。この画面では接続できます。" : "端末の設定を消去できませんでした。ブラウザのサイトデータを確認してください。");
    }
  };

  const connect = async (selectAccount = false) => {
    setConnecting(true);
    setStatus("");
    try {
      const session = await requestDriveToken(config.clientId, selectAccount);
      const writable = await verifyCandidateFolder(session.token);
      if (mounted.current) updateConnection({ ...session, writable });
    } catch (error) {
      if (mounted.current) {
        updateConnection();
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
      if (mounted.current) updateConnection({ ...connection, writable: true });
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
            updateConnection();
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
        if (error instanceof DriveSaveError && error.status === 401) updateConnection();
      }
    } finally {
      operation.current = undefined;
      if (mounted.current) setBatch(undefined);
    }
  };

  return (
    <details className="card fold" onToggle={event => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
    }}>
      <summary>Googleドライブへ保存</summary>
      <p>保存先 <a href={CANDIDATE_FOLDER_URL} target="_blank" rel="noreferrer">01_投稿候補</a>。動画と投稿情報を承認待ちの候補として保存します。</p>
      <details className="fold">
        <summary>Google接続設定</summary>
        <p className="muted">接続設定はこのブラウザに保存されます。Picker APIとサイトを制限したキーを入力してください。</p>
        <fieldset disabled={connecting || !!batch}>
          <label>OAuthクライアントID<input value={draft.clientId} autoComplete="off" spellCheck={false} onChange={e => setDraft({ ...draft, clientId: e.target.value.trim() })} /></label>
          <label>Google Cloudプロジェクト番号<input value={draft.project} inputMode="numeric" onChange={e => setDraft({ ...draft, project: e.target.value.trim() })} /></label>
          <label>Picker用ブラウザ制限キー<input type="password" value={draft.pickerKey} autoComplete="off" onChange={e => setDraft({ ...draft, pickerKey: e.target.value.trim() })} /></label>
          <button type="button" disabled={!validDriveConfig(draft)} onClick={() => applyConfig(draft)}>Google接続設定を保存</button>
          {valid && <button type="button" onClick={() => applyConfig()}>接続設定を消去</button>}
          {librariesReady && valid && <button type="button" onClick={() => void connect(true)}>Googleアカウントを選ぶ</button>}
          {connection && <button type="button" onClick={() => { updateConnection(); setStatus(""); }}>Google接続を切る</button>}
        </fieldset>
      </details>
      {valid && !librariesReady && (preparing ? <p role="status">Google接続を準備中…</p> :
        <button type="button" onClick={() => void prepare()}>Google接続の準備を再試行</button>)}
      {librariesReady && valid && (!connection || connection.expiresAt <= Date.now()) && (
        <button type="button" disabled={connecting || !!batch} onClick={() => void connect()}>Googleに接続</button>
      )}
      {connection && !connection.writable && connection.expiresAt > Date.now() && (
        <button type="button" disabled={connecting} onClick={() => void grantFolder()}>投稿候補フォルダを選択</button>
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
