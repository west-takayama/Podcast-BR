import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { emptyDriveConfig, readDriveConfig, validDriveConfig, writeDriveConfig, type DriveConfig } from "../lib/driveOAuth";

type Connection = { token: string; expiresAt: number; writable: boolean };

function useConnectionState(openSettings: () => void) {
  const [config, setConfig] = useState(readDriveConfig);
  const [connection, setConnection] = useState<Connection>();
  useEffect(() => {
    if (!connection) return;
    const timer = setTimeout(() => setConnection(current => current === connection ? undefined : current),
      Math.max(0, connection.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [connection]);

  const applyConfig = (next?: DriveConfig) => {
    setConnection(undefined);
    setConfig(next ?? emptyDriveConfig);
    writeDriveConfig(next);
  };
  const invalidate = (token: string) => setConnection(current => current?.token === token ? undefined : current);
  const configured = validDriveConfig(config);
  const ready = !!connection?.writable && connection.expiresAt > Date.now();
  const statusText = ready ? "接続済み・保存先確認済み" : connection ? "接続済み・保存先の選択が必要" :
    configured ? "未接続" : "未設定";

  return { config, connection, applyConfig, setConnection, invalidate, configured, ready, statusText, openSettings };
}

const DriveContext = createContext<ReturnType<typeof useConnectionState> | null>(null);

export function DriveConnectionProvider({ children, openSettings }: { children: ReactNode; openSettings: () => void }) {
  return <DriveContext.Provider value={useConnectionState(openSettings)}>{children}</DriveContext.Provider>;
}

export function useDriveConnection() {
  const drive = useContext(DriveContext);
  if (!drive) throw new Error("DriveConnectionProvider is required");
  return drive;
}
