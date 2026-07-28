import CopyButton from "./CopyButton";
import type { EpisodeMeta } from "../lib/gemini";

interface Props {
  meta: EpisodeMeta;
  chosenTitle: string;
  onChooseTitle: (title: string) => void;
  audioUrl?: string;
  fileName?: string;
}

function Block({
  title,
  copyText,
  children,
}: {
  title: string;
  copyText?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="result-block">
      <div className="result-head">
        <h2>{title}</h2>
        {copyText && <CopyButton text={copyText} />}
      </div>
      {children}
    </div>
  );
}

export default function ResultView({
  meta,
  chosenTitle,
  onChooseTitle,
  audioUrl,
  fileName,
}: Props) {
  const chapterText = meta.chapters.map((c) => `${c.time} ${c.label}`).join("\n");
  // Creators の説明欄に一度で貼れるよう、説明文・チャプター・タグを1つにまとめる
  const fullDescription = [
    meta.description,
    chapterText && `\n【チャプター】\n${chapterText}`,
    meta.hashtags.length > 0 && `\n${meta.hashtags.join(" ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      {audioUrl && (
        <div className="card">
          <h2>✅ 投稿素材が完成しました</h2>
          <p className="muted">
            Spotify for Creators アプリで新規エピソード作成 → 下のMP3を選択 →
            各項目をコピーして貼り付けてください。
          </p>
          <audio controls src={audioUrl} style={{ width: "100%", marginTop: 8 }} />
          <a className="dl" href={audioUrl} download={fileName ?? "episode.mp3"}>
            ⬇️ 変換済み MP3 をダウンロード
          </a>
        </div>
      )}

      <div className="card">
        <Block title="タイトル案">
          {meta.titles.map((t) => (
            <div
              key={t}
              className={`title-option${chosenTitle === t ? " chosen" : ""}`}
              onClick={() => onChooseTitle(t)}
            >
              <span>
                {chosenTitle === t && "★ "}
                {t}
              </span>
              <CopyButton text={t} />
            </div>
          ))}
          <p className="muted">タップで採用タイトルを選ぶと履歴に残ります。</p>
        </Block>

        <Block title="説明文" copyText={meta.description}>
          <div className="result-body">{meta.description}</div>
        </Block>

        <Block title="説明欄まとめて貼り付け" copyText={fullDescription}>
          <p className="muted">説明文 + チャプター + ハッシュタグを1つにまとめたものです。</p>
        </Block>

        {meta.showNotes && (
          <Block title="ショーノート" copyText={meta.showNotes}>
            <div className="result-body">{meta.showNotes}</div>
          </Block>
        )}

        {meta.chapters.length > 0 && (
          <Block title="チャプター" copyText={chapterText}>
            <div className="result-body">{chapterText}</div>
          </Block>
        )}

        {meta.hashtags.length > 0 && (
          <Block title="ハッシュタグ" copyText={meta.hashtags.join(" ")}>
            <div className="result-body">{meta.hashtags.join(" ")}</div>
          </Block>
        )}

        {meta.keywords.length > 0 && (
          <Block title="検索キーワード" copyText={meta.keywords.join(", ")}>
            <div className="result-body">{meta.keywords.join(", ")}</div>
          </Block>
        )}

        {meta.transcriptSummary && (
          <Block title="内容サマリー" copyText={meta.transcriptSummary}>
            <div className="result-body">{meta.transcriptSummary}</div>
          </Block>
        )}
      </div>

      {meta.social && (
        <div className="card">
          <h2>📣 SNS告知文</h2>
          {meta.social.x && (
            <Block title="X(Twitter)" copyText={meta.social.x}>
              <div className="result-body">{meta.social.x}</div>
            </Block>
          )}
          {meta.social.instagram && (
            <Block title="Instagram" copyText={meta.social.instagram}>
              <div className="result-body">{meta.social.instagram}</div>
            </Block>
          )}
          {meta.social.newsletter && (
            <Block title="メール / ブログ" copyText={meta.social.newsletter}>
              <div className="result-body">{meta.social.newsletter}</div>
            </Block>
          )}
        </div>
      )}
    </>
  );
}
