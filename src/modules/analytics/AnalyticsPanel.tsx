import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { episodeIndex } from "../../lib/history";
import { readProductionMetrics } from "../../lib/productionMetrics";
import { readBudget } from "../budget/store";
import { publisherTransaction } from "../publisher/store";
import { podcastTransaction } from "../publisher/podcast/store";
import { day, dayStart, metrics, parseImport, platforms, topics, validate, type Row } from "./model";
import { labels, makeReport, markdown, periodText, valueText, type Inputs } from "./report";
import { importAnalytics, readAnalytics } from "./store";
import { suggest } from "./suggest";

const yen = (value: number | null) => value === null ? "未取得" : valueText(value) + "円";
const percentage = (value: number | null) => value === null ? "未取得" : valueText(100 * value) + "%";

function save(text: string, extension: string, name = "週次経営報告") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: extension === "json" ? "application/json" : "text/markdown;charset=utf-8" }));
  link.download = "BRIDGE-RADIO-" + name + "-" + day(Date.now()) + "." + extension;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
}

export default function AnalyticsPanel({ apiKey, model }: { apiKey: string; model: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [inputs, setInputs] = useState<Inputs>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [data, setData] = useState("");
  const [filter, setFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(12);
  const [platform, setPlatform] = useState<Row["platform"]>("spotify");
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [asking, setAsking] = useState(false);
  const request = useRef<AbortController>();
  const today = day(Date.now());
  const yesterday = day(dayStart(today) - 1);

  useEffect(() => {
    let active = true;
    void Promise.all([
      readAnalytics(), episodeIndex(),
      publisherTransaction(false, state => ({ ...state, audit: [] })),
      podcastTransaction(false, entries => entries.map(({ cover, ...entry }) => entry)),
      readBudget(), readProductionMetrics(dayStart(day(Date.now())) - 70 * 86_400_000),
    ]).then(([saved, episodes, sns, podcast, budget, timings]) => {
      if (active) { setRows(saved); setInputs({ episodes, sns, podcast, budget, timings }); }
    }).catch(() => { if (active) setError("端末の台帳を読み込めません。サイトデータの利用設定と空き容量を確認してください。"); });
    return () => { active = false; request.current?.abort(); };
  }, []);

  const report = useMemo(() => inputs ? makeReport(rows, inputs) : undefined, [rows, inputs]);
  async function ingest(read: () => Promise<Row[]> | Row[]) {
    setBusy(true); setError(""); setMessage(""); setSuggestion("");
    try {
      const added = await read();
      const result = await importAnalytics(added);
      setRows(result.rows);
      setMessage(`${result.changed}件を登録・更新しました（入力${added.length}件）。`);
    } catch (reason) { setError(reason instanceof Error && !(reason instanceof SyntaxError) && !(reason instanceof DOMException)
      ? reason.message : "読込に失敗しました。JSONの構文、ファイル形式、端末の保存設定を確認してください。"); }
    finally { setBusy(false); }
  }
  function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void ingest(() => {
      const metric = String(fields.get("metric"));
      const value = String(fields.get("value") ?? "");
      const posted = String(fields.get("posted") ?? "");
      return [validate({ platform, metric, definition: "manual-" + metric, source: "manual",
        quality: value.trim() ? fields.get("quality") : "missing", value: value.trim() ? Number(value) : null,
        unit: metric.endsWith("Minutes") ? "min" : "count", start: fields.get("start"), end: fields.get("end"), acquiredAt: new Date().toISOString(),
        ...(fields.get("entity") ? { entity: fields.get("entity") } : {}), ...(fields.get("topic") ? { topic: fields.get("topic") } : {}),
        ...(posted ? { postedAt: new Date(posted + ":00+09:00").toISOString() } : {}) })];
    });
  }

  if (!report) return <section className="card"><h2>経営ダッシュボード</h2><p role="status">{error || "端末の台帳を読み込んでいます…"}</p></section>;
  const { activities, windows, production, requestStats, finance, delivery } = report;
  const shown = report.metrics.filter(row => !filter || row.platform === filter);
  const ask = async () => {
    if (request.current || !apiKey) return;
    const controller = new AbortController();
    request.current = controller;
    setAsking(true); setSuggestion(""); setError("");
    try { setSuggestion(await suggest(report, apiKey, model, controller.signal)); }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "AI分析に失敗しました。"); }
    finally {
      request.current = undefined;
      if (!controller.signal.aborted) {
        setAsking(false);
        void readBudget().then(budget => setInputs(current => current && { ...current, budget })).catch(() => {});
      } else setAsking(false);
    }
  };

  return <div className="analytics">
    <section className="card">
      <h2>経営ダッシュボード</h2>
      <p className="muted">日本時間の確定日まで。配信件数は端末の確認記録から集計します。</p>
      <div className="analytics-summary">
        {([["week", "今週"], ["previousWeek", "前週の同日数"], ["month", "今月の比較期間"], ["previousMonth", "前月の同日数"]] as const).map(([key, title]) =>
          <article key={key}><strong>{title}</strong><small>{periodText(windows[key])}</small>
            <span>制作 {activities[key].episodes}件</span><span>確認 本編 {activities[key].podcasts}件／公開SNS {activities[key].shorts}件</span><span>非公開SNS {activities[key].privateConfirmations}件</span></article>)}
      </div>
      <h3>配信の確認・対応</h3>
      <p>SNS 確認待ち {delivery.confirmation}件／要対応 {delivery.needsAction}件／承認待ち {delivery.review}件</p>
      <p>本編 要照合 {delivery.podcastNeedsCheck}件</p>
    </section>

    <section className="card">
      <h2>媒体別・エピソード／投稿別の実績</h2>
      <p className="muted">SpotifyとMetricoolの数値は取り込み時点の記録です。指標の定義が同じ系列ごとに表示します。</p>
      <label>媒体<select value={filter} onChange={event => { setFilter(event.target.value); setVisibleCount(12); }}>
        <option value="">すべて</option>{platforms.map(item => <option key={item} value={item}>{labels[item]}</option>)}
      </select></label>
      {!shown.length && <p>この媒体の指標は未取得です。</p>}
      {shown.slice(0, visibleCount).map(row => <article className="analytics-series" key={JSON.stringify([row.platform, row.source, row.definition, row.entity, row.basis])}>
        <strong>{labels[row.platform]} · {labels[row.metric]}（{labels[row.unit]}）</strong>
        <small>{labels[row.source]} · {row.definition}{row.entity && " · " + row.entity}</small>
        {row.entity && <small>{row.episodeId ? "制作回 " + row.episodeId : row.candidateId ? "ショート候補 " + row.candidateId : row.platform === "studio" ? "制作ID " + row.entity : "該当する制作・配信履歴なし"}</small>}
        <small>最新取込の対象 {row.latest.start}〜{row.latest.end} · {valueText(row.latest.value)} · {labels[row.latest.quality]}</small>
        <small>取得 {new Date(row.acquiredAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST</small>
        <dl>
          {([["今週", row.week], ["前週", row.previousWeek], ["今月", row.month], ["前月", row.previousMonth]] as const).map(([label, record]) =>
            <div key={label}><dt>{label}</dt><dd>{valueText(record.value)}{record.value !== null && <small>{record.qualities.map(x => labels[x]).join("・")}</small>}</dd></div>)}
        </dl>
        {(row.weekChange !== null || row.monthChange !== null) && <small>
          前週差 {valueText(row.weekChange)} ／ 前月差 {valueText(row.monthChange)}（{labels[row.unit]}）
        </small>}
        {row.basis === "lifetime" && <small>公開以来の累積値。期間実績の集計対象外です。</small>}
        {row.recent.length > 1 && <details><summary>直近の推移（最大14期間）</summary>
          <ul>{row.recent.map(point => <li key={point.start + "/" + point.end}>{periodText(point)} · {valueText(point.value)} · {labels[point.quality]}</li>)}</ul>
        </details>}
      </article>)}
      {shown.length > visibleCount && <button onClick={() => setVisibleCount(count => count + 12)}>続きの指標を表示（残り {shown.length - visibleCount}件）</button>}
    </section>

    <section className="card">
      <h2>制作効率（今週）</h2>
      {production.map(row => <p key={row.label}>{row.label} · {row.minutes === null ? "未取得" : valueText(row.minutes) + "分／" + row.samples + "件、中央値 " + valueText(row.medianSeconds) + "秒"}</p>)}
      <p>Gemini要求 {requestStats.requests}件／失敗 {requestStats.errors}件／再試行 {requestStats.retries}件</p>
      <p>再利用 {requestStats.cached}件（{percentage(requestStats.reuseRate)}）／計測した端末処理の失敗 {requestStats.localErrors}件</p>
      <p className="muted">非公開AUDIOの作業時間と人間の操作時間は「AI STUDIO」の手動指標で登録できます。</p>
    </section>

    <section className="card">
      <h2>今月の予算</h2>
      <p>残予算 <strong>{yen(finance.remainingYen)}</strong>／上限 {yen(finance.limitYen)}（使用・確保率 {percentage(finance.utilization)}）</p>
      <p>Gemini実請求 {yen(finance.actualGeminiYen)}／台帳の推定 {yen(finance.estimatedGeminiYen)}</p>
      <p>登録済み運営費 {yen(finance.operatingYen)}／予約 {yen(finance.pendingYen)}／結果不明の確保 {yen(finance.unknownReservedYen)}</p>
      <p>失敗・再試行の既知推定 {yen(finance.failureRetryEstimatedYen)}／未確定・未算出 {finance.unresolved}件</p>
      <details><summary>制作回ごとのGemini費用</summary>{finance.costByEpisode.length
        ? finance.costByEpisode.map(item => <p key={item.episodeId}>{item.episodeId} · {yen(item.estimatedYen)}（未確定・未算出 {item.unresolved}件）</p>)
        : <p>エピソードに紐づいた費用は未取得です。</p>}</details>
    </section>

    <section className="card">
      <h2>次回企画と制作の振り返り</h2>
      <ul>{report.recommendations.map(item => <li key={item}>{item}</li>)}</ul>
      <details><summary>Geminiで追加分析</summary>
        <p className="muted">実行時に期間別集計を送信します。個別のID、文章、音声は送信項目に含めません。設定された料金モードで予算を確認します。</p>
        <button disabled={!apiKey || asking} onClick={() => void ask()}>{asking ? "Geminiで分析中…" : "集計値を送って分析する"}</button>
        {asking && <button onClick={() => request.current?.abort()}>中断</button>}
        {!apiKey && <p>利用するには設定でGemini APIキーを登録してください。</p>}
        {suggestion && <p className="analytics-suggestion">{suggestion}</p>}
      </details>
    </section>

    <section className="card">
      <h2>週次経営会議向け報告</h2>
      <div className="row-buttons">
        <button onClick={() => save(markdown(report), "md")}>Markdownを保存</button>
        <button onClick={() => save(JSON.stringify(report, null, 2), "json")}>JSONを保存</button>
        <button onClick={() => void navigator.clipboard.writeText(markdown(report)).then(() => setMessage("報告をコピーしました。"), () => setError("コピーできません。Markdownを保存してください。"))}>報告をコピー</button>
      </div>
    </section>

    <section className="card">
      <h2>分析データの取り込み</h2>
      <p className="muted">共通JSON・CSVに整形した集計値を取り込めます。空欄は未取得として保持します。</p>
      <button onClick={() => save(JSON.stringify({ schema: "bridge-radio.analytics.v1", rows: [{
        platform: "spotify", source: "spotify-creators", quality: "missing", metric: "plays", definition: "spotify-plays",
        start: yesterday, end: yesterday, acquiredAt: new Date().toISOString(), unit: "count", value: null,
      }] }, null, 2), "json", "分析データ入力例")}>共通JSONの入力例を保存</button>
      <p><a href="https://support.spotify.com/ws/creators/article/downloading-your-shows-analytics-data/" target="_blank" rel="noreferrer">SpotifyのCSVエクスポート手順</a></p>
      <p><a href="https://help.metricool.com/faqs-about-the-metricool-mcp-1i3w0" target="_blank" rel="noreferrer">Metricool MCPの仕様</a></p>
      <fieldset disabled={busy}>
        <label>共通JSON・CSVファイル<input type="file" accept=".json,.csv,application/json,text/csv" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (file) void ingest(async () => { if (file.size > 1_000_000) throw new Error("1 MB以下のファイルを選んでください。"); return parseImport(await file.text()); });
        }} /></label>
        <label>共通JSON・CSVを貼り付け<textarea value={data} onChange={event => setData(event.target.value)} /></label>
        <button disabled={!data.trim()} onClick={() => void ingest(() => parseImport(data))}>貼り付けたデータを取り込む</button>
      </fieldset>
      <details><summary>手動で指標を登録</summary>
        <form onSubmit={manual}>
          <fieldset disabled={busy}>
            <label>対象媒体<select value={platform} onChange={e => setPlatform(e.target.value as Row["platform"])}>
              {platforms.map(item => <option value={item} key={item}>{labels[item]}</option>)}</select></label>
            <label>指標<select name="metric" key={platform}>{metrics.filter(item => item.endsWith("Minutes") === (platform === "studio"))
              .map(item => <option value={item} key={item}>{labels[item]}</option>)}</select></label>
            <label>対象開始日（JST）<input type="date" name="start" required defaultValue={yesterday} /></label>
            <label>対象終了日（JST）<input type="date" name="end" required defaultValue={yesterday} /></label>
            <label>数値（件・分。空欄は未取得）<input type="number" name="value" step="any" /></label>
            <label>値の種類<select name="quality"><option value="manual">手動入力</option><option value="estimated">推定</option></select></label>
            <label>エピソード・投稿ID（任意）<input name="entity" maxLength={100} autoCapitalize="none" /></label>
            <label>企画分類（任意）<select name="topic"><option value="">未設定</option>{topics.map(item => <option key={item}>{item}</option>)}</select></label>
            <label>投稿日時（任意、JST）<input type="datetime-local" name="posted" /></label>
            <button>指標を保存</button>
          </fieldset>
        </form>
      </details>
    </section>
    <div className="analytics-status" aria-live="polite">{error ? <p role="alert">{error}</p> : message ? <p role="status">{message}</p> : null}</div>
  </div>;
}
