import { useEffect, useRef, useState } from "react";
import { CANDIDATE_FOLDER_URL, verifyCandidateFolder } from "../lib/driveSave";
import { chooseCandidateFolder, emptyDriveConfig, loadDriveLibraries, requestDriveToken, validDriveConfig, type DriveConfig } from "../lib/driveOAuth";
import { useDriveConnection } from "./DriveConnection";

const messageOf = (error: unknown) => error instanceof TypeError
  ? "Google Driveに接続できませんでした。通信を確認して再試行してください。"
  : error instanceof Error ? error.message : "保存できませんでした。";

export default function DriveSettings({ focusHeading }: { focusHeading: boolean }) {
  const { config, connection, applyConfig, setConnection, configured: valid, statusText } = useDriveConnection();
  const [draft, setDraft] = useState(config);
  const [librariesReady, setLibrariesReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState("");
  const operation = useRef<AbortController>();
  const mounted = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
    };
  }, []);

  const saveConfig = (next?: DriveConfig) => {
    if (!next) setDraft(emptyDriveConfig);
    try {
      applyConfig(next);
      setStatus(next ? "Google接続設定を保存しました。" : "Google接続設定を消去しました。");
    } catch {
      setStatus("ブラウザのサイトデータ設定を確認してください。接続設定を端末に書き込めませんでした。");
    }
  };

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
    if (valid && !librariesReady) void prepare();
  }, [valid, librariesReady]);

  const connect = async (selectAccount = false) => {
    setConnecting(true);
    setStatus("");
    try {
      const session = await requestDriveToken(config.clientId, selectAccount);
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
        throw new Error("指定フォルダの利用許可を確認できませんでした。フォルダに書き込めるGoogleアカウントで接続し直し、指定のフォルダを選んでください。");
      }
      if (mounted.current) setConnection({ ...connection, writable: true });
    } catch (error) {
      if (mounted.current && !(error instanceof DOMException && error.name === "AbortError")) setStatus(messageOf(error));
    } finally {
      operation.current = undefined;
      if (mounted.current) setConnecting(false);
    }
  };

  return (
    <section className="card drive-settings" aria-labelledby="drive-settings-heading">
      <h2 id="drive-settings-heading" ref={heading} tabIndex={-1}>Google Drive連携</h2>
      <p>Gemini APIキーはAI生成用です。Picker APIキーはGoogle Driveのフォルダ選択用です。</p>
      <p role="status">Google Drive：{statusText}</p>
      <p>保存先 <a href={CANDIDATE_FOLDER_URL} target="_blank" rel="noreferrer">01_投稿候補を開く</a></p>
      <p className="muted">接続設定はこのブラウザに保存されます。Picker APIとサイトを制限したキーを入力してください。</p>
      <fieldset disabled={connecting}>
        <label>OAuthクライアントID<input type="text" autoCapitalize="none" value={draft.clientId} autoComplete="off" spellCheck={false} onChange={e => setDraft({ ...draft, clientId: e.target.value.trim() })} /></label>
        <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">OAuthクライアントIDの取得先</a>
        <label>Google Cloudプロジェクト番号<input type="text" autoComplete="off" value={draft.project} inputMode="numeric" onChange={e => setDraft({ ...draft, project: e.target.value.trim() })} /></label>
        <a href="https://console.cloud.google.com/iam-admin/settings" target="_blank" rel="noreferrer">Google Cloudプロジェクト番号の取得先</a>
        <label>Picker用ブラウザ制限キー<input type="text" autoCapitalize="none" spellCheck={false} value={draft.pickerKey} autoComplete="off" onChange={e => setDraft({ ...draft, pickerKey: e.target.value.trim() })} /></label>
        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Picker用ブラウザ制限キーの取得先</a>
        <button type="button" disabled={!validDriveConfig(draft)} onClick={() => saveConfig(draft)}>Google接続設定を保存</button>
        {valid && <button type="button" onClick={() => saveConfig()}>接続設定を消去</button>}
        {librariesReady && valid && <button type="button" onClick={() => void connect(true)}>Googleアカウントを選ぶ</button>}
        {connection && <button type="button" onClick={() => { setConnection(undefined); setStatus(""); }}>Googleとの接続を解除</button>}
      </fieldset>
      {valid && !librariesReady && (preparing ? <p role="status">Google接続を準備中…</p> :
        <button type="button" onClick={() => void prepare()}>Google接続の準備を再試行</button>)}
      {librariesReady && valid && (!connection || connection.expiresAt <= Date.now()) && (
        <button type="button" disabled={connecting} onClick={() => void connect()}>Googleに接続</button>
      )}
      {connection && !connection.writable && connection.expiresAt > Date.now() && (
        <button type="button" disabled={connecting} onClick={() => void grantFolder()}>投稿候補フォルダを選択</button>
      )}
      {status && <p role="status">{status}</p>}
      <details className="fold">
        <summary>つながらないとき</summary>
        <ul>
          <li>認証画面が開かない場合は、このサイトのポップアップを許可して再接続してください。</li>
          <li>Googleに拒否された場合は、OAuthクライアントID、許可済みのサイトのオリジン、テストユーザー登録を確認してください。</li>
          <li>フォルダが選べない場合は、PickerキーのAPIとサイト制限を確認し、指定フォルダへの編集権限があるアカウントを選んでください。</li>
        </ul>
      </details>
    </section>
  );
}
