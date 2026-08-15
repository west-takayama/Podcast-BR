import { useEffect, useMemo, useState } from "react";
import { suggestTopics, type TopicSuggestions } from "../lib/gemini";
import { loadPlan, savePlan, type Plan } from "../lib/plan";
import {
  buildInsights,
  digestForPrompt,
  insightsForPrompt,
  type Insights,
} from "../lib/insights";
import { listEpisodes, type EpisodeRecord } from "../lib/history";
import type { Settings } from "../lib/settings";
import CopyButton from "./CopyButton";

interface Props {
  settings: Settings;
  onModelChanged: (model: string) => void;
}

/**
 * これまでの回をもとに、次のお題を考えるページ。
 *
 * 以前は投稿間隔や長さの推移から助言も出していたが、やめた。
 * 1日十数回という規模では日ごとの差はほぼ全部ただの揺れで、
 * 検定してみると「水木が強い」も配信日の影響を除くと消えた。
 * **偶然と区別がつかないものを言い切ると判断を誤らせる**ので、
 * 数えるだけで確かなこと(何を話してきたか)に絞ってある。
 *
 * 集計は端末内で完結する(通信なし)。AI に渡すのはその結果と、
 * タイトル・日付・要約・チャプター見出しの抜粋だけで、音声は送らない。
 */
