// アプリ設定の永続化(localStorage)。API キーもここに含まれるが、
// 保存先は端末内のみで、送信先は Google の Gemini API に限られる。

import { DEFAULT_PROMPT_CONFIG, type PromptConfig } from "./prompt";
import type { DspOptions } from "./audio/dsp";

const KEY = "podcast-br-settings";

export interface Settings {
  apiKey: string;
  model: string;
  prompt: PromptConfig;
  dsp: DspOptions;
  /** 配信用MP3をモノラルで書き出すか。トーク番組はモノラルが標準で、処理も約1.7倍速い。 */
  mono: boolean;
  bitrate: number;
  /** 告知画像のアクセント色。番組の見た目を揃えるために保存する。 */
  accentColor: string;
  /**
   * 前回入力した出演者。次の回の初期値にするためだけに持つ。
   * 顔ぶれは回ごとに変わるので、設定ではなく「この前はこうだった」の控え。
   */
  lastCast?: string;
  /**
   * 最後に保存した時刻。
   * 控えを戻すときに、手元と控えのどちらが新しいかを決めるのに使う。
   */
  savedAt?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "gemini-3.5-flash",
  prompt: DEFAULT_PROMPT_CONFIG,
  dsp: {
    highPass: true,
    noiseReduction: true,
    trimSilence: false,
    perChannelNoise: false,
    levelSpeech: true,
  },
  mono: true,
  bitrate: 96,
  accentColor: "#ffd400",
  lastCast: "",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings> & { showContext?: string };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // v1 では showContext がトップレベルにあったため、prompt 配下へ引き継ぐ
      prompt: {
        ...DEFAULT_PROMPT_CONFIG,
        ...(parsed.showContext ? { showContext: parsed.showContext } : {}),
        ...parsed.prompt,
      },
      dsp: { ...DEFAULT_SETTINGS.dsp, ...parsed.dsp },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 中身だけを、並び順に左右されない形で文字列にする。
 * 「本当に変わったか」を見るためのものなので、鍵と時刻は外す。
 */
function fingerprint(s: Partial<Settings>): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => k !== "apiKey" && k !== "savedAt")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, stable(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(stable(s));
}

/**
 * 設定を保存する。
 *
 * savedAt は「**中身が変わった**時刻」にする。書いた時刻にすると、
 * アプリを開くたびに走る保存だけで新しくなってしまい、控えを戻すときの
 * 「どちらが新しいか」の判定が必ず手元の勝ちになる。実際それで、
 * 端末を替えた直後という**いちばん戻したい場面**で設定が戻らなかった。
 *
 * 何も決めていない状態(既定のまま)は時刻を持たせない。まっさらな端末では
 * 控えのほうが必ず新しいものとして扱われる。
 */
export function saveSettings(settings: Settings): void {
  const next = fingerprint(settings);
  let savedAt: number | undefined;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const prev = JSON.parse(raw) as Partial<Settings>;
      savedAt = fingerprint(prev) === next ? prev.savedAt : Date.now();
    } else {
      savedAt = next === fingerprint(DEFAULT_SETTINGS) ? undefined : Date.now();
    }
  } catch {
    savedAt = Date.now();
  }
  localStorage.setItem(KEY, JSON.stringify({ ...settings, savedAt }));
}

/**
 * 控えに載せてよい設定。
 *
 * **APIキーは絶対に入れない。** 控えはメールや Drive に載せて別の端末へ運ぶ
 * ものなので、鍵が同じ袋に入っていると、ファイルが漏れた時点で鍵も漏れる。
 * キーは各端末で入れ直す(無料で再発行もできる)。
 */
export type PortableSettings = Omit<Settings, "apiKey">;

export function portableSettings(settings: Settings): PortableSettings {
  const { apiKey: _apiKey, ...rest } = settings;
  return rest;
}
