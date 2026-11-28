import { useBudgetState } from "./BudgetNotice";
import { useState, type FormEvent } from "react";
import { summarize, validExchange, type BillingMode, type BudgetState, type LedgerEntry } from "./ledger";
import { japanDay, japanMonth, maximumCost, rateFor, pricingChecked, pricingSource, scale, supportedPaidModels } from "./pricing";
import { recordActual, updateBudget } from "./store";

const jpy = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 4 });
const yen = (amount: number) => jpy.format(amount / scale);
const time = (at: number) => new Date(at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const localDateTime = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 16);
const stateNames: Record<LedgerEntry["state"], string> = {
  pending: "予約中", unknown: "未確定", estimated: "推定済み", cache: "端末内再利用",
  free: "無料設定", unpriced: "見積もり情報不足", "no-charge": "非課金と判明",
};
const purposes: Record<string, string> = {
  analysis: "番組分析", captions: "字幕", spotify: "Spotify文面", transcript: "全文", metadata: "番組情報",
  topics: "次の回", analytics: "経営分析", models: "モデル一覧", upload: "音声送信", activation: "音声準備の確認",
};
const expense = (value: string, allowNegative = false) =>
  value.trim() !== "" && Number.isFinite(Number(value)) && (allowNegative || Number(value) >= 0) && Math.abs(Number(value)) <= 1_000_000;
const amount = (value: string) => Math.round(Number(value) * scale);

export default function BudgetPanel() {
  const { state, unavailable } = useBudgetState();
  if (unavailable) return <section className="card"><h2>予算管理</h2><p role="alert">台帳を開けません。サイトデータ設定とストレージをご確認ください。</p></section>;
  if (!state) return <p role="status">予算台帳を読み込んでいます…</p>;
  return <BudgetView state={state} />;
}

