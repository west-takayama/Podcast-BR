import { useEffect, useRef, useState } from "react";
import { editedKey, type ProductionSession } from "../../../core/productionSession";
import { readProductionEntry } from "../../../lib/history";
import { blobDigest } from "../../../lib/driveSave";
import { localDate } from "../model";
import { approvePodcast, canEdit, creatorsUrl, emptyMetadata, newPodcast, podcastVersion,
  recordPodcast, revoke, revise, startHandoff, type PodcastEntry, type PodcastStatus } from "./model";
import { existingCopy, existingCover, podcastTransaction } from "./store";

const labels: Record<PodcastStatus, string> = {
  draft: "準備中", approved: "承認済み", handoff: "引き渡し済み・要照合", "spotify-draft": "Spotifyの下書きあり",
  scheduled: "予約確認済み", published: "配信確認済み", unknown: "結果不明", absent: "未登録を確認済み",
};
const outcomes = ["spotify-draft", "scheduled", "published", "unknown", "absent"] as const;

async function readEditedMp3(session: ProductionSession, signal: AbortSignal) {
  const asset = session.edited;
  const file = await readProductionEntry<File>(editedKey(session.id));
  if (!file || !asset || !/\.mp3$/i.test(asset.file.name) || !file.size) throw new Error("AUDIOで編集済みのMP3を取り込んでください。");
  const header = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  if (!(header[0] === 73 && header[1] === 68 && header[2] === 51) && !(header[0] === 255 && (header[1] & 0xe0) === 0xe0)) {
    throw new Error("MP3形式を確認できません。AUDIOのMP3を書き出し直してください。");
  }
  const digest = await blobDigest(file, signal);
  if (digest !== await blobDigest(asset.file, signal)) throw new Error("保存済み音源が更新されました。制作を開き直して確認してください。");
  return { file, revision: asset.id, digest };
}

export default function PodcastPanel({ session, openAudio }: { session?: ProductionSession; openAudio: () => void }) {
  const [rows, setRows] = useState<PodcastEntry[]>();
  const [selected, setSelected] = useState(session?.id ?? "");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void podcastTransaction(false, data => data).then(data => {
      if (active) { setRows(data); if (!session) setSelected(data[data.length - 1]?.episodeId ?? ""); }
    }).catch(() => { if (active) setMessage("配信台帳を読み込めませんでした。"); });
    return () => { active = false; };
  }, [session?.id]);
  useEffect(() => { if (session) setSelected(session.id); }, [session?.id]);
  const entry = rows?.find(row => row.episodeId === selected);
  const source = session?.id === selected ? session : undefined;
  return <div className="publisher">
    <section className="card">
      <h2>Spotify 本編配信</h2>
      <p>既存の番組へ引き渡す配信素材と確認記録を管理します。</p>
      {!session?.edited && <button type="button" onClick={openAudio}>AUDIOで編集済みMP3を取り込む</button>}
      <p role="status">{message}</p>
      {!!rows?.length && <label>配信の記録<select value={selected} onChange={e => setSelected(e.target.value)}>
        {session && !rows.some(row => row.episodeId === session.id) && <option value={session.id}>現在の制作</option>}
        {rows.map(row => <option key={row.episodeId} value={row.episodeId}>
          {row.metadata.number ? `第${row.metadata.number}回 ` : ""}{row.metadata.title || "制作中"} · {labels[row.status]}
        </option>)}
      </select></label>}
    </section>
    {rows && selected && (source || entry) && <PodcastEditor
      key={selected + ":" + (source?.edited?.id ?? "")} id={selected} initial={entry} session={source}
      openAudio={openAudio} onRows={setRows} />}
  </div>;
}

