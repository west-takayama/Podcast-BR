import { useState, useSyncExternalStore } from "react";
import { clearTimings, getTimings, subscribeToTimings, type TimingStage } from "../lib/timing";

const labels: Record<TimingStage, string> = {
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
  const report = ["AI STUDIO 2.1 処理時間", ...timings.map(entry => {
    const details = [
      entry.success ? "完了" : "未完了",
      entry.attempt === undefined ? "" : `試行 ${entry.attempt}`,
      entry.status === undefined ? "" : `HTTP ${entry.status}`,
    ].filter(Boolean).join(" / ");
    return `${labels[entry.stage]} (${entry.stage})  ${entry.durationMs} ms  ${details}`;
  })].join("\n");

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
      {timings.length > 0 ? (
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
