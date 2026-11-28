import { geminiFetch, validateGeminiResponse } from "../../adapters/geminiObservability";
import { withDeadline } from "../../lib/deadline";
import type { makeReport } from "./report";

export async function suggest(report: ReturnType<typeof makeReport>, apiKey: string, setting: string, cancel: AbortSignal) {
  const model = setting.replace(/^models\//, "");
  if (!/^[a-z0-9][a-z0-9.-]{1,90}$/i.test(model) || !apiKey) throw new Error("設定のGeminiモデルとAPIキーを確認してください。");
  const payload = {
    windows: report.windows, activities: report.activities, production: report.production, requestStats: report.requestStats,
    accountMetrics: report.metrics.filter(row => !row.entity).slice(0, 40).map(({ platform, definition, week, previousWeek, month, previousMonth }) =>
      ({ platform, definition, week, previousWeek, month, previousMonth })),
  };
  return withDeadline(cancel, 40_000, async signal => {
    const response = await geminiFetch({ purpose: "analytics", model }, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, signal,
      body: JSON.stringify({ generationConfig: { maxOutputTokens: 1000 }, contents: [{ parts: [{
        text: "BRIDGE RADIOの制作を継続しやすくするため、集計値から次週の確認・改善案を短い日本語で最大3点挙げてください。欠損はゼロ扱いせず、指標を媒体間で合算せず、因果を断定せず、数値や発話を作らないでください。\n" + JSON.stringify(payload),
      }] }] }),
    });
    if (!response.ok) throw new Error(`Geminiが応答を返せませんでした（HTTP ${response.status}）。利用枠と設定を確認してください。`);
    return validateGeminiResponse(response, async () => {
      const result = await response.json();
      const candidate = result?.candidates?.[0];
      const text = candidate?.content?.parts?.find((part: { text?: string; thought?: boolean }) => typeof part.text === "string" && !part.thought)?.text;
      if (candidate?.finishReason !== "STOP" || typeof text !== "string" || !text.trim()) throw new Error("Geminiの分析が途中で終了しました。");
      return text.slice(0, 6000);
    });
  });
}
