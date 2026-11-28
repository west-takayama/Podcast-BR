import { useEffect, useRef, useState } from "react";
import { useDriveConnection } from "../../components/DriveConnection";
import { CANDIDATE_FOLDER_URL } from "../../lib/driveSave";
import { useBudgetState } from "../budget/BudgetNotice";
import { summarize } from "../budget/ledger";
import { scale } from "../budget/pricing";
import { withDeadline } from "../../lib/deadline";
import { listCandidates, verifiedVideo } from "./drive";
import {
  accounts, approve, beginHandoff, destinations, draftKey, emptyPublisher, freeLimit, makeDraft, monthOf, planner,
  proposal, quota, reconcile, type Candidate, type Delivery, type Destination, type Draft, type PublisherState, type Status,
} from "./model";
import { publisherTransaction } from "./store";

const labels: Record<Status, string> = {
  candidate: "投稿候補", review: "承認待ち", approved: "承認済み", sending: "予約処理中・引き渡し準備済み",
  scheduled: "予約済み", published: "投稿済み", failed: "失敗・未登録確認済み", cancelled: "取消済み", unknown: "結果不明",
};
const date = (at: number) => new Date(at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

export default function PublisherPanel() {
  const drive = useDriveConnection();
  const budget = useBudgetState().state;
  const [state, setState] = useState<PublisherState>(emptyPublisher);
  const [selected, setSelected] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ url: string; filename: string; key: string }>();
  const [handoff, setHandoff] = useState<Delivery>();
  const [external, setExternal] = useState("");
  const [quotaMonth, setQuotaMonth] = useState(() => monthOf(Date.now()));
  const [result, setResult] = useState<Record<number, string>>({});
  const controller = useRef<AbortController>();
  const previewUrl = useRef("");
  const mounted = useRef(true);
  const draft = state.drafts[current];
  const used = quota(state, quotaMonth);

  const clearPreview = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    setPreview(undefined);
    setHandoff(undefined);
  };
  const refresh = () => publisherTransaction(false, data => data).then(data => { if (mounted.current) setState(data); });
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => setMessage("端末の投稿台帳を読み込めません。"));
    return () => { mounted.current = false; controller.current?.abort(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    clearPreview();
  }, [drive.connection?.token]);

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (controller.current) return;
    const job = new AbortController();
    controller.current = job;
    setBusy(true);
    setMessage("");
    try { await action(job.signal); }
    catch (error) { if (!job.signal.aborted && mounted.current) setMessage(error instanceof Error ? error.message : "処理に失敗しました。"); }
    finally { if (controller.current === job) controller.current = undefined; if (mounted.current) setBusy(false); }
  };
  const update = async (action: (data: PublisherState) => void) => {
    await publisherTransaction(true, action);
    await refresh();
  };
  const edit = (patch: (previous: Draft) => Draft) => void run(async () => {
    clearPreview();
    await update(data => {
      const previous = data.drafts[current];
      data.drafts[current] = { ...patch(previous), state: "candidate" };
    });
  });
  const importCandidates = () => void run(async signal => {
    if (!drive.connection) throw new Error("設定からGoogle Driveに接続してください。");
    const { candidates, skipped } = await withDeadline(signal, 120_000, deadline => listCandidates(drive.connection!.token, deadline));
    await update(data => {
      for (const candidate of candidates) {
        const key = draftKey(candidate);
        const previous = data.drafts[key];
        if (!previous) data.drafts[key] = makeDraft(candidate);
        else if (JSON.stringify(previous.candidate) !== JSON.stringify(candidate)) data.drafts[key] = { ...previous, candidate, state: "candidate" };
      }
    });
    setMessage(`投稿候補 ${candidates.length}件を確認しました。${skipped ? ` 対応を確認できなかった ${skipped}件は対象外です。` : ""}`);
  });
  const openVideo = (candidate: Candidate, signal: AbortSignal) => {
    if (!drive.connection) throw new Error("動画の確認にはGoogle Driveへの接続が必要です。");
    return withDeadline(signal, 120_000, deadline => verifiedVideo(candidate, drive.connection!.token, deadline));
  };
  const showVideo = (blob: Blob, candidate: Candidate) => {
    clearPreview();
    const url = URL.createObjectURL(blob);
    previewUrl.current = url;
    setPreview({ url, filename: candidate.filename, key: draftKey(candidate) });
  };
  const prepare = (network: Destination) => void run(async signal => {
    if (!draft) return;
    const { blob, digest } = await openVideo(draft.candidate, signal);
    signal.throwIfAborted();
    const item = await publisherTransaction(true, data => {
      if (JSON.stringify(data.drafts[current]) !== JSON.stringify(draft)) throw new Error("候補が変更されました。内容を確認し直してください。");
      return beginHandoff(data, current, network, digest, Date.now());
    });
    signal.throwIfAborted();
    showVideo(blob, draft.candidate);
    setHandoff(item);
    await refresh();
  });
  const selectedForReview = selected.length > 0 && selected.every(key => state.drafts[key]?.state === "review");

  return <div className="publisher">
    <section className="card">
      <h2>投稿管理</h2>
      <p>承認した版を確認し、動画と文面をMetricool Plannerへ手動で渡します。日付・時刻は日本時間です。</p>
      <div className="row-buttons">
        <button type="button" disabled={busy || !drive.connection} onClick={importCandidates}>Driveから投稿候補を取得</button>
        {!drive.connection && <button type="button" onClick={drive.openSettings}>Google Drive連携を開く</button>}
      </div>
      <p><a href={CANDIDATE_FOLDER_URL} target="_blank" rel="noreferrer">非公開の投稿候補フォルダ</a></p>
      <p role="status">{busy ? "確認・保存中…" : message}</p>
    </section>
    <section className="card">
      <h3>無料投稿枠</h3>
      <label>対象月<input type="month" value={quotaMonth} onChange={event => setQuotaMonth(event.target.value)} /></label>
      <p>{used} / {freeLimit} 件（投稿先ごとに1件として仮集計）</p>
      <label>Metricool側で確認した台帳外の枠使用数
        <input type="number" min="0" max="1000" step="1" value={external || String(state.other[quotaMonth] ?? 0)}
          onChange={event => setExternal(event.target.value)} />
      </label>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        const count = Number(external || state.other[quotaMonth] || 0);
        if (!/^\d{4}-\d{2}$/.test(quotaMonth) || !Number.isInteger(count) || count < 0 || count > 1000) throw new Error("対象月と使用数を確認してください。");
        await update(data => { data.other[quotaMonth] = count; });
        setExternal("");
      })}>枠使用数を保存</button>
      <p>無料ルートの追加固定費は0円。{budget ? `月間残予算の目安は ${Math.floor(summarize(budget).remaining / scale).toLocaleString("ja-JP")}円です。` : ""}実際の枠はPlannerで確認してください。</p>
    </section>
    <section className="card">
      <h3>投稿候補</h3>
      {!Object.keys(state.drafts).length && <p>Driveから候補を取得してください。</p>}
      {Object.entries(state.drafts).map(([key, item]) => <div className="row-buttons" key={key}>
        <label className="check"><input type="checkbox" disabled={busy || item.state !== "review"} checked={selected.includes(key)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(value => value !== key))} />
          {item.candidate.title} · {labels[item.state]}</label>
        <button type="button" disabled={busy} onClick={() => { clearPreview(); setCurrent(key); }}>版 {item.candidate.versionId.slice(0, 8)} を開く</button>
      </div>)}
      <button type="button" disabled={busy || !selectedForReview} onClick={() => void run(async signal => {
        for (const key of selected) await openVideo(state.drafts[key].candidate, signal);
        signal.throwIfAborted();
        await update(data => {
          for (const key of selected) {
            if (JSON.stringify(data.drafts[key]) !== JSON.stringify(state.drafts[key])) throw new Error("別の画面で候補が変更されました。開き直してください。");
          }
          approve(data, selected, Date.now());
        });
        setSelected([]);
        setMessage("選んだ版を承認しました。");
      })}>選択した候補を一括承認</button>
    </section>
    {draft && <section className="card">
      <h3>{draft.candidate.title} · {labels[draft.state]}</h3>
      <p>動画の版 {draft.candidate.versionId.slice(0, 12)}</p>
      <button type="button" disabled={busy || !drive.connection} onClick={() => void run(async signal => {
        const { blob } = await openVideo(draft.candidate, signal);
        signal.throwIfAborted();
        showVideo(blob, draft.candidate);
      })}>非公開動画をプレビュー</button>
      {preview?.key === current && <video controls playsInline preload="metadata" src={preview.url} />}
      <div className="row-buttons">{[false, true].map(spread => <button type="button" key={String(spread)} disabled={busy} onClick={() => {
        const suggested = proposal(Date.now(), spread);
        edit(previous => ({ ...previous, plan: Object.fromEntries(destinations.filter(network => previous.plan[network]).map(network =>
          [network, { ...previous.plan[network], at: suggested.slots[network] }])) }));
      }}>{spread ? "分散" : "同時"}の提案を適用（{proposal(Date.now(), spread).measured ? "Metricool参考" : "仮時刻"}）</button>)}</div>
      <fieldset disabled={busy}>
        <legend>SNS別の投稿情報</legend>
        {destinations.map(network => {
          const copy = draft.plan[network];
          const change = (key: "title" | "text" | "hashtags" | "at", value: string) => {
            setHandoff(undefined);
            void update(data => {
              const item = data.drafts[current];
              if (!item.plan[network]) return;
              item.plan[network] = { ...item.plan[network]!, [key]: value };
              item.state = "candidate";
            }).catch(() => setMessage("投稿情報を保存できませんでした。"));
          };
          return <div key={network} className="publisher-network">
            <label className="check"><input type="checkbox" checked={!!copy} onChange={event => {
              const checked = event.target.checked;
              edit(previous => {
                const plan = { ...previous.plan };
                if (checked) plan[network] = makeDraft(previous.candidate).plan[network];
                else delete plan[network];
                return { ...previous, plan };
              });
            }} />{accounts[network]}</label>
            {copy && <>
              {network === "youtube" && <>
                <label>タイトル<input key={current + network + copy.title} defaultValue={copy.title} onBlur={event => {
                  if (copy.title !== event.target.value) change("title", event.target.value);
                }} /></label>
                <label>子ども向け<select value={draft.audience ?? ""} onChange={event => {
                  const value = event.target.value;
                  edit(previous => ({ ...previous, audience: value === "yes" || value === "no" ? value : undefined }));
                }}><option value="">選択してください</option><option value="yes">はい</option><option value="no">いいえ</option></select></label>
              </>}
              <label>投稿文<textarea defaultValue={copy.text} key={current + network + copy.text} onBlur={event => {
                if (copy.text !== event.target.value) change("text", event.target.value);
              }} /></label>
              <label>ハッシュタグ<input defaultValue={copy.hashtags} key={current + network + copy.hashtags} onBlur={event => {
                if (copy.hashtags !== event.target.value) change("hashtags", event.target.value);
              }} /></label>
              <label>予約日時（日本時間）<input type="datetime-local" defaultValue={copy.at} key={current + network + copy.at} onBlur={event => {
                if (copy.at !== event.target.value) change("at", event.target.value);
              }} /></label>
              {draft.state === "approved" && <button type="button" disabled={!drive.connection} onClick={() => prepare(network)}>引き渡しを準備 · {accounts[network]}</button>}
            </>}
          </div>;
        })}
      </fieldset>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await update(data => {
          const item = data.drafts[current];
          item.state = item.state === "candidate" ? "review" : "candidate";
        });
        setSelected(previous => previous.filter(key => key !== current));
        setHandoff(undefined);
      })}>{draft.state === "candidate" ? "承認待ちにする" : "承認・申請を取り消す"}</button>
      {handoff && preview && <div className="publisher-network">
        <h4>{accounts[handoff.destination]} の引き渡し</h4>
        <p>{handoff.copy.at.replace("T", " ")}（日本時間）{handoff.destination === "youtube" && ` · 子ども向け ${handoff.audience === "yes" ? "はい" : "いいえ"}`}</p>
        <p>候補 {handoff.copy.title}</p>
        {handoff.destination === "youtube" && <label>コピー用タイトル<input readOnly value={handoff.copy.title} /></label>}
        <label>コピー用投稿情報<textarea readOnly value={[handoff.copy.text, handoff.copy.hashtags].filter(Boolean).join("\n\n")} /></label>
        <div className="row-buttons">
          <a href={preview.url} download={preview.filename}>承認済み動画を保存</a>
          <a href={planner} target="_blank" rel="noreferrer">Metricool Plannerを開く</a>
        </div>
        <p>Plannerで投稿先・時刻・承認を確認して予約し、下の履歴で外部結果を記録してください。</p>
      </div>}
    </section>}
    <section className="card">
      <h3>予約・投稿履歴</h3>
      {state.deliveries.map((item, index) => <div className="publisher-network" key={index}>
        <strong>{accounts[item.destination]} · {labels[item.state]}</strong>
        <p>候補の版 {item.versionId.slice(0, 12)} · {item.copy.at.replace("T", " ")} JST</p>
        {item.reference && <p>外部ID {item.reference}</p>}
        {item.note && <p>確認内容 {item.note}</p>}
        {["sending", "scheduled", "unknown"].includes(item.state) && <>
          <label>外部IDまたはPlannerで確認した結果<input value={result[index] ?? ""}
            onChange={event => setResult(previous => ({ ...previous, [index]: event.target.value }))} /></label>
          <p>結果不明の場合は、Plannerと投稿先を確認してから未登録・取消を記録してください。</p>
          <div className="row-buttons">
            {(["scheduled", "published", "failed", "cancelled", "unknown"] as const).filter(outcome => outcome !== "failed" || item.state !== "scheduled")
              .map(outcome => <button type="button" disabled={busy} key={outcome} onClick={() => void run(async () => {
                await update(data => reconcile(data, index, outcome, result[index] ?? "", Date.now()));
                setHandoff(undefined);
              })}>{labels[outcome]}を記録</button>)}
          </div>
        </>}
      </div>)}
      {!!state.audit.length && <details><summary>操作記録（{state.audit.length}件）</summary>
        <ul>{state.audit.map((item, index) => <li key={index}>{date(item.recordedAt)} · {accounts[item.destination]} · {labels[item.state]}</li>)}</ul>
      </details>}
    </section>
  </div>;
}
