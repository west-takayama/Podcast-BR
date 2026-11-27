import { CANDIDATE_FOLDER_ID } from "./driveSave";

export interface DriveConfig { clientId: string; project: string; pickerKey: string }
const CONFIG_KEY = "studio-drive-public-config";
export const emptyDriveConfig: DriveConfig = { clientId: "", project: "", pickerKey: "" };

export function validDriveConfig(config: DriveConfig) {
  return typeof config.clientId === "string" && /^[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(config.clientId) &&
    typeof config.project === "string" && /^\d+$/.test(config.project) &&
    typeof config.pickerKey === "string" && /^[\w-]+$/.test(config.pickerKey);
}

export function readDriveConfig(): DriveConfig {
  try {
    const config = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null") as DriveConfig | null;
    if (config && validDriveConfig(config)) {
      return { clientId: config.clientId, project: config.project, pickerKey: config.pickerKey };
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return emptyDriveConfig;
}

export function writeDriveConfig(config?: DriveConfig) {
  if (!config) localStorage.removeItem(CONFIG_KEY);
  else if (validDriveConfig(config)) {
    const { clientId, project, pickerKey } = config;
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ clientId, project, pickerKey }));
  }
}
type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string };
interface TokenClient { requestAccessToken: (config: { prompt: string }) => void }
type TokenConfig = {
  client_id: string; scope: string; include_granted_scopes: boolean;
  callback: (response: TokenResponse) => void; error_callback: () => void;
};
interface PickerView {
  setIncludeFolders(value: boolean): PickerView;
  setSelectFolderEnabled(value: boolean): PickerView;
  setMimeTypes(value: string): PickerView;
}
interface Picker {
  setVisible(value: boolean): void;
  dispose?: () => void;
}
interface PickerBuilder {
  addView(view: PickerView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: { id: string }[] }) => void): PickerBuilder;
  build(): Picker;
}
type Google = {
  accounts: { oauth2: { initTokenClient(config: TokenConfig): TokenClient } };
  picker: {
    DocsView: new (id: string) => PickerView;
    ViewId: { FOLDERS: string };
    PickerBuilder: new () => PickerBuilder;
    Action: { PICKED: string; CANCEL: string; ERROR?: string };
  };
};
const globals = window as Window & { google?: Google; gapi?: { load: (name: string, options: {
  callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void;
}) => void } };

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error("Google接続機能を読み込めませんでした。")); };
    document.head.appendChild(script);
  });
}

let libraries: Promise<void> | undefined;
export function loadDriveLibraries() {
  libraries ??= Promise.all([
    globals.google?.accounts ? undefined : loadScript("https://accounts.google.com/gsi/client"),
    globals.gapi ? undefined : loadScript("https://apis.google.com/js/api.js"),
  ]).then(async () => {
    if (globals.google?.picker) return;
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error("Google Pickerを読み込めませんでした。"));
      if (!globals.gapi) { fail(); return; }
      globals.gapi.load("picker", { callback: resolve, onerror: fail, timeout: 15000, ontimeout: fail });
    });
  }).catch(error => { libraries = undefined; throw error; });
  return libraries;
}

export function requestDriveToken(clientId: string, selectAccount = false): Promise<{ token: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Google認証を完了できませんでした。ポップアップとアカウント設定を確認してください。"));
    const oauth = globals.google?.accounts?.oauth2;
    if (!oauth) { fail(); return; }
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      include_granted_scopes: false,
      callback: response => {
        if (response.error || !response.access_token) { fail(); return; }
        resolve({ token: response.access_token, expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000 - 30000 });
      },
      error_callback: fail,
    });
    client.requestAccessToken({ prompt: selectAccount ? "select_account" : "" });
  });
}

export function chooseCandidateFolder(config: DriveConfig, token: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const api = globals.google?.picker;
    if (!api) { reject(new Error("Google Pickerが準備できていません。")); return; }
    const view = new api.DocsView(api.ViewId.FOLDERS).setIncludeFolders(true)
      .setSelectFolderEnabled(true).setMimeTypes("application/vnd.google-apps.folder");
    const abort = () => { finish(); reject(new DOMException("中断しました", "AbortError")); };
    const finish = () => {
      signal.removeEventListener("abort", abort);
      picker.setVisible(false);
      picker.dispose?.();
    };
    const picker = new api.PickerBuilder()
      .addView(view).setOAuthToken(token).setDeveloperKey(config.pickerKey).setAppId(config.project)
      .setOrigin(location.origin).setTitle("01_投稿候補 を選択してください")
      .setCallback(data => {
        if (data.action === api.Action.CANCEL) { abort(); return; }
        if (api.Action.ERROR && data.action === api.Action.ERROR) {
          finish(); reject(new Error("フォルダ選択に失敗しました。Pickerの設定を確認してください。")); return;
        }
        if (data.action !== api.Action.PICKED) return;
        finish();
        if (data.docs?.length === 1 && data.docs[0].id === CANDIDATE_FOLDER_ID) resolve();
        else reject(new Error("指定の「01_投稿候補」フォルダを選択してください。"));
      }).build();
    signal.addEventListener("abort", abort, { once: true });
    picker.setVisible(true);
  });
}
