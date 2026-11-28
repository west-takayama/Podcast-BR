import { useEffect, useRef, useState } from "react";
import { blobDigest } from "../../lib/driveSave";
import { getEpisode } from "../../lib/history";
import type { Clip } from "../../lib/gemini";
import { readProductionCheckpoint, type ProductionSession } from "../../core/productionSession";
import { existingCover, podcastTransaction } from "../publisher/podcast/store";
import { fromJst } from "../publisher/model";
import { youtubeId, youtubeURL } from "./feature";
import Selection, { useFeature } from "./Selection";
import { getFeature, updateFeature } from "./store";
import type { VideoResolution } from "./longVideo";

type Result = { file: File; digest: string; url: string; duration: number; elapsed: number; height: VideoResolution; signature: string };
export default function FeaturePanel({ session, openAudio }: { session?: ProductionSession; openAudio: () => void }) {
  const id = session?.id;
  const editedRevision = session?.edited?.id;
  const feature = useFeature(id);
  const [clips, setClips] = useState<Clip[]>([]);
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [planned, setPlanned] = useState("");
  const [cover, setCover] = useState<Blob>();
  const [height, setHeight] = useState<VideoResolution>(360);
  const [result, setResult] = useState<Result>();
  const [confirm, setConfirm] = useState(false);
  const [reference, setReference] = useState("");
  const [checkedPublic, setCheckedPublic] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [codecUnavailable, setCodecUnavailable] = useState(false);
  const [related, setRelated] = useState("");
  const job = useRef<AbortController>();
  const resultRef = useRef<Result>();
  const keptFile = useRef<string>();
  const [savedUrl, setSavedUrl] = useState("");
  const release = () => {
    const previous = resultRef.current;
    if (!previous) return;
    URL.revokeObjectURL(previous.url);
    if (keptFile.current !== previous.file.name) void navigator.storage.getDirectory().then(dir => dir.removeEntry(previous.file.name)).catch(() => {});
    resultRef.current = undefined;
  };
  useEffect(() => {
    if (!id) return;
    let active = true;
    void Promise.all([podcastTransaction(false, rows => rows.find(row => row.episodeId === id)),
      readProductionCheckpoint(id, session?.original?.id), getEpisode(id), existingCover(), getFeature(id)]).then(([podcast, saved, archived, art, current]) => {
      if (!active) return;
      setClips(saved?.analysis?.clips ?? archived?.meta.clips ?? []);
      setTitle(current?.title || podcast?.metadata.title || archived?.chosenTitle || saved?.analysis?.copy?.titles[0] || "");
      setNumber(current?.number || podcast?.metadata.number || "");
      setPlanned(current?.plannedAt || podcast?.metadata.plannedAt || "");
      setCover(podcast?.cover?.blob ?? art?.blob);
    }).catch(() => { if (active) setNotice("既存の配信情報を読み込めません。手動で入力してください。"); });
    return () => { active = false; job.current?.abort(); release(); };
  }, [id, session?.edited?.id, session?.original?.id]);
  useEffect(() => {
    if (!feature) return;
    if (feature.title) setTitle(feature.title);
    if (feature.number) setNumber(feature.number);
    if (feature.plannedAt) setPlanned(feature.plannedAt);
    if (feature.youtubeId) setReference(feature.youtubeId);
  }, [feature?.episodeId, feature?.title, feature?.number, feature?.plannedAt, feature?.youtubeId]);

  useEffect(() => {
    const stored = feature?.approval;
    if (!stored?.file || (!feature?.handoff && stored.sourceRevision !== editedRevision) || (feature?.handoff && feature.handoff !== "pending") || !/^studio-feature-[a-f0-9-]+\.mp4$/.test(stored.file)) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const directory = await navigator.storage.getDirectory();
        const file = await (await directory.getFileHandle(stored.file!)).getFile();
        if (await blobDigest(file, controller.signal) !== stored.digest) throw new Error("版が一致しません。");
        controller.signal.throwIfAborted();
        url = URL.createObjectURL(file);
        setSavedUrl(url);
      } catch {
        if (!controller.signal.aborted) setNotice("承認済みのファイルをこの端末で開けません。保存済みの控えとYouTube Studioを照合してください。");
      }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); setSavedUrl(""); };
  }, [feature?.approval?.file, feature?.approval?.digest, feature?.approval?.sourceRevision, feature?.handoff, editedRevision]);

  const run = async (action: () => Promise<unknown>) => {
    setNotice("");
    try { await action(); } catch (error) {
      if (error instanceof DOMException && error.name === "NotSupportedError") setCodecUnavailable(true); setNotice(error instanceof DOMException && error.name === "QuotaExceededError"
      ? "端末の空き容量が足りません。空き容量を確保してから再試行してください。編集済み音源は保存されています。"
      : error instanceof Error ? error.message : "処理に失敗しました。"); }
  };
  if (!id || !feature) return <section className="card"><h2>YouTube本編</h2>
    <p>制作中のエピソードとAUDIOで編集済みの本編を準備してください。</p><button onClick={openAudio}>音声制作を開く</button></section>;

  const locked = !!feature.handoff;
  const signature = JSON.stringify([title.trim(), number.trim(), planned, height, editedRevision]);
  const resultMatches = result?.signature === signature;
  const handoffDigest = feature.approval?.sourceRevision !== editedRevision ? undefined : resultMatches && result?.digest === feature.approval?.digest ? result.digest : savedUrl ? feature.approval?.digest : undefined;
  const metadataMatches = title.trim() === feature.title && number.trim() === feature.number && planned === feature.plannedAt;
  function saveMetadata() {
    if (!title.trim() || title.trim().length > 100 || !/^[0-9]{1,6}$/.test(number.trim())) throw new Error("100文字以内の本編タイトルと回番号を入力してください。");
    if (!Number.isFinite(fromJst(planned))) throw new Error("本編配信予定の日本時間を入力してください。");
    return updateFeature(id!, row => {
      if (!row.selected || row.handoff) throw new Error("動画化の選抜・配信状態を確認してください。");
      const same = row.title === title.trim() && row.number === number.trim() && row.plannedAt === planned;
      return { ...row, title: title.trim(), number: number.trim(), plannedAt: planned, approval: same ? row.approval : undefined };
    });
  }
  async function generate() {
    if (!session?.edited || job.current) return;
    setCodecUnavailable(false);
    const controller = new AbortController();
    job.current = controller;
    setStage("音声とH.264・AACの対応を確認中");
    const started = performance.now();
    let outputStarted = false;
    try {
      await saveMetadata();
      controller.signal.throwIfAborted();
      setConfirm(false); setResult(undefined); release(); setProgress(0);
      outputStarted = true;
      const { generateLongVideo } = await import("./longVideo");
      const exported = await generateLongVideo({ file: session.edited.file, title: title.trim(), number: number.trim(), cover, height,
        signal: controller.signal, onProgress: fraction => { setProgress(fraction); setStage("本編動画を書き出しています"); } });
      const url = URL.createObjectURL(exported.file);
      const current = { ...exported, url, digest: "", elapsed: 0, height, signature };
      resultRef.current = current;
      current.digest = await blobDigest(exported.file, controller.signal);
      current.elapsed = performance.now() - started;
      setResult(current);
    } catch (error) {
      if (outputStarted) release();
      if (controller.signal.aborted) setNotice("書き出しを中断しました。");
      else throw error;
    } finally { job.current = undefined; setStage(""); }
  }
  return <div className="publisher">
    <Selection feature={feature} clips={clips} />
    {feature.selected && <section className="card">
      <h2>YouTube本編</h2>
      <p>AUDIOの編集済み音源で16:9のMP4（H.264／AAC）を作ります。</p>
      {!session?.edited && <button onClick={openAudio}>編集済み音源を用意する</button>}
      <fieldset disabled={!!stage || locked}>
        <label>本編タイトル<input type="text" maxLength={100} value={title} onChange={event => { setTitle(event.target.value); setConfirm(false); }} /></label>
        <label>回番号<input type="text" inputMode="numeric" value={number} onChange={event => { setNumber(event.target.value); setConfirm(false); }} /></label>
        <label>本編の配信予定（日本時間）<input type="datetime-local" value={planned} onChange={event => { setPlanned(event.target.value); setConfirm(false); }} /></label>
        <label>画質<select value={height} onChange={event => { setHeight(Number(event.target.value) as VideoResolution); setConfirm(false); }}><option value={360}>360p（標準）</option><option value={480}>480p</option><option value={720}>720p</option></select></label>
        <button onClick={() => void run(saveMetadata)}>回番号・タイトル・予定を保存</button>
        <button className="primary" disabled={!session?.edited} onClick={() => void run(generate)}>YouTube本編を書き出す</button>
      </fieldset>
      {codecUnavailable && session?.edited && <button type="button" onClick={() => {
        const audio = session.edited!.file;
        const url = URL.createObjectURL(audio);
        const link = document.createElement("a");
        link.href = url;
        link.download = audio.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }}>編集済み音源をそのまま保存</button>}
      {stage && <div role="status"><p>{stage}</p>{progress > 0 && <progress max={1} value={progress} />}<button onClick={() => job.current?.abort()}>中断</button></div>}
      {result && !locked && <div>
        <video controls preload="metadata" width="100%" src={result.url} />
        <p>{result.height}p · {(result.file.size / 1048576).toFixed(2)} MiB · {(result.elapsed / 1000).toFixed(1)}秒</p>
        <label className="check"><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />音声・カバー・タイトルと回番号を確認した</label>
        <button disabled={!confirm || !metadataMatches || !resultMatches} onClick={() => void run(() => updateFeature(id, row => {
          if (!row.selected || row.handoff || row.title !== title.trim() || row.number !== number.trim() || row.plannedAt !== planned) throw new Error("回の情報が変わりました。確認し直してください。");
          keptFile.current = result.file.name;
          return { ...row, approval: { at: Date.now(), digest: result.digest, file: result.file.name, sourceRevision: editedRevision } };
        }))}>この本編動画を承認</button>
      </div>}
      {handoffDigest && !locked && metadataMatches && <button onClick={() => void run(() => updateFeature(id, (row, all) => {
        if (!row.selected || row.handoff || row.approval?.digest !== handoffDigest || row.approval?.sourceRevision !== editedRevision ||
          Object.values(all).some(item => item.episodeId !== id && item.handoff && item.approval?.digest === handoffDigest)) throw new Error("すでに引き渡した動画があります。外部結果を確認してください。");
        return { ...row, handoff: "pending" };
      }))}>承認済み本編の引き渡しを記録する</button>}
      {locked && <>
        <p role="status">本編配信 {feature.handoff === "published" ? "公開確認済み" : feature.handoff === "scheduled" ? "予約確認済み" : "要照合・ショートの引き渡し保留"}</p>
        {feature.handoff === "pending" && (savedUrl || result && feature.approval?.digest === result.digest) && <p><a href={savedUrl || result?.url} download={`BRIDGE-RADIO-${feature.number}.mp4`}>承認済み本編を保存</a></p>}
        <p><a href="https://studio.youtube.com/" target="_blank" rel="noreferrer">YouTube Studioを開く</a></p>
        {feature.handoff !== "published" && <>
          <label>YouTube動画IDまたは視聴URL<input type="text" value={reference} onChange={event => setReference(event.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={checkedPublic} onChange={event => setCheckedPublic(event.target.checked)} />実際に本編が一般公開されたことを確認した</label>
          {(["unknown", "scheduled", "published"] as const).map(status => <button key={status} disabled={status === "published" && !checkedPublic} onClick={() => void run(() => updateFeature(id, (row, all) => {
            if (!row.handoff || row.handoff === "published") throw new Error("変更できない配信状態です。");
            const videoId = status === "unknown" ? row.youtubeId : youtubeId(reference);
            if (videoId && Object.values(all).some(item => item.episodeId !== id && item.youtubeId === videoId)) throw new Error("このYouTube動画は別の回に登録済みです。");
            return { ...row, handoff: status, youtubeId: videoId, publishedAt: status === "published" ? Date.now() : undefined };
          }))}>{status === "unknown" ? "結果不明を記録" : status === "scheduled" ? "予約確認を記録" : "公開を確認しショート保留を解除"}</button>)}
        </>}
        {feature.youtubeId && <p><a href={youtubeURL(feature.youtubeId)} target="_blank" rel="noreferrer">YouTube本編を確認</a></p>}
        {feature.handoff === "published" && <details><summary>Shortsの関連動画を設定</summary>
          <p>Shortの投稿後、YouTube Studio の「コンテンツ」で対象を開き、「関連動画」で本編を指定して保存します。上級者向け機能へのアクセスが必要です。</p>
          <label>設定を確認したShortの動画ID<input type="text" value={related} onChange={event => setRelated(event.target.value)} /></label>
          <button onClick={() => void run(() => updateFeature(id, row => {
            const short = youtubeId(related);
            if (short === row.youtubeId) throw new Error("Shortの動画IDを入力してください。");
            return { ...row, relatedShorts: [...new Set([...(row.relatedShorts ?? []), short])] };
          }))}>関連動画の設定確認を記録</button>
          <p>{feature.relatedShorts?.join("、") || "関連動画の設定は未確認"}</p>
        </details>}
      </>}
    </section>}
    {notice && <p role="status" className="card">{notice}</p>}
  </div>;
}
