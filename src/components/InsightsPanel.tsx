import { useEffect, useMemo, useState } from "react";
import { suggestTopics, type TopicSuggestions } from "../lib/gemini";
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

const num = (v: number, digits = 0) => v.toFixed(digits);

/**
 * これまでの回から傾向を出し、次のお題を考えるページ。
 *
 * 数え上げは端末内で完結する(通信なし)。AI に渡すのはその結果と、
 * タイトル・日付・要約・チャプター見出しの抜粋だけで、音声は送らない。
 */
export default function InsightsPanel({ settings, onModelChanged }: Props) {
  const [records, setRecords] = useState<EpisodeRecord[] | null>(null);
  const [suggestions, setSuggestions] = useState<TopicSuggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

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
        <h2>📊 傾向と次のお題</h2>
        <p className="muted">
          まだ履歴がありません。「作成」で回を作ると、そのデータからこの番組の傾向を出して、
          次に話すお題を考えます。
        </p>
      </div>
    );
  }

  return (
    <>
      {error && <div className="error">⚠️ {error}</div>}

      <div className="card">
        <h2>📊 これまでの傾向</h2>
        <p className="muted">
          {records.length}回ぶんの履歴から、端末内で数えています(通信なし)。
        </p>

        {ins && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-value">{ins.count}</span>
                <span className="muted">回</span>
              </div>
              <div className="stat">
                <span className="stat-value">
                  {ins.medianGapDays === null ? "—" : num(ins.medianGapDays, 1)}
                </span>
                <span className="muted">日おき(中央値)</span>
              </div>
              <div className="stat">
                <span className="stat-value">{num(ins.medianMinutes)}</span>
                <span className="muted">分/回(中央値)</span>
              </div>
              <div className="stat">
                <span className="stat-value">{num(ins.daysSinceLast)}</span>
                <span className="muted">日前が最後</span>
              </div>
              <div className="stat">
                <span className="stat-value">{num(ins.medianChapters)}</span>
                <span className="muted">話題/回</span>
              </div>
              <div className="stat">
                <span className="stat-value">{ins.titleChars || "—"}</span>
                <span className="muted">字/タイトル</span>
              </div>
            </div>

            <ul className="findings">
              {ins.medianGapDays !== null && ins.daysSinceLast > ins.medianGapDays * 1.5 && (
                <li>
                  いつもより<strong>{num(ins.daysSinceLast - ins.medianGapDays)}日</strong>
                  空いています(普段は {num(ins.medianGapDays, 1)}日おき)。
                </li>
              )}
              {ins.minutesTrend !== null && Math.abs(ins.minutesTrend) >= 3 && (
                <li>
                  直近5回は、それ以前より1回あたり
                  <strong>
                    {ins.minutesTrend > 0 ? `${num(ins.minutesTrend)}分長い` : `${num(-ins.minutesTrend)}分短い`}
                  </strong>
                  です。
                </li>
              )}
              {ins.firstPickRate !== null && (
                <li>
                  タイトルは AI の第1案を<strong>{Math.round(ins.firstPickRate * 100)}%</strong>
                  の回で採用しています
                  {ins.firstPickRate < 0.34
                    ? "。1案目が好みと合っていないので、設定でタイトルの方向性を変えると手数が減ります。"
                    : "。"}
                </li>
              )}
              {ins.questionRate >= 0.5 && (
                <li>
                  タイトルの<strong>{Math.round(ins.questionRate * 100)}%</strong>
                  が問いかけの形です。続けると効き目が薄れるので、たまに言い切り型を混ぜると目立ちます。
                </li>
              )}
            </ul>

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
                <p className="muted" style={{ marginTop: 0 }}>
                  直近5回で初めて出たもの。いま乗っている流れです。
                </p>
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
                  2回以上扱ったのに、直近5回では出ていないもの。間が空いたぶん、話し直す価値があります。
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

        <p className="muted" style={{ marginTop: 16 }}>
          ※ ここで出しているのは<strong>出している側の傾向</strong>で、聴かれ方ではありません。
          Spotify for Creators に再生数を取れる API が無いため、どの回が伸びたかはこのツールからは分かりません。
        </p>
      </div>

      <div className="card">
        <h2>💡 次に話すお題</h2>
        <p className="muted">
          これまでの回を読んで、次のお題を6個考えます。送るのはタイトル・日付・要約・チャプターの見出しだけで、
          <strong>音声は送りません</strong>。
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
              </div>
            ))}

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
