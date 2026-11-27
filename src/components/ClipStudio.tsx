import { useEffect, useState } from "react";
import type { Clip, TranscriptSegment, UploadedAudio } from "../lib/gemini";
import type { Settings } from "../lib/settings";
import ShortsPanel from "./ShortsPanel";

interface Props {
  clips: Clip[];
  source?: Blob;
  durationSec?: number;
  episodeId?: string;
  audioUrl?: string;
  transcript?: TranscriptSegment[] | null;
  uploaded?: UploadedAudio | null;
  background?: ImageBitmap | null;
  originalAudio: boolean;
  fileName: string;
  settings: Settings;
  onModelChanged: (model: string) => void;
  onClipsFound?: (clips: Clip[]) => void;
}

/** Mount the common editor using an episode's local media and saved candidates. */
export default function ClipStudio({ source, durationSec, episodeId, audioUrl, fileName, clips, originalAudio, settings, onModelChanged, transcript, uploaded, background, onClipsFound }: Props) {
  const [picked, setPicked] = useState<File>();
  const [pickedUrl, setPickedUrl] = useState("");
  const media = picked ?? source;
  const [ready, setReady] = useState<{ media: Blob; file: File; durationSec: number; hasVideo: boolean }>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!picked) return;
    const url = URL.createObjectURL(picked);
    setPickedUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  useEffect(() => {
    if (!media) return;
    let active = true;
    setError("");
    import("../lib/video/clip").then(async ({ inspectClipSource }) => {
      const info = await inspectClipSource(media);
      if (picked && durationSec && Math.abs(info.durationSec - durationSec) > 3) {
        throw new Error("この回と素材の長さが一致しません");
      }
      const file = media instanceof File ? media : new File([media], fileName, { type: media.type });
      if (active) setReady({ media, file, ...info });
    }).catch(() => {
      if (active) setError("素材から音声を読み取れませんでした。元の回と同じファイルを選んでください。");
    });
    return () => { active = false; };
  }, [media, fileName, picked, durationSec]);

  if (ready && ready.media === media) {
    return <ShortsPanel
      key={JSON.stringify(clips)}
      settings={settings}
      previousTitles={[]}
      onModelChanged={onModelChanged}
      existing={{ ...ready, episodeId: picked ? undefined : episodeId, clips, transcript, uploaded: picked ? undefined : uploaded, background,
        previewUrl: picked ? pickedUrl : audioUrl, onClipsFound }}
    />;
  }

  return (
    <section className="card">
      <h2>ショートの候補</h2>
      <button type="button" className="primary shorts-all-generate" disabled>すべてのショート動画をまとめて生成</button>
      {media && !error && <p role="status">素材を確認しています…</p>}
      {error && <p role="alert">{error}</p>}
      {(!source || error) && <>
        <p>{originalAudio ? "この回で使った元の音声・動画を選ぶと再開できます。" : "この回の配信用MP3を選ぶと、保存済みの時刻で再開できます。"}</p>
        <label>
          この回の素材を選択
          <input type="file" className="shorts-asset-picker" accept="audio/*,video/*,.wav,.mp3,.mp4,.mov,.webm"
            onChange={event => { setPicked(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
        </label>
      </>}
    </section>
  );
}
