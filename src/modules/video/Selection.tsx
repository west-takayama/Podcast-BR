import { useEffect, useState } from "react";
import type { Clip } from "../../lib/gemini";
import { newFeature, qualityClips, type Feature } from "./feature";
import { getFeature, updateFeature } from "./store";

export function useFeature(id?: string) {
  const [row, setRow] = useState<Feature>();
  useEffect(() => {
    if (!id) return;
    let version = 0;
    let active = true;
    const load = () => {
      const current = ++version;
      void getFeature(id).then(value => {
        if (active && current === version) setRow(value ?? newFeature(id));
      }).catch(() => { if (active && current === version) setRow(undefined); });
    };
    const change = (event: Event) => { if ((event as CustomEvent<string>).detail === id) load(); };
    load();
    window.addEventListener("studio-video-feature", change);
    return () => { active = false; window.removeEventListener("studio-video-feature", change); };
  }, [id]);
  return id && row?.episodeId === id ? row : undefined;
}

export default function Selection({ feature, clips, edit, suggestedTitle }: { feature: Feature; clips: Clip[]; edit?: () => void; suggestedTitle?: string }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const quality = qualityClips(clips);
  const update = async (selected: boolean) => {
    setSaving(true); setError("");
    try { await updateFeature(feature.episodeId, current => ({ ...current, selected })); }
    catch { setError("選抜を端末に保存できません。"); }
    finally { setSaving(false); }
  };
  return <section className="card">
    <h2>動画化の選抜</h2>
    <p aria-live="polite">{feature.selected ? "動画化に選抜済み" : "動画化は未選抜"}</p>
    <p>既存のAI評価で推奨できるショート {quality.length}本。最後は収録の手応えで判断してください。</p>
    {quality.length ? <ul>{quality.map((clip, index) => <li key={index}>{clip.hook} — {clip.why}
      {clip.scores && <small>（面白さ {clip.scores.interest}／新しい視点 {clip.scores.insight}／共感 {clip.scores.empathy}／冒頭 {clip.scores.hook}／完結性 {clip.scores.completeness}）</small>}</li>)}</ul> :
      <p className="muted">評価済みの有力候補がない場合も、本編だけを選抜できます。</p>}
    <div className="row-buttons">
      <button type="button" disabled={saving} onClick={() => void update(!feature.selected)}>{feature.selected ? "動画化から除外する" : "この回を動画化に選抜する"}</button>
      {edit && <button type="button" onClick={edit}>YouTube本編の情報を開く</button>}
    </div>
    {feature.selected && !feature.handoff && suggestedTitle !== undefined && <form key={feature.episodeId} onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      const title = String(fields.get("title")).trim();
      const number = String(fields.get("number")).trim();
      if (!title || !/^[0-9]{1,6}$/.test(number)) { setError("本編タイトルと回番号を入力してください。"); return; }
      setError("");
      void updateFeature(feature.episodeId, row => {
        if (!row.selected || row.handoff) throw new Error();
        const changed = row.title !== title || row.number !== number;
        return { ...row, title, number, approval: changed ? undefined : row.approval };
      }).catch(() => setError("本編情報を保存できません。"));
    }}>
      <label>ショートに紐づく本編タイトル<input name="title" defaultValue={feature.title || suggestedTitle} maxLength={100} required /></label>
      <label>ショートに表示する回番号<input name="number" defaultValue={feature.number} type="text" inputMode="numeric" pattern="[0-9]{1,6}" required /></label>
      <button>ショート用の本編情報を保存</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