export default function InsightsPanel({ settings, onModelChanged }: Props) {
  const [records, setRecords] = useState<EpisodeRecord[] | null>(null);
  const [suggestions, setSuggestions] = useState<TopicSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<Plan | null>(() => loadPlan());

  // タブは切り替えるたびに作り直されるので、開くたびに数え直される
  useEffect(() => {
    listEpisodes()
      .then(setRecords)
      .catch(() => setRecords([]));
  }, []);

  const ins: Insights | null = useMemo(
    () => (records ? buildInsights(records) : null),
    [records],
  );

  const ask = async () => {
    if (!records || records.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await suggestTopics({
        apiKey: settings.apiKey,
        model: settings.model,
        digest: digestForPrompt(records),
        stats: insightsForPrompt(buildInsights(records)),
        config: settings.prompt,
        onStatus: setStatus,
        onModelChanged,
      });
      setSuggestions(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  if (records === null) return <div className="card">読み込み中…</div>;

  if (records.length === 0) {
    return (
      <div className="card">
        <h2>💡 次に話すお題</h2>
        <p className="muted">
          まだ履歴がありません。「作成」で回を作ると、これまで話したことをもとに
          次のお題を考えます。
        </p>
      </div>
    );
  }

  return (
    <>
      {error && <div className="error">⚠️ {error}</div>}

      <div className="card">
        <h2>🗂 これまでに話したこと</h2>
        <p className="muted">
          {records.length}回ぶんの履歴から、扱った話題を並べています(端末内で数えるだけ・通信なし)。
          <br />
          <strong>お題を考えるための棚卸しです。</strong>
          どの回が聴かれたかは分かりません(Spotify に再生数を取れる API が無いため)。
        </p>

        {ins && (
          <>
            {ins.topTopics.length > 0 && (
              <>
                <h3>よく扱う話題</h3>
                <div className="chips">
                  {ins.topTopics.map((t) => (
                    <span key={t.word} className="chip">
                      {t.word}
                      <span className="muted"> {t.episodes}</span>
                    </span>
                  ))}
                </div>
              </>
            )}

            {ins.risingTopics.length > 0 && (
              <>
                <h3>最近出てきた話題</h3>
                <p className="muted" style={{ marginTop: 0 }}>直近5回で初めて出たものです。</p>
                <div className="chips">
                  {ins.risingTopics.map((t) => (
                    <span key={t.word} className="chip rising">
                      {t.word}
                    </span>
                  ))}
                </div>
              </>
            )}

            {ins.dormantTopics.length > 0 && (
              <>
                <h3>しばらく触れていない話題</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  2回以上扱ったのに、直近5回では出ていないものです。
                </p>
                <div className="chips">
                  {ins.dormantTopics.map((t) => (
                    <span key={t.word} className="chip dormant">
                      {t.word}
                      <span className="muted"> {t.sinceEpisodes}回前</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>💡 次に話すお題</h2>
        <p className="muted">
          これまでの回に加えて、<strong>いま世の中で話されていること</strong>を Google 検索で
          確かめたうえで、次のお題を6個考えます。送るのはタイトル・日付・要約・チャプターの見出しだけで、
          <strong>音声は送りません</strong>。
          <br />
          設定の「想定している聴き手」を書いておくと、同年代の人が引っかかる入り口を選びやすくなります。
        </p>

        {busy ? (
          <p>⏳ {status || "考えています…"}</p>
        ) : (
          <button className="primary" onClick={ask} disabled={!settings.apiKey}>
            {suggestions ? "🔄 別の案を出す" : "💡 お題を考えてもらう"}
          </button>
        )}
        {!settings.apiKey && (
          <p className="muted">先に設定画面で Gemini API キーを入力してください。</p>
        )}

        {suggestions && (
          <>
            {suggestions.patterns.length > 0 && (
              <>
                <h3>AI が読み取った傾向</h3>
                <ul className="findings">
                  {suggestions.patterns.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </>
            )}
            {suggestions.gaps.length > 0 && (
              <>
                <h3>手が回っていないところ</h3>
                <ul className="findings">
                  {suggestions.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </>
            )}

            <h3>お題の案</h3>
            {suggestions.searched ? (
              <p className="muted">
                🔎 いま話されていることを検索で確かめたうえでの案です。
                <strong>伸びるかどうかは分かりません</strong>(再生数のデータは手元にありません)。
                下の出典を見て、ぴんと来たものを選んでください。
              </p>
            ) : (
              <p className="muted">
                今回は検索を使えなかったので、<strong>これまでの回だけ</strong>から考えた案です。
              </p>
            )}
            {suggestions.ideas.map((idea, i) => (
              <div key={i} className="idea">
                <div className="idea-head">
                  <span className="idea-title">{idea.title}</span>
                  <CopyButton text={idea.title} />
                </div>
                {idea.hook && <p className="idea-hook">「{idea.hook}」</p>}
                {idea.why && <p className="muted">{idea.why}</p>}
                {idea.angles.length > 0 && (
                  <ul className="idea-angles">
                    {idea.angles.map((a, k) => (
                      <li key={k}>{a}</li>
                    ))}
                  </ul>
                )}
                {idea.related.length > 0 && (
                  <p className="muted">つながる回: {idea.related.join(" / ")}</p>
                )}
                {/* 決めたら持ち回る。収録の直前に探し直さなくて済む */}
                <button
                  className={plan?.title === idea.title ? "copy-btn copied" : "copy-btn"}
                  onClick={() =>
                    setPlan(
                      savePlan({ title: idea.title, hook: idea.hook, angles: idea.angles }),
                    )
                  }
                >
                  {plan?.title === idea.title ? "✓ 次はこれ" : "📌 次はこれにする"}
                </button>
              </div>
            ))}

            {suggestions.sources && suggestions.sources.length > 0 && (
              <>
                <h3>調べたもと</h3>
                <ul className="findings">
                  {suggestions.sources.map((src, i) => (
                    <li key={i}>
                      <a href={src.uri} target="_blank" rel="noreferrer noopener">
                        {src.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <CopyButton
              text={suggestions.ideas
                .map(
                  (idea) =>
                    `${idea.title}\n${idea.hook ? `「${idea.hook}」\n` : ""}${idea.why}\n${idea.angles
                      .map((a) => `- ${a}`)
                      .join("\n")}`,
                )
                .join("\n\n")}
              label="お題をまとめてコピー"
            />
          </>
        )}
      </div>
    </>
  );
}
