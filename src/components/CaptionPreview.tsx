import { useEffect, useRef, useState } from "react";
import { displayCueAt, type DisplayCue } from "../lib/video/captionAlignment";

export default function CaptionPreview({ cues, load }: {
  cues: DisplayCue[];
  load: () => Promise<Blob>;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const source = useRef("");
  const mounted = useRef(false);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [time, setTime] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      URL.revokeObjectURL(source.current);
    };
  }, []);
  useEffect(() => {
    if (!url) return;
    let frame = 0;
    const tick = () => {
      if (audio.current) setTime(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [url]);

  const prepare = async () => {
    setStatus("試聴音声を準備中…");
    try {
      const blob = await load();
      if (!mounted.current) return;
      source.current = URL.createObjectURL(blob);
      setUrl(source.current);
      setStatus("");
    } catch {
      if (mounted.current) setStatus("試聴音声を準備できませんでした。");
    }
  };
  const cue = displayCueAt(cues, time);

  return (
    <div className="caption-preview">
      {url ? (
        <>
          <audio ref={audio} src={url} controls preload="metadata" />
          <div aria-label="表示中の字幕" className="caption-preview-text" style={{ color: cue?.speakerColor }}>
            {cue && <><strong>{cue.speaker}</strong><br />{cue.text}</>}
          </div>
        </>
      ) : <button type="button" disabled={status === "試聴音声を準備中…"} onClick={() => void prepare()}>字幕と音声を試聴</button>}
      {status && <p role="status">{status}</p>}
    </div>
  );
}
