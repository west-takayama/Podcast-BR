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
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "gemini-2.5-flash",
  prompt: DEFAULT_PROMPT_CONFIG,
  dsp: { highPass: true, noiseReduction: true, trimSilence: false },
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