function BudgetView({ state }: { state: BudgetState }) {
  const { settings } = state;
  const totals = summarize(state);
  const [mode, setMode] = useState<BillingMode>(settings.mode);
  const [fx, setFx] = useState(settings.usdJpy ? String(settings.usdJpy) : "");
  const [tax, setTax] = useState(String(settings.taxPercent));
  const [margin, setMargin] = useState(String(settings.fxMarginPercent));
  const [planned, setPlanned] = useState(String(settings.planned / scale));
  const [balance, setBalance] = useState(settings.balance ? String(settings.balance.amount / scale) : "");
  const [cost, setCost] = useState("");
  const [costLabel, setCostLabel] = useState("");
  const [costDate, setCostDate] = useState(japanDay(Date.now()));
  const [selectedMonth, setMonth] = useState(totals.month);
  const [invoice, setInvoice] = useState("");
  const [through, setThrough] = useState(localDateTime(Date.now()));
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState("");
  const [previewModel, setPreviewModel] = useState(supportedPaidModels[0]);
  const previewRate = rateFor(previewModel, Date.now());
  const preview = previewRate && validExchange(settings) ? maximumCost(previewRate, settings, true) : undefined;

  const commit = (event: FormEvent, change: (draft: BudgetState) => void) => {
    event.preventDefault();
    void updateBudget(change).then(() => setMessage("保存しました。"), error => {
      setMessage(error instanceof Error ? error.message : "端末に保存できませんでした。サイトデータ設定をご確認ください。");
    });
  };
  const saveSettings = (event: FormEvent) => commit(event, draft => {
    const exchange = { usdJpy: Number(fx), taxPercent: Number(tax), fxMarginPercent: Number(margin) };
    if ((mode !== "free" || fx) && !validExchange(exchange) || !expense(planned)) throw new Error("換算レート、税率、為替余裕、制作予定額を確認してください。");
    draft.settings = { ...draft.settings, ...exchange, mode, planned: amount(planned) };
  });
  const saveBalance = (event: FormEvent) => commit(event, draft => {
    if (!expense(balance, true)) throw new Error("前払い残高を円で入力してください。");
    draft.settings.balance = { amount: amount(balance), at: Date.now() };
  });
  const saveCost = (event: FormEvent) => commit(event, draft => {
    const at = Date.parse(`${costDate}T00:00:00+09:00`);
    if (!expense(cost) || !costLabel.trim() || !Number.isFinite(at)) throw new Error("運営費の項目名、日付、金額を確認してください。");
    draft.operating.push({ id: crypto.randomUUID(), at, label: costLabel.trim().slice(0, 100), amount: amount(cost) });
  });
  const saveActual = (event: FormEvent) => commit(event, draft => {
    const cutoff = Date.parse(`${through}:00+09:00`);
    if (!expense(invoice) || !Number.isFinite(cutoff) || cutoff > Date.now() || japanMonth(cutoff) !== selectedMonth) {
      throw new Error("実請求額と、対象月内の確認済み日時を入力してください。");
    }
    recordActual(draft, selectedMonth, Number(invoice), cutoff);
  });
  const report = selectedMonth === totals.month ? totals : summarize(state, Date.parse(`${selectedMonth}-01T00:00:00+09:00`));
  const rows = [...report.current].reverse();
  const daily = new Map<string, number>();
  const shown = showAll ? rows : rows.slice(0, 30);
  const months = [...new Set([totals.month, ...state.entries.map(entry => entry.month),
    ...state.operating.map(entry => japanMonth(entry.at)), ...Object.keys(state.actual)])].sort().reverse();
  const groups = new Map<string, number>();
  for (const entry of rows) {
    if (entry.estimate === undefined) continue;
    const day = japanDay(entry.at);
    daily.set(day, (daily.get(day) ?? 0) + entry.estimate);
    for (const group of [`用途 / ${purposes[entry.purpose] ?? entry.purpose}`,
      ...(entry.model ? [`モデル / ${entry.model}`] : []), ...(entry.episodeId ? [`回 / ${entry.episodeId}`] : [])]) {
      groups.set(group, (groups.get(group) ?? 0) + entry.estimate);
    }
    if (entry.attempt > 1 || entry.success === false) groups.set("失敗・再試行の推定費用", (groups.get("失敗・再試行の推定費用") ?? 0) + entry.estimate);
  }
  const credit = totals.balanceRemaining;
  const creditMessage = credit === undefined ? "残高を登録してください。"
    : credit < 300 * scale ? "300円未満です。次の制作予定に合わせてチャージを検討してください。"
    : credit < 500 * scale ? "300〜499円です。今後の制作予定を確認してください。"
    : "500円以上です。通常運用の目安です。";

  return <div className="budget-panel">
    <section className="card">
      <h2>予算管理</h2>
      <p>{totals.month}（日本時間） · 月間上限 2,000円</p>
      <dl>
        <dt>今日のGemini推定額（判明分）</dt><dd>{yen(totals.today)}</dd>
        <dt>今月のGemini推定額（判明分）</dt><dd>{yen(totals.estimated)}</dd>
        <dt>今月のGemini実請求・確認額</dt><dd>{totals.actual ? `${yen(totals.actual.amount)}（${time(totals.actual.through)}まで）` : "未登録"}</dd>
        <dt>今月のその他の運営費</dt><dd>{yen(totals.operating)}</dd>
        <dt>通信中の予約・未確定（過去月分を含む）</dt><dd>{yen(totals.pending)} / {yen(totals.unknown)}</dd>
        <dt>月間残予算の目安</dt><dd>{yen(totals.remaining)}</dd>
      </dl>
      {totals.warned && <p role="status">予算判断額が1,600円以上です。</p>}
      {totals.unpriced > 0 && <p>金額未確認の要求が{totals.unpriced}件あります。</p>}
      <p role="status">{message}</p>
    </section>
    <details className="card fold">
      <summary>課金方式・換算条件・制作予定</summary>
      <form onSubmit={saveSettings}>
        <label>課金方式
          <select value={mode} onChange={event => setMode(event.target.value as BillingMode)}>
            <option value="free">無料プロジェクト（既定）</option>
            <option value="prepaid">前払い</option>
            <option value="postpaid">後払い</option>
          </select>
        </label>
        <p>Google AI Studioでプロジェクトの課金方式を確認してください。この設定を保存してもGoogle側の契約・課金は変更されません。</p>
        <label>1米ドルあたりの円<input type="number" inputMode="decimal" min="0" max="1000" step="any" value={fx} onChange={e => setFx(e.target.value)} /></label>
        <label>税率（%）<input type="number" inputMode="decimal" min="0" max="100" step="any" value={tax} onChange={e => setTax(e.target.value)} /></label>
        <label>為替の余裕（%）<input type="number" inputMode="decimal" min="0" max="100" step="any" value={margin} onChange={e => setMargin(e.target.value)} /></label>
        <label>これからの制作予定額（円）<input type="number" inputMode="decimal" min="0" step="any" value={planned} onChange={e => setPlanned(e.target.value)} /></label>
        <button type="submit">予算条件を保存</button>
      </form>
      <p>保存済みの設定 {settings.mode === "free" ? "無料" : settings.mode === "prepaid" ? "前払い" : "後払い"} · {settings.usdJpy || "未設定"}円/USD</p>
      <label>最大費用を確認するモデル
        <select value={previewModel} onChange={e => setPreviewModel(e.target.value)}>
          {supportedPaidModels.map(model => <option key={model}>{model}</option>)}
        </select>
      </label>
      <p>音声を含む標準生成1回の最大予約額 {preview === undefined ? "換算条件を保存してください。" : yen(preview)}</p>
      <p><a href={pricingSource} target="_blank" rel="noreferrer">Gemini公式料金（USD、{pricingChecked}確認）</a></p>
    </details>
    {settings.mode === "prepaid" && <section className="card">
      <h3>前払い残高</h3>
      <p>残高の目安 {credit === undefined ? "不明" : yen(credit)}。{creditMessage}</p>
      {settings.balance && <p>手動確認 {yen(settings.balance.amount)} · {time(settings.balance.at)}（日本時間）</p>}
      {settings.planned > (credit ?? 0) && <p role="alert">制作予定額が残高の目安を超えます。{settings.balance && `不足の目安は ${yen(settings.planned - (credit ?? 0))} です。`}</p>}
      <form onSubmit={saveBalance}>
        <label>確認したチャージ残高（円）<input type="number" inputMode="decimal" step="any" value={balance} onChange={e => setBalance(e.target.value)} /></label>
        <button type="submit">残高を登録</button>
      </form>
      <p><a href="https://aistudio.google.com/spend" target="_blank" rel="noreferrer">Google AI Studioで確認</a></p>
    </section>}
    {settings.mode === "postpaid" && <p className="card">後払いでは、確認済み請求額・予算残額・制作予定額で判断します。{settings.planned > totals.remaining && "制作予定額が残予算を超えています。"}</p>}
    <details className="card fold">
      <summary>運営費を登録</summary>
      <form onSubmit={saveCost}>
        <label>利用日（日本時間）<input type="date" value={costDate} onChange={e => setCostDate(e.target.value)} /></label>
        <label>項目名<input value={costLabel} maxLength={100} onChange={e => setCostLabel(e.target.value)} /></label>
        <label>金額（円）<input type="number" inputMode="decimal" min="0" step="any" value={cost} onChange={e => setCost(e.target.value)} /></label>
        <button type="submit">運営費を追加</button>
      </form>
      <ul>{state.operating.filter(item => japanMonth(item.at) === totals.month).map(item =>
        <li key={item.id}>{japanDay(item.at)} {item.label} {yen(item.amount)}</li>)}</ul>
    </details>
    <section className="card">
      <h3>利用台帳</h3>
      <label>対象月<select value={selectedMonth} onChange={e => { setMonth(e.target.value); setShowAll(false); }}>
        {months.map(month => <option key={month}>{month}</option>)}
      </select></label>
      <p>Gemini推定額 {yen(report.estimated)} / 実請求・確認額 {report.actual ? yen(report.actual.amount) : "未登録"} / その他 {yen(report.operating)}</p>
      <details className="fold">
        <summary>Google側の実請求・確認額を登録</summary>
        <form onSubmit={saveActual}>
          <label>対象月の確認済みGemini累計額（円）<input type="number" inputMode="decimal" min="0" step="any" value={invoice} onChange={e => setInvoice(e.target.value)} /></label>
          <label>この額で確認済みの日時（日本時間）<input type="datetime-local" value={through} onChange={e => setThrough(e.target.value)} /></label>
          <p>確認日時までの未確定分は、登録した累計額に含めて照合します。Google側で反映を確認してから登録してください。</p>
          <button type="submit">確認額を保存</button>
        </form>
      </details>
      {!!daily.size && <details className="fold"><summary>日別のGemini推定額</summary>
        <ul>{[...daily].map(([day, value]) => <li key={day}>{day} · {yen(value)}</li>)}</ul>
      </details>}
      {!!groups.size && <details className="fold"><summary>用途・モデル・エピソード別の推定額</summary>
        <ul>{[...groups].map(([name, value]) => <li key={name} style={{ overflowWrap: "anywhere" }}>{name} · {yen(value)}</li>)}</ul>
      </details>}
      {rows.length ? <details className="fold" open><summary>要求と再利用の記録（{rows.length}件）</summary>
        <ol className="budget-rows">{shown.map(entry => <li key={entry.id}>
          <strong>{purposes[entry.purpose] ?? entry.purpose} · {stateNames[entry.state]}</strong>
          <br />{time(entry.at)} {entry.model ?? ""}
          <br />{entry.estimate === undefined ? `費用未確定${entry.reserved ? `（最大 ${yen(entry.reserved)}）` : ""}` : yen(entry.estimate)}
          {entry.attempt ? ` · 試行 ${entry.attempt}` : ""} {entry.success === undefined ? "" : entry.success ? "· 応答成功" : "· 失敗"}
          <br />入力 {entry.inputTokens ?? "不明"}（音声 {entry.audioTokens ?? "不明"}）・出力 {entry.outputTokens ?? "不明"}・推論 {entry.thinkingTokens ?? "不明"}
          {entry.elapsedMs !== undefined && <><br />{entry.elapsedMs} ms {entry.status ? `· HTTP ${entry.status}` : ""} {entry.error}</>}
          {entry.rateVersion && <><br />{entry.rateVersion}</>}
          {entry.episodeId && <><br />回 {entry.episodeId}</>}
        </li>)}</ol>
        {rows.length > 30 && <button type="button" onClick={() => setShowAll(!showAll)}>{showAll ? "30件に戻す" : "すべて表示"}</button>}
      </details> : <p>この月の記録はありません。</p>}
    </section>
  </div>;
}
