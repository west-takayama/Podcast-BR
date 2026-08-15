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
  /** イラスト生成に使うモデル。一覧から自動で選ぶ。 */
  imageModel: string;
  /**
   * 前回入力した出演者。次の回の初期値にするためだけに持つ。
   * 顔ぶれは回ごとに変わるので、設定ではなく「この前はこうだった」の控え。
   */
  lastCast?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "gemini-3.5-flash",
  prompt: DEFAULT_PROMPT_CONFIG,
  dsp: { highPass: true, noiseReduction: true, trimSilence: false, perChannelNoise: false },
  mono: true,
  bitrate: 96,
  accentColor: "#ffd400",
  imageModel: "",
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

export function saveSettings(settings: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