function PodcastEditor({ id, initial, session, onRows, openAudio }: {
  id: string; initial?: PodcastEntry; session?: ProductionSession; onRows: (rows: PodcastEntry[]) => void; openAudio: () => void;
}) {
  const [entry, setEntry] = useState<PodcastEntry>(() => initial ?? newPodcast(id, emptyMetadata(), Date.now()));
  const [metadata, setMetadata] = useState(entry.metadata);
  const [cover, setCover] = useState(entry.cover);
  const [coverUrl, setCoverUrl] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [handoff, setHandoff] = useState<{ files: File[]; audio: string }>();
  const [checker, setChecker] = useState("");
  const [checked, setChecked] = useState(false);
  const [outcome, setOutcome] = useState<(typeof outcomes)[number]>("unknown");
  const [evidence, setEvidence] = useState("");
  const [checkedResult, setCheckedResult] = useState(false);
  const [spotifyId, setSpotifyId] = useState(entry.spotifyId ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController>();
  const handoffUrl = useRef("");
  const dirty = JSON.stringify(metadata) !== JSON.stringify(entry.metadata) || cover?.revision !== entry.cover?.revision;
  const editable = canEdit(entry.status);
  const currentApproval = entry.status === "approved" && entry.approval?.audioRevision === session?.edited?.id;
  const hasResult = ["handoff", "unknown", "spotify-draft", "scheduled"].includes(entry.status);
  useEffect(() => {
    if (initial || !session) return;
    let active = true;
    void existingCopy(session).then(copy => {
      if (active && copy) setMetadata(current => ({
        ...current, title: current.title || copy.title, description: current.description || copy.description,
      }));
    }).catch(() => { if (active) setMessage("保存済みの文面を読み込めませんでした。"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!cover) { setCoverUrl(""); return; }
    const url = URL.createObjectURL(cover.blob);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);
  useEffect(() => {
    if (!session?.edited?.file) { setAudioUrl(""); return; }
    const url = URL.createObjectURL(session.edited.file);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [session?.edited?.file]);
  useEffect(() => () => { abort.current?.abort(); if (handoffUrl.current) URL.revokeObjectURL(handoffUrl.current); }, []);

  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setMessage("");
    try { await work(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "処理に失敗しました。"); }
    finally { if (!controller.signal.aborted) setBusy(false); abort.current = undefined; }
  };
  const update = async (change: (row: PodcastEntry, all: PodcastEntry[]) => void) => {
    const { row, all } = await podcastTransaction(true, entries => {
      const saved = entries.find(item => item.episodeId === id);
      if (saved && podcastVersion(saved) !== podcastVersion(entry)) throw new Error("別の画面で変更されました。配信画面を開き直してください。");
      const row = saved ?? newPodcast(id, emptyMetadata(), entry.updatedAt);
      change(row, entries);
      if (!saved) entries.push(row);
      return { row, all: entries };
    });
    setEntry(row); setMetadata(row.metadata); setCover(row.cover);
    onRows(all);
  };
  const selectCover = async (blob: Blob, name?: string) => {
    if (!blob.size || !["image/jpeg", "image/png"].includes(blob.type)) throw new Error("JPEGかPNGを選択してください。");
    const bitmap = await createImageBitmap(blob);
    const square = bitmap.width === bitmap.height;
    bitmap.close();
    if (!square) throw new Error("正方形のエピソード画像を選んでください。");
    setCover({ blob, filename: name || (blob.type === "image/png" ? "episode-cover.png" : "episode-cover.jpg"), revision: crypto.randomUUID() });
    setChecked(false);
  };
  const copyText = (text: string) => void navigator.clipboard.writeText(text).then(() => setMessage("コピーしました。"),
    () => setMessage("表示中の文面を長押ししてコピーしてください。"));
  const shareFiles = (files: File[]) => {
    void navigator.share({ files }).catch(error => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage("共有できませんでした。ファイルを個別に保存してください。");
    });
  };
  const showHandoff = (file: File) => {
    const artwork = entry.cover!;
    const audio = new File([file], session!.edited!.file.name, { type: "audio/mpeg" });
    const image = new File([artwork.blob], artwork.filename, { type: artwork.blob.type });
    if (handoffUrl.current) URL.revokeObjectURL(handoffUrl.current);
    handoffUrl.current = URL.createObjectURL(audio);
    setHandoff({ files: [audio, image], audio: handoffUrl.current });
  };
  const canPrepare = !!session?.edited && currentApproval && !dirty;

  return <>
    <section className="card">
      <h3>配信パッケージ · {labels[entry.status]}</h3>
      <p role="status">{busy ? "確認・保存中…" : message}</p>
      {audioUrl && <div><p>編集済み音源 {session?.edited?.file.name}</p><audio controls preload="metadata" src={audioUrl} /></div>}
      {!session?.edited && <p>この回の編集済み音源は現在の制作にありません。</p>}
      {coverUrl && <img src={coverUrl} alt="エピソードのカバー画像" width={160} height={160} />}
      <fieldset disabled={busy || !editable}>
        <legend>エピソード情報</legend>
        <label>エピソード番号<input inputMode="numeric" value={metadata.number} onChange={e => setMetadata({ ...metadata, number: e.target.value })} /></label>
        <label>タイトル<input value={metadata.title} onChange={e => setMetadata({ ...metadata, title: e.target.value })} /></label>
        <label>説明文<textarea aria-label="説明文" value={metadata.description} onChange={e => setMetadata({ ...metadata, description: e.target.value })} /></label>
        <label>配信予定日時（日本時間）<input type="datetime-local" value={metadata.plannedAt} onChange={e => setMetadata({ ...metadata, plannedAt: e.target.value })} /></label>
        <button type="button" disabled={!session} onClick={() => void run(async () => {
          if (!session) return;
          const copy = await existingCopy(session);
          if (!copy) throw new Error("この回に保存済みのタイトルと説明文がありません。");
          setMetadata(current => ({ ...current, ...copy })); setChecked(false);
        })}>同じ回の保存済み文面を読み込む</button>
        <label>カバー画像（正方形JPEG・PNG）<input type="file" accept="image/jpeg,image/png" onChange={e => {
          const file = e.target.files?.[0]; e.target.value = "";
          if (file) void run(() => selectCover(file, file.name));
        }} /></label>
        <button type="button" onClick={() => void run(async () => {
          const saved = await existingCover();
          if (!saved) throw new Error("端末に登録済みの画像がありません。");
          await selectCover(saved.blob);
        })}>端末の登録済み画像を使う</button>
        <button type="button" onClick={() => void run(async () => {
          await update(row => revise(row, metadata, cover, Date.now()));
          setMessage("端末に保存しました。");
        })}>配信準備を保存</button>
      </fieldset>
      {dirty && <p>編集内容を保存すると、以前の承認は解除されます。</p>}
      {editable && <>
        {!session?.edited && <button type="button" onClick={openAudio}>音声を用意する</button>}
        <label>承認者<input maxLength={80} value={checker} onChange={e => setChecker(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />音源・文面・カバー・番号・配信日時を確認しました</label>
        <button type="button" disabled={busy || dirty || !checked || !session?.edited} onClick={() => void run(async signal => {
          if (!session) return;
          const { revision, digest } = await readEditedMp3(session, signal);
          signal.throwIfAborted();
          await update(row => approvePodcast(row, checker, revision, digest, Date.now()));
          setChecked(false);
          setMessage("配信パッケージを承認しました。");
        })}>配信パッケージを承認</button>
      </>}
      {entry.approval && <p>承認者 {entry.approval.by} · {localDate(entry.approval.at).replace("T", " ")} JST</p>}
      {entry.status === "approved" && <div className="row-buttons">
        <button type="button" disabled={busy || !canPrepare} onClick={() => void run(async signal => {
          if (!session) return;
          const { file, revision, digest } = await readEditedMp3(session, signal);
          signal.throwIfAborted();
          await update((row, all) => startHandoff(row, all, revision, digest, Date.now()));
          signal.throwIfAborted();
          showHandoff(file);
        })}>承認済み素材を引き渡す</button>
        <button type="button" disabled={busy} onClick={() => void run(() => update(row => revoke(row, Date.now())))}>承認を取り消す</button>
      </div>}
      {entry.status === "approved" && !currentApproval && <p>音源が変更されました。配信前に改めて承認してください。</p>}
    </section>
    {entry.status === "handoff" && !handoff && session?.edited && <section className="card">
      <button type="button" disabled={busy} onClick={() => void run(async signal => {
        const { file, revision, digest } = await readEditedMp3(session, signal);
        const same = await podcastTransaction(false, rows => {
          const saved = rows.find(row => row.episodeId === id);
          return saved && podcastVersion(saved) === podcastVersion(entry) && saved.approval?.audioRevision === revision && saved.approval.digest === digest;
        });
        signal.throwIfAborted();
        if (!same || !entry.cover) throw new Error("引き渡し済みの承認版を確認できません。");
        showHandoff(file);
      })}>引き渡し済みの素材を確認する</button>
    </section>}
    {handoff && entry.status === "handoff" && <section className="card">
      <h3>承認済みの配信素材</h3>
      <p>{entry.metadata.plannedAt.replace("T", " ")} JST · 第{entry.metadata.number}回</p>
      <div className="row-buttons">
        <button type="button" onClick={() => copyText(entry.metadata.title)}>タイトルをコピー</button>
        <button type="button" onClick={() => copyText(entry.metadata.description)}>説明文をコピー</button>
        <a href={handoff.audio} download={handoff.files[0].name}>編集済みMP3を保存</a>
        {coverUrl && <a href={coverUrl} download={entry.cover?.filename}>カバーを保存</a>}
        {navigator.canShare?.({ files: [handoff.files[0]] }) && <button type="button" onClick={() => shareFiles([handoff.files[0]])}>MP3を共有</button>}
        {navigator.canShare?.({ files: [handoff.files[1]] }) && <button type="button" onClick={() => shareFiles([handoff.files[1]])}>カバーを共有</button>}
        {navigator.canShare?.({ files: handoff.files }) && <button type="button" onClick={() => shareFiles(handoff.files)}>MP3とカバーをまとめて共有</button>}
      </div>
      <p>Spotify for Creatorsで既存の番組を選び、音源・文面・カバーを確認して予定日時を設定してください。公開操作は個別承認を得た担当者が行います。</p>
    </section>}
    {hasResult && <section className="card">
      <h3>Spotifyで配信結果を照合</h3>
      <p><a href={creatorsUrl} target="_blank" rel="noreferrer">Spotify for Creatorsを開く</a></p>
      <p>結果が分からない場合は既存エピソード一覧を調べてください。未登録を確認するまで同じ回の引き渡しは再開できません。</p>
      <label>確認した状態<select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}>
        {outcomes.map(value => <option key={value} value={value}>{labels[value]}</option>)}
      </select></label>
      <label>SpotifyエピソードID<input value={spotifyId} onChange={e => setSpotifyId(e.target.value)} /></label>
      <label>確認内容<textarea aria-label="確認内容" maxLength={500} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={checkedResult} onChange={e => setCheckedResult(e.target.checked)} />Spotifyのエピソード一覧で照合しました</label>
      <button type="button" disabled={busy || !checkedResult} onClick={() => void run(async () => {
        await update((row, all) => recordPodcast(row, all, outcome, evidence, spotifyId.trim(), Date.now()));
        setEvidence(""); setCheckedResult(false); setHandoff(undefined);
        if (handoffUrl.current) URL.revokeObjectURL(handoffUrl.current);
        handoffUrl.current = "";
        if (outcome === "absent") setSpotifyId("");
      })}>照合結果を記録</button>
    </section>}
    {!!entry.history.length && <section className="card">
      <h3>配信履歴</h3>
      {entry.spotifyId && <p>SpotifyエピソードID {entry.spotifyId}</p>}
      <ol>{entry.history.map((item, index) => <li key={index}>{localDate(item.at).replace("T", " ")} JST · {labels[item.status]}{item.evidence ? ` · ${item.evidence}` : ""}</li>)}</ol>
    </section>}
  </>;
}
