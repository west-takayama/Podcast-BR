import CopyButton from "./CopyButton";
import ImageCards from "./ImageCards";
import { useEffect, useState } from "react";
import { transcriptToText, type EpisodeMeta, type TranscriptSegment } from "../lib/gemini";
import type { AudioReport } from "../App";

interface Props {
  meta: EpisodeMeta;
  chosenTitle: string;
  onChooseTitle: (title: string) => void;
  audioUrl?: string;
  fileName?: string;
  showName: string;
  accentColor: string;
  apiKey?: string;
  imageModel?: string | null;
  audioReport?: AudioReport | null;
  chapterNote?: string;
  transcript?: TranscriptSegment[] | null;
  /** 48時間以内なら音声を送り直さずに作り直せる。 */
  canReuseAudio?: boolean;
  busyText?: string;
  onRegenerate?: () => void;
  onMakeTranscript?: () => void;
  onEdit?: (patch: Partial<EpisodeMeta>) => void;
}

/** 投稿前の手直しをその場でできるようにする。編集は履歴にも残る。 */
function EditableBlock({
  title,
  value,
  onChange,
  rows = 6,
}: {
  title: string;
  value: string;
  onChange?: (next: string) => void;
  rows?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  return (
    <div className="result-block">
      <div className="result-head">
        <h2>{title}</h2>
        <div className="head-actions">
          {onChange &&
            (editing ? (
              <>
                <button
                  className="copy-btn"
                  onClick={() => {
                    onChange(draft);
                    setEditing(false);
                  }}
                >
                  保存
                </button>
                <button
                  className="copy-btn"
                  onClick={() => {
                    setDraft(value);
                    setEditing(false);
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <button className="copy-btn" onClick={() => setEditing(true)}>
                ✎ 編集
              </button>
            ))}
          <CopyButton text={value} />
        </div>
      </div>
      {editing ? (
        <textarea rows={rows} value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <div className="result-body">{value}</div>
      )}
    </div>
  );
}

/** 全文書き起こし。長いので折りたたんでおく。 */
function TranscriptSection({
  transcript,
  canReuseAudio,
  busy,
  onMake,
}: {
  transcript?: TranscriptSegment[] | null;
  canReuseAudio?: boolean;
  busy: boolean;
  onMake?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!transcript) {
    if (!canReuseAudio || !onMake) return null;
    return (
      <div className="card">
        <h2>📝 全文書き起こし</h2>
        <p className="muted">
          検索対策・アクセシビリティ・引用探しに使えます。メタデータとは別の呼び出しなので、必要なときだけ作成してください。
        </p>
        <button onClick={onMake} disabled={busy}>
          {busy ? "作成中…" : "書き起こしを作る"}
        </button>
      </div>
    );
  }

  const full = transcriptToText(transcript);
  const speakers = [...new Set(transcript.map((s) => s.speaker).filter(Boolean))];

  return (
    <div className="card">
      <div className="result-head">
        <h2>📝 全文書き起こし</h2>
        <CopyButton text={full} label="全文コピー" />
      </div>
      <p className="muted">
        {transcript.length}件の発言
        {speakers.length > 0 && ` ・ 話者 ${speakers.join(" / ")}`} ・{" "}
        {full.length.toLocaleString()}文字
      </p>
      <button onClick={() => setOpen((v) => !v)}>{open ? "閉じる" : "本文を表示"}</button>
      {open && (
        <div className="transcript">
          {transcript.map((seg, i) => (
            <div className="transcript-seg" key={i}>
              <div className="muted">
                {[seg.time, seg.speaker].filter(Boolean).join(" ")}
              </div>
              <div>{seg.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

/** 仕上がりの実測値。音量が基準内に収まったかを確認できるようにする。 */
function AudioSpec({ report }: { report: AudioReport }) {
  const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");
  const withinTolerance = Math.abs(report.outputLufs - report.targetLufs) <= 1;
  const limitedSec = report.limitedSamples / report.sampleRate;

  return (
    <div className="card">
      <h2>🎚 音声の仕上がり</h2>
      <dl className="spec">
        <div>
          <dt>音量(ラウドネス)</dt>
          <dd>
            <strong className={withinTolerance ? "ok" : "warn"}>
              {db(report.outputLufs)} LUFS
            </strong>
            <span className="muted">
              {" "}
              目標 {report.targetLufs} ± 1 ・ 元の音源 {db(report.sourceLufs)}
            </span>
          </dd>
        </div>
        <div>
          <dt>ピーク</dt>
          <dd>
            {db(report.peakDbfs)} dBFS
            <span className="muted"> 上限 -1.2</span>
          </dd>
        </div>
        <div>
          <dt>形式</dt>
          <dd>
            {report.inputFormat} → MP3 {report.bitrate} kbps ・{" "}
            {report.channels === 1 ? "モノラル" : "ステレオ"} ・{" "}
            {(report.sampleRate / 1000).toFixed(1)} kHz
          </dd>
        </div>
        {report.removedSec > 0 && (
          <div>
            <dt>無音カット</dt>
            <dd>{Math.round(report.removedSec)} 秒を短縮</dd>
          </div>
        )}
        {limitedSec > 0.01 && (
          <div>
            <dt>リミッター</dt>
            <dd>{limitedSec.toFixed(1)} 秒ぶんのピークを抑制</dd>
          </div>
        )}
      </dl>
      <p className="muted">
        Apple Podcasts の基準(ステレオ -16 / モノラル -19 LUFS、許容 ±1dB)に合わせています。
        {!withinTolerance &&
          " 目標から外れているのは、リミッターが強く働いたか元音源の音量差が大きい場合です。"}
      </p>
    </div>
  );
}

export default function ResultView({
  meta,
  chosenTitle,
  onChooseTitle,
  audioUrl,
  fileName,
  showName,
  accentColor,
  apiKey,
  imageModel,
  audioReport,
  chapterNote,
  transcript,
  canReuseAudio,
  busyText,
  onRegenerate,
  onMakeTranscript,
  onEdit,
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
          <p className="muted" style={{ marginTop: 8 }}>
            タイトル・番組名・説明文・アートワーク・チャプターを MP3 に埋め込んでいます。
          </p>
        </div>
      )}

      {audioReport && <AudioSpec report={audioReport} />}

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

        <EditableBlock
          title="説明文"
          value={meta.description}
          onChange={onEdit ? (v) => onEdit({ description: v }) : undefined}
          rows={8}
        />

        <Block title="説明欄まとめて貼り付け" copyText={fullDescription}>
          <p className="muted">説明文 + チャプター + ハッシュタグを1つにまとめたものです。</p>
        </Block>

        {meta.showNotes && (
          <EditableBlock
            title="ショーノート"
            value={meta.showNotes}
            onChange={onEdit ? (v) => onEdit({ showNotes: v }) : undefined}
          />
        )}

        {meta.chapters.length > 0 && (
          <Block title="チャプター" copyText={chapterText}>
            <div className="result-body">{chapterText}</div>
            {chapterNote && <p className="muted">✓ {chapterNote}</p>}
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

      {canReuseAudio && onRegenerate && (
        <div className="card">
          <h2>🔄 文章を作り直す</h2>
          <p className="muted">
            音声を送り直さずに作り直せます(アップロードから48時間以内)。設定でトーンや文字数を変えてから押すと、その設定で作り直します。
          </p>
          <button onClick={onRegenerate} disabled={!!busyText}>
            {busyText || "この音声で作り直す"}
          </button>
        </div>
      )}

      <TranscriptSection
        transcript={transcript}
        canReuseAudio={canReuseAudio}
        busy={!!busyText}
        onMake={onMakeTranscript}
      />

      <ImageCards
        quote={meta.imageQuote || chosenTitle || meta.titles[0]}
        title={chosenTitle || meta.titles[0]}
        showName={showName}
        accent={accentColor}
        apiKey={apiKey}
        imageModel={imageModel}
        subject={[meta.transcriptSummary, meta.keywords.join("、")].filter(Boolean).join(" / ")}
      />

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
