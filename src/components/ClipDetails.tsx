import type { Clip } from '../lib/gemini';
import CopyButton from './CopyButton';

/** Optional fields keep old histories usable without invented scores or copy. */
export default function ClipDetails({ clip }: { clip: Clip }) {
  const scores = clip.scores;
  const post = [clip.socialPost, clip.hashtags?.join(' ')].filter(Boolean).join('\n\n');
  return <>
    {scores && <p className="muted">
      編集評価 {scores.interest + scores.insight + scores.hook + scores.empathy + scores.completeness}/100
      （面白さ {scores.interest}/25 ・気づき {scores.insight}/25 ・引き {scores.hook}/20 ・共感 {scores.empathy}/15 ・完成度 {scores.completeness}/15）
      <br />AIの編集支援評価です。再生数の予測ではありません。
    </p>}
    {clip.needsReview && <p className="muted">⚠️ 区間を素材の長さ・上限に合わせて補正しました。発言の始まりと結論が含まれるか試聴してください。</p>}
    {post && <div onClick={event => event.stopPropagation()}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{post}</p>
      <CopyButton text={post} />
    </div>}
  </>;
}
