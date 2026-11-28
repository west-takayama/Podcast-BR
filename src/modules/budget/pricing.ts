export const pricingSource = "https://ai.google.dev/gemini-api/docs/pricing";
export const pricingChecked = "2026-11-28";
export const currency = "USD";
export const scale = 1_000_000;
export const limit = 2_000 * scale;
export const warning = 1_600 * scale;

type Rate = {
  text: number;
  audio: number;
  output: number;
  cachedText: number;
  cachedAudio: number;
  version: string;
  inputLimit: number;
  outputLimit: number;
};

const standard: Record<string, [text: number, audio: number, output: number]> = {
  "gemini-3.8-flash": [0.75, 0.75, 3.75],
  "gemini-3.6-flash": [0.75, 0.75, 3.75],
  "gemini-3.5-flash-lite": [0.30, 0.30, 2.50],
  "gemini-3.1-flash-lite": [0.25, 0.50, 1.50],
  "gemini-2.5-flash": [0.30, 1.00, 2.50],
  "gemini-2.5-flash-lite": [0.10, 0.30, 0.40],
};

export const supportedPaidModels = Object.keys(standard);

const japanDate = (timestamp: number) => new Date(timestamp + 9 * 60 * 60 * 1_000).toISOString();
export const japanMonth = (timestamp: number) => japanDate(timestamp).slice(0, 7);
export const japanDay = (timestamp: number) => japanDate(timestamp).slice(0, 10);

export function rateFor(model: string, timestamp: number): Rate | undefined {
  const rates = Object.prototype.hasOwnProperty.call(standard, model) ? standard[model] : undefined;
  if (!rates) return;
  const future = (model === "gemini-3.8-flash" || model === "gemini-3.6-flash") && japanDay(timestamp) >= "2027-01-01";
  const [text, audio, output] = future ? [1.50, 1.50, 7.50] : rates;
  return { text, audio, output, cachedText: text / 10, cachedAudio: audio / 10, inputLimit: 1_048_576, outputLimit: 65_536,
    version: future ? "google-standard-2026-11-28/2027-01-01" : "google-standard-2026-11-28" };
}

export type Exchange = { usdJpy: number; taxPercent: number; fxMarginPercent: number };
export type UsageCounts = {
  inputTokens?: number;
  audioTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cachedTokens?: number;
  cachedAudioTokens?: number;
};

export function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function yenMicros(usdNumerator: number, exchange: Exchange) {
  return Math.ceil(usdNumerator * exchange.usdJpy * (1 + exchange.taxPercent / 100) * (1 + exchange.fxMarginPercent / 100));
}

export function estimatedCost(rate: Rate, counts: UsageCounts, exchange: Exchange, hasAudio: boolean) {
  const { inputTokens, audioTokens, outputTokens, thinkingTokens = 0, cachedTokens = 0, cachedAudioTokens } = counts;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const audio = hasAudio ? Math.min(audioTokens ?? inputTokens, inputTokens) : 0;
  const text = inputTokens - audio;
  const cached = Math.min(cachedTokens, inputTokens);
  // Without a cache modality breakdown, allocate the discount to the cheaper input first.
  const minAudio = Math.max(0, cached - text);
  const audioCache = Math.max(minAudio, Math.min(cachedAudioTokens ?? minAudio, audio, cached));
  const textCache = cached - audioCache;
  return yenMicros((text - textCache) * rate.text + (audio - audioCache) * rate.audio +
    textCache * rate.cachedText + audioCache * rate.cachedAudio + (outputTokens + thinkingTokens) * rate.output, exchange);
}

export function maximumCost(rate: Rate, exchange: Exchange, hasAudio: boolean) {
  // Reserve context at the highest applicable input rate, plus separate output and thinking allowances.
  const maximumInputRate = hasAudio ? Math.max(rate.text, rate.audio) : rate.text;
  return yenMicros(rate.inputLimit * maximumInputRate + 2 * rate.outputLimit * rate.output, exchange);
}
