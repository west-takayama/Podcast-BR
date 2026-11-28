import { estimatedCost, japanDay, japanMonth, limit, maximumCost, rateFor, warning, type Exchange, type UsageCounts } from "./pricing";

export type RequestInfo = {
  purpose: string;
  model?: string;
  episodeId?: string;
  attempt: number;
  hasAudio?: boolean;
  usesTools?: boolean;
  requestKey?: string;
  operationId?: string;
};

export type BillingMode = "free" | "prepaid" | "postpaid";
export type BudgetSettings = Exchange & {
  mode: BillingMode;
  balance?: { amount: number; at: number };
  planned: number;
};

export type LedgerEntry = Omit<RequestInfo, "requestKey"> & UsageCounts & {
  id: string;
  at: number;
  month: string;
  mode: BillingMode;
  state: "pending" | "unknown" | "estimated" | "cache" | "free" | "unpriced" | "no-charge";
  rateVersion?: string;
  reserved: number;
  estimate?: number;
  elapsedMs?: number;
  finishedAt?: number;
  status?: number;
  success?: boolean;
  error?: string;
  requestKey?: string;
  exchange?: Exchange;
  rate?: ReturnType<typeof rateFor>;
};

type Actual = { amount: number; at: number; through: number };
type OperatingCost = { id: string; at: number; amount: number; label: string };
export type BudgetState = {
  settings: BudgetSettings;
  entries: LedgerEntry[];
  operating: OperatingCost[];
  actual: Record<string, Actual>;
};

export class BudgetError extends Error {
  constructor(message: string) { super(message); this.name = "BudgetError"; }
}

export function emptyBudget(): BudgetState {
  return { settings: { mode: "free", usdJpy: 0, taxPercent: 10, fxMarginPercent: 5, planned: 0 },
    entries: [], operating: [], actual: {} };
}

export function summarize(state: BudgetState, now = Date.now()) {
  const month = japanMonth(now);
  const day = japanDay(now);
  const actual = state.actual[month];
  const current = state.entries.filter(entry => entry.month === month);
  const estimated = current.reduce((sum, entry) => sum + (entry.estimate ?? 0), 0);
  const today = current.filter(entry => japanDay(entry.at) === day)
    .reduce((sum, entry) => sum + (entry.estimate ?? 0), 0);
  // Pending requests never expire automatically, even across month boundaries.
  const pending = state.entries.filter(entry => entry.state === "pending")
    .reduce((sum, entry) => sum + entry.reserved, 0);
  const latestActivity = (entry: LedgerEntry) => entry.finishedAt ?? entry.at;
  const outstanding = (entry: LedgerEntry) => entry.state === "unknown" &&
    latestActivity(entry) > (state.actual[entry.month]?.through ?? -1);
  const unknown = state.entries.filter(outstanding).reduce((sum, entry) => sum + entry.reserved, 0);
  const operating = state.operating.filter(item => japanMonth(item.at) === month).reduce((sum, item) => sum + item.amount, 0);
  const sinceActual = current.filter(entry => actual && latestActivity(entry) > actual.through)
    .reduce((sum, entry) => sum + (entry.estimate ?? 0), 0);
  const basis = actual ? Math.max(estimated, actual.amount + sinceActual) : estimated;
  const total = basis + operating + pending + unknown;
  const balance = state.settings.balance;
  const balanceRemaining = balance && Math.max(0, balance.amount - state.entries
    .filter(entry => entry.state === "pending" || outstanding(entry) || latestActivity(entry) > balance.at)
    .reduce((sum, entry) => sum + (entry.state === "unknown" || entry.state === "pending" ? entry.reserved : entry.estimate ?? 0), 0));
  return { month, current, estimated, today, operating, pending, unknown, actual, total,
    remaining: Math.max(0, limit - total), warned: total >= warning, balanceRemaining,
    unpriced: current.filter(entry => entry.state === "unpriced").length };
}

