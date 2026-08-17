import { useEffect, useState } from "react";
import CopyButton from "./CopyButton";
import {
  COVER_STYLE_LABELS,
  COVER_USAGE_NOTE,
  buildCoverPrompt,
  loadCoverStyle,
  saveCoverStyle,
  type CoverStyle,
} from "../lib/coverPrompt";
import { suggestCoverIdeas, type CoverIdea } from "../lib/gemini";
import type { PromptConfig } from "../lib/prompt";

interface Props {
  /** 採用したタイトル。空ならタイトル案の先頭。 */
  title: string;
  summary?: string;
  keywords?: string[];
  accent: string;
  config: PromptConfig;
  /** 絵柄をAIに考えてもらうために要る。無ければそのボタンは出さない。 */
  apiKey?: string;
  model?: string;
  onModelChanged?: (model: string) => void;
}

/**
 * カバー画像を作らせるための注文文。
 *
 * ここで作るのは**文章だけ**で、画像は作らない。画像生成は有料の API が要るので、
 * すでに使っている ChatGPT や Gemini にそのまま貼れる形で渡す。
 *
 * 材料は保存してある本文だけなので、**音声を消した古い回でも同じように出せる。**
 */
export default function CoverPrompt({
  title,
  summary,
  keywords,
  accent,
  config,
  apiKey,
  model,
  onModelChanged,
}: Props) {
  const [scope, setScope] = useState<"episode" | "show">("episode");
  const [style, setStyle] = useState<CoverStyle>(() => loadCoverStyle());
  const [ideas, setIdeas] = useState<CoverIdea[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // 回や絵柄が変われば、前の案はもう合っていない
  useEffect(() => {
    setIdeas(null);
    setChosen(null);
    setError("");
  }, [title, scope]);

  const idea = ideas && chosen !== null ? ideas[chosen].scene : undefined;
  const prompt = buildCoverPrompt({
    scope,
    style,
    title,
    summary,
    keywords,
    showName: config.showName,
    showContext: config.showContext,
    accent,
    idea,
  });

  const think = async () => {
    if (!apiKey || !model) return;
    setBusy("考え中…");
    setError("");
    try {
      const got = await suggestCoverIdeas({
        apiKey,
        model,
        scope,
        title,
        summary,
        keywords,
        config,
        onStatus: setBusy,
        onModelChanged,
      });
      setIdeas(got);
      setChosen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card">
      <div className="result-head">
        <h2>🖼 カバー画像の注文文</h2>
        <CopyButton text={prompt} label="注文文をコピー" />
      </div>
      <p className="muted">{COVER_USAGE_NOTE}</p>

      <div className="row-buttons" style={{ marginTop: 8 }}>
        <button
          className={scope === "episode" ? "primary" : ""}
          onClick={() => setScope("episode")}
        >
          この回のカバー
        </button>
        <button className={scope === "show" ? "primary" : ""} onClick={() => setScope("show")}>
          番組のカバー(毎回共通)
        </button>
      </div>

      <label>
        絵柄
        <select
          value={style}
          onChange={(e) => {
            const next = e.target.value as CoverStyle;
            setStyle(next);
            saveCoverStyle(next);
          }}
        >
          {Object.entries(COVER_STYLE_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        選んだ絵柄は覚えておきます。毎回同じにしておくと、一覧に並んだとき同じ番組だと分かります。
      </p>

      {apiKey && model && (
        <div style={{ marginTop: 10 }}>
          <button onClick={think} disabled={!!busy}>
            {busy || "💡 何を写すかAIに考えてもらう"}
          </button>
          <p className="muted" style={{ marginTop: 6 }}>
            タイトルだけを渡すと、題名を図解しただけの絵になりがちです。何を写すかを先に決めると、
            その回らしい一枚になります。
            <strong>音声は使いません</strong>(保存してある本文だけで考えるので、
            音声を消した古い回でも出せます)。
          </p>
        </div>
      )}

      {error && <p className="muted">⚠️ {error}</p>}

      {ideas && (
        <div style={{ marginTop: 8 }}>
          {ideas.map((it, i) => (
            <div
              key={i}
              className={`title-option${chosen === i ? " chosen" : ""}`}
              onClick={() => setChosen(chosen === i ? null : i)}
            >
              <span>
                {chosen === i && "★ "}
                <strong>{it.headline}</strong>
                <br />
                <span className="muted">{it.scene}</span>
              </span>
            </div>
          ))}
          <p className="muted">
            タップで採用します(もう一度押すと外れます)。採用したものが下の注文文に入ります。
          </p>
        </div>
      )}

      <div className="result-body" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
        {prompt}
      </div>

      <p className="muted" style={{ marginTop: 8 }}>
        できた画像は、この画面の下の<strong>「この回の写真」</strong>から読み込めます。MP3
        のカバーと縦型ショートの背景に使われます。
      </p>
    </div>
  );
}
