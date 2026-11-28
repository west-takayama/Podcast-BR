import { useState, useSyncExternalStore } from "react";
import { clearTimings, getTimings, subscribeToTimings, type TimingStage } from "../lib/timing";

const labels: Record<TimingStage, string> = {
  "gemini-usage": "Gemini利用",
  "caption-response": "字幕応答",
  "caption-conversion": "字幕用音声の準備",
  "caption-audio-decode": "字幕照合用の音声デコード",
  "caption-alignment": "字幕タイミング補正",
  "video-export": "動画書き出し",
  "video-audio-decode": "書き出し用音声のデコード",
  "video-draw": "フレーム描画",
  "video-encode": "映像フレーム投入・待機",
  "video-audio-encode": "音声エンコード投入・待機",
  "video-finalize": "エンコード終了待ち・コンテナ確定",
  "video-blob": "動画ファイル生成",
  "drive-save": "Google Drive保存",
  conversion: "音声準備",
  upload: "音声送信",
  activation: "Geminiの音声解析待ち",
  "generation-request": "生成要求",
  "generation-and-parsing": "生成・応答の読み取り",
  "retry-wait": "再試行待ち",
  "metadata-total": "タイトル・概要欄生成全体",
  "result-display": "結果の表示",
};

export default function TimingDiagnostics() {
  const timings = useSyncExternalStore(subscribeToTimings, getTimings);
  const [message, setMessage] = useState("");
  const [probe, setProbe] = useState("");
  const checkEncoders = async () => {
    setProbe("確認中…");
    const video = async (height: 1280 | 1920, hardwareAcceleration: "prefer-hardware" | "no-preference") => {
      try {
        return (await VideoEncoder.isConfigSupported({
          width: height === 1280 ? 720 : 1080, height,
          codec: "avc1.640028", framerate: 30, bitrate: 3_000_000, hardwareAcceleration,
        })).supported ? "対応" : "非対応";
      } catch { return "利用不可"; }
    };
    let audio = "利用不可";
    try {
      audio = (await AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 1, bitrate: 128_000,
      })).supported ? "対応" : "非対応";
    } catch { /* WebCodecs may be absent on this device. */ }
    const [standard, standardHardware, light, lightHardware] = await Promise.all([
      video(1920, "no-preference"), video(1920, "prefer-hardware"),
      video(1280, "no-preference"), video(1280, "prefer-hardware"),
    ]);
    setProbe(`安全な接続: ${window.isSecureContext ? "はい" : "いいえ"} · AAC: ${audio}\n` +
      `H.264 1080p: ${standard} / ハードウェア優先: ${standardHardware}\n` +
      `H.264 720p: ${light} / ハードウェア優先: ${lightHardware}`);
  };
  const report = ["AI STUDIO 3.0 α3 処理時間", ...timings.map(entry => {
    const details = [
      entry.success ? "完了" : "未完了",
      entry.attempt === undefined ? "" : `試行 ${entry.attempt}`,
      entry.status === undefined ? "" : `HTTP ${entry.status}`,
      entry.errorType ?? "",
      entry.gemini ? [entry.gemini.purpose, entry.gemini.model, entry.gemini.source === "cache" ? "再利用・送信なし" : "通信",
        entry.gemini.inputTokens === undefined ? "" : `入力トークン ${entry.gemini.inputTokens}`,
        entry.gemini.outputTokens === undefined ? "" : `出力トークン ${entry.gemini.outputTokens}`,
        entry.gemini.thinkingTokens === undefined ? "" : `推論トークン ${entry.gemini.thinkingTokens}`,
        entry.gemini.cachedTokens === undefined ? "" : `キャッシュ済トークン ${entry.gemini.cachedTokens}`,
        entry.gemini.audioBytes === undefined ? "" : `音声 ${entry.gemini.audioBytes} B（符号化前）`].filter(Boolean).join(" · ") : "",
      entry.caption ? [entry.caption.model, entry.caption.structure, entry.caption.issue, entry.caption.finish,
        entry.caption.inputTokens === undefined ? "" : `入力トークン ${entry.caption.inputTokens}`,
        entry.caption.outputTokens === undefined ? "" : `出力トークン ${entry.caption.outputTokens}`].filter(Boolean).join(" · ") : "",
      entry.videoProfile ? `${entry.videoProfile.height}px縦・${entry.videoProfile.video}/${entry.videoProfile.audio}・${entry.videoProfile.seconds}秒` : "",
    ].filter(Boolean).join(" / ");
    return `${labels[entry.stage]} (${entry.stage})  ${entry.durationMs} ms  ${details}`;
  }), ...(probe ? [probe] : [])].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setMessage("処理時間をコピーしました。");
    } catch {
      setMessage("下の処理時間を長押しし、全選択してコピーしてください。");
    }
  };

  return (
    <details className="fold section-fold">
      <summary>処理時間の診断（{timings.length}件）</summary>
      <p className="muted">
        このタブの直近60件です。再読み込みすると消えます。工程の時間には重なりがあります。
        音声、生成文、APIキーは含みません。
      </p>
      <button type="button" disabled={probe === "確認中…"} onClick={() => void checkEncoders()}>端末のエンコード対応を確認</button>
      {probe && <p className="muted" role="status" style={{ whiteSpace: "pre-line" }}>{probe}</p>}
      {timings.length > 0 || probe ? (
        <>
          <div className="row-buttons">
            <button type="button" onClick={copy}>処理時間をコピー</button>
            <button type="button" onClick={() => { clearTimings(); setMessage(""); }}>計測をリセット</button>
          </div>
          <p role="status">{message}</p>
          <textarea aria-label="処理時間の記録" readOnly rows={8} value={report} />
        </>
      ) : <p className="muted">制作またはショートの処理後に表示されます。</p>}
    </details>
  );
}