export function beginRequest(state: BudgetState, info: RequestInfo, id: string, at: number): LedgerEntry {
  const { settings } = state;
  const rate = info.model && rateFor(info.model, at);
  const metered = !!info.model;
  const earlierAttempts = info.operationId ? state.entries.filter(entry => entry.operationId === info.operationId).length : 0;
  const attempt = Math.max(info.attempt, earlierAttempts + 1);
  let reserved = 0;
  if (settings.mode !== "free" && metered) {
    if (!rate || info.usesTools) throw new BudgetError("料金の上限を見積もれないモデル・追加ツールです。予算管理で対応モデルを確認してください。");
    if (attempt > 4) throw new BudgetError("有料処理の試行上限（4回）に達しました。");
    if (!validExchange(settings)) throw new BudgetError("予算管理で換算レート・税率・為替余裕を設定してください。");
    const totals = summarize(state, at);
    reserved = maximumCost(rate, settings, !!info.hasAudio);
    if (reserved > totals.remaining) throw new BudgetError("最大費用を加えると月間予算2,000円を超える可能性があります。保存済みの成果物は引き続き利用できます。");
    if (settings.mode === "prepaid" && (totals.balanceRemaining === undefined || reserved > totals.balanceRemaining)) {
      throw new BudgetError("手動確認したチャージ残高が不足しています。予算管理で残高を確認してください。");
    }
  }
  if (info.requestKey && state.entries.some(entry => entry.requestKey === info.requestKey && entry.state === "pending" && at - entry.at < 10 * 60_000)) {
    throw new BudgetError("同じGemini要求が別の処理で実行中です。完了後に再確認してください。");
  }
  const entry: LedgerEntry = { ...info, attempt, id, at, month: japanMonth(at), mode: settings.mode, reserved,
    state: "pending", rate: rate || undefined, rateVersion: rate ? rate.version : undefined,
    exchange: reserved ? { usdJpy: settings.usdJpy, taxPercent: settings.taxPercent, fxMarginPercent: settings.fxMarginPercent } : undefined };
  state.entries.push(entry);
  return entry;
}

export type RequestResult = { elapsedMs: number; status?: number; error?: string; billing?: "none" | "input-only" };
export function finishRequest(entry: LedgerEntry, counts: UsageCounts, result: RequestResult, finishedAt = entry.at) {
  const { billing, ...observation } = result;
  Object.assign(entry, counts, observation, { finishedAt });
  delete entry.requestKey;
  entry.success = entry.status !== undefined && entry.status >= 200 && entry.status < 300 && !entry.error;
  if (!entry.model || billing === "none" || (entry.status !== undefined && entry.status >= 400 && entry.status <= 599)) {
    entry.state = "no-charge";
    entry.estimate = 0;
    return;
  }
  const rate = entry.rate;
  if (entry.mode === "free") {
    entry.state = rate && counts.inputTokens !== undefined && counts.outputTokens !== undefined ? "free" : "unpriced";
    entry.estimate = rate && counts.inputTokens !== undefined && counts.outputTokens !== undefined ? 0 : undefined;
    return;
  }
  const billed = billing === "input-only" ? { ...counts, outputTokens: 0, thinkingTokens: 0 } : counts;
  const cost = rate && entry.exchange && estimatedCost(rate, billed, entry.exchange, !!entry.hasAudio);
  entry.state = cost === undefined ? "unknown" : "estimated";
  entry.estimate = cost;
}

export function validExchange(value: Exchange) {
  return Number.isFinite(value.usdJpy) && value.usdJpy > 0 && value.usdJpy <= 1000 &&
    Number.isFinite(value.taxPercent) && value.taxPercent >= 0 && value.taxPercent <= 100 &&
    Number.isFinite(value.fxMarginPercent) && value.fxMarginPercent >= 0 && value.fxMarginPercent <= 100;
}
