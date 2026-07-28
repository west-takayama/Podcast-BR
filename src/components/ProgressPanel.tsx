import { STAGE_LABELS, formatDuration, type Stage } from "../lib/progress";
import { ScreenWakeLock } from "../lib/wakeLock";

interface Props {
  fileInfo: string;
  stage: Stage;
  overall: number; // 0〜1
  remainingMs: number | null;
  detail: string;
  onCancel: () => void;
}

const ORDER: Stage[] = ["analyze", "process", "upload", "generate"];

export default function ProgressPanel({
  fileInfo,
  stage,
  overall,
  remainingMs,
  detail,
  onCancel,
}: Props) {
  const currentIndex = ORDER.indexOf(stage);
  const percent = Math.round(overall * 100);

  return (
    <div className="card">
      <h2>処理中: {fileInfo}</h2>

      <div className="eta">
        <div className="eta-percent">{percent}%</div>
        <div className="eta-remaining">
          {remainingMs === null ? "残り時間を計測中…" : `残り約 ${formatDuration(remainingMs)}`}
        </div>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>

      <ul className="steps">
        {ORDER.map((s, i) => (
          <li key={s} className={i < currentIndex ? "done" : i === currentIndex ? "active" : ""}>
            {i < currentIndex ? "✓" : i === currentIndex ? "▶" : "・"} {STAGE_LABELS[s]}
            {i === currentIndex && detail && ` (${detail})`}
          </li>
        ))}
      </ul>

      <p className="muted">
        {ScreenWakeLock.supported
          ? "処理中は画面が消えないようにしています。他のアプリに切り替えるとブラウザが一時停止するため、この画面を開いたままお待ちください。"
          : "他のアプリに切り替えるとブラウザが一時停止します。この画面を開いたままお待ちください。"}
      </p>

      <button onClick={onCancel}>キャンセル</button>
    </div>
  );
}
