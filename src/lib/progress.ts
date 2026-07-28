// 進捗と残り時間の共通定義。Worker とメインスレッドの両方から参照する。

export type Stage = "analyze" | "process" | "upload" | "generate";

export const STAGE_LABELS: Record<Stage, string> = {
  analyze: "音声を解析中",
  process: "整音・MP3変換中",
  upload: "音声をアップロード中",
  generate: "タイトル・説明文を生成中",
};

/**
 * 各段階が全体に占めるおおよその割合。実測(5分素材)に基づく初期値で、
 * 残り時間の推定はここから始めて経過時間で自己補正される。
 */
export const STAGE_WEIGHTS: Record<Stage, number> = {
  analyze: 0.12,
  process: 0.5,
  upload: 0.23,
  generate: 0.15,
};

const ORDER: Stage[] = ["analyze", "process", "upload", "generate"];

/** 段階内の進捗(0〜1)から全体の進捗(0〜1)を求める。 */
export function overallProgress(stage: Stage, fraction: number): number {
  let done = 0;
  for (const s of ORDER) {
    if (s === stage) break;
    done += STAGE_WEIGHTS[s];
  }
  return Math.min(0.999, done + STAGE_WEIGHTS[stage] * Math.max(0, Math.min(1, fraction)));
}

/**
 * 残り時間の推定。実測の進み具合から全体所要時間を外挿する。
 * 端末性能も回線速度も事前にはわからないので、固定の係数ではなく
 * 「ここまでに何秒でどれだけ進んだか」から毎回引き直す。
 */
export function estimateRemainingMs(elapsedMs: number, progress: number): number | null {
  if (progress <= 0.02 || elapsedMs < 1500) return null; // 序盤は当てにならないので出さない
  const total = elapsedMs / progress;
  return Math.max(0, total - elapsedMs);
}

export function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}秒`;
  if (m >= 10) return `${m}分`;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}
