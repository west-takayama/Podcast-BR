// 「次に話すこと」の持ち回り。
//
// お題を考えるのと、実際に収録するのは別の日になる。考えた案は
// 画面を閉じれば消えるので、収録の直前に「何を話すんだっけ」と
// 探し直すことになっていた。**決めたら持ち回る**ようにする。
//
// 置き場は localStorage。数百文字の text で、端末の中だけにあればよい。

const KEY = "podcast-br-plan";

export interface Plan {
  title: string;
  hook: string;
  angles: string[];
  savedAt: number;
}

export function loadPlan(): Plan | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Plan>;
    if (typeof p?.title !== "string" || !p.title.trim()) return null;
    return {
      title: p.title,
      hook: typeof p.hook === "string" ? p.hook : "",
      angles: Array.isArray(p.angles) ? p.angles.filter((a): a is string => typeof a === "string") : [],
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function savePlan(plan: Omit<Plan, "savedAt">): Plan {
  const full: Plan = { ...plan, savedAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(full));
  } catch {
    // 容量が無くても致命的ではない。画面には出ている
  }
  return full;
}

export function clearPlan(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 消せなくても実害はない
  }
}

/** 収録メモとして読める1つの文にする。コピーして相方に送れるように。 */
export function planAsText(plan: Plan): string {
  return [
    plan.title,
    plan.hook && `「${plan.hook}」`,
    ...plan.angles.map((a) => `- ${a}`),
  ]
    .filter(Boolean)
    .join("\n");
}
