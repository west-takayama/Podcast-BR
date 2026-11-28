import { useState } from "react";
import type { ProductionAsset } from "../../core/productionAsset";
import { validateAudioOutput } from "../../core/productionAsset";
import { parseAudioEntry } from "./entry";

const KEY = "studio-alpha-audio-entry";

export default function AudioPanel({ original, edited, onImport, onCreate }: {
  original?: ProductionAsset;
  edited?: ProductionAsset;
  onImport: (file: File) => void;
  onCreate: () => void;
}) {
  const [address, setAddress] = useState(() => {
    try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
  });
  const [entry, setEntry] = useState(() => parseAudioEntry(address, location.origin));
  const [message, setMessage] = useState("");
  return <section className="card">
    <h2>AUDIO 音声制作</h2>
    <p>OP・タイトルコール・導入・EDの編集とMP3・WAVの出力は、認証付きAUDIOで行います。</p>
    <label>非公開AUDIOのURL
      <input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={address} onChange={event => setAddress(event.target.value)} />
    </label>
    <button type="button" onClick={() => {
      const next = parseAudioEntry(address, location.origin);
      if (address.trim() && !next) { setMessage("認証情報やクエリを含まない、別オリジンのHTTPS URLを入力してください。"); return; }
      setEntry(next);
      try {
        if (next) localStorage.setItem(KEY, next);
        else localStorage.removeItem(KEY);
        setMessage(next ? "この端末に入力先を保存しました。" : "接続先を消去しました。");
      } catch { setMessage("このページ内で接続先を利用できます。端末には保存できませんでした。"); }
    }}>接続先を保存</button>
    {entry && <p><a href={entry} target="_blank" rel="noopener noreferrer">認証付きAUDIOを開く</a></p>}
    {import.meta.env.MODE === "private" ? <label>完成した本編（MP3・WAV）を取り込む
      <input type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        if (!validateAudioOutput(file)) { setMessage("空でないMP3またはWAVを選んでください。"); return; }
        onImport(file);
        setMessage("本編を取り込みました。");
      }} />
    </label> : <p>完成音声の取り込みは認証付きの統合環境で行います。</p>}
    {(original || edited) && <div>
      {original && <p>分析・ショート用の原音 {original.file.name}</p>}
      {edited && <p>取り込み済みの編集済み本編 {edited.file.name}</p>}
      <button type="button" onClick={onCreate}>制作画面で確認する</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
