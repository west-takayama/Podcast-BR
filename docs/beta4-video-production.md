# AI STUDIO 3.0 β4 選抜型動画制作

## 操作

1. Spotify本編は従来どおり作る。動画化したい回は「作成」または「YouTube本編」で選抜する。既存AIの評価と理由を参考に、収録時の手応えを優先する。推奨ショートは75点以上・完結性10点以上・要確認フラグなし。0本でも本編を選抜できる。評価なしの旧候補は主宰者が個別に選べる。
2. 「YouTube本編」でAUDIO編集済み音源、タイトル、回番号、予定（日本時間）、画質を確認する。既存のSpotify素材を優先し、保存済みの番組カバーも使える。16:9の書き出し後にプレビューし、素材の承認と引き渡しを記録してファイルを保存する。
3. 正式な配信承認を得たら、YouTube Studioへ手動で引き渡す。外部で公開を確認してから動画IDまたはURLを入力する。予約・結果不明はショートの引き渡しを保留する。
4. 推奨された、または自分で選んだショートを作成する。回番号が画面に入り、投稿文に本編タイトルが入る。投稿画面で候補・媒体・日時を確認し、同じ本編のショートに分散提案を適用できる。既存の承認を経て、保留解除後に経営本部向けJSONを作る。
5. Shortの投稿後にStudioの「コンテンツ → 対象Short → 関連動画」で本編を指定し、確認したShort IDをアプリに記録する。

## 設計

- 状態は共通エピソードIDで端末のIndexedDBに保持する。承認は動画ハッシュとメタデータに結び付く。引き渡し後に結果が不明なら外部照合が必要。同じ動画・動画IDの重複を台帳で拒否する。端末をまたぐ自動同期はない。
- 静止画をH.264で1回エンコードし、音声タイムスタンプで再利用する。音声を小さなサンプルでAACへ変換し、OPFSへ逐次書き込む。全編PCMや完成MP4の全体バッファは作らない。ネイティブAACを優先し、使えないときにWASMを遅延読み込みする。
- デフォルトは720p。1080pは文字やロゴの細線がより細かくなる分、容量が増える。動画エンコードを繰り返す波形表示は実装対象外。
- 選抜解除、本編未公開・予約中・結果不明、メタデータの不一致は新規ショートの引き渡しを保留する要件。β3以前の親情報がないDrive候補は既存の承認経路で扱う。
- 日時は過去90日以内の同一定義・同一計測期間の比較を参考にする。2区分以上かつ各2件以上が必要。対象外では既存Metricool参考時刻を有効期間内に使い、それ以外は仮時刻を示す。投稿時刻と反応の因果は判断しない。
- 公式枠と予約計画は区別する。アプリは月枠への余裕を保守的に判定する。実件数・外部予約・24時間枠はPlannerで確認する。
- iPhoneのネイティブAAC/H.264、バックグラウンド長尺生成、ストレージ逼迫、低フレームレートのYouTube受入は未検証。OPFSと空き容量が必要。
- AACフォールバックはMPL-2.0のMediabunny AACエンコーダ1.51.0を使用。公開前に内包FFmpegの再配布、ソース提供・再リンク、特許条件を確認する。[ビルド手順](https://github.com/Vanilagy/mediabunny/tree/main/packages/aac-encoder) · [FFmpegの法的情報](https://ffmpeg.org/legal.html)

## 配信経路の比較

公式資料確認日 2026-11-28。

| 経路 | 確認結果と採用方針 |
| --- | --- |
| YouTube Studio | 承認済みファイルを手動で引き渡す。15分超は確認済みチャンネルが必要。上限は256 GBまたは12時間の小さい方。[長尺アップロード](https://support.google.com/youtube/answer/71673) |
| Metricool | 横型の通常動画（公式表で60秒超）とShortsに対応。通常動画のファイル上限500 MB、モバイル取込も500 MB。15分超はYouTubeのチャンネル確認が必要。Freeは月20件で実際に公開した投稿を媒体別に計数。YouTubeはローリング24時間で10件。通常動画のアップロードは未試験。[予約・投稿](https://help.metricool.com/schedule-and-publish-on-youtube-gof0k) · [形式と容量](https://help.metricool.com/publishing-requirements-for-images-and-videos-from-metricool-vfc8n) · [Free条件](https://help.metricool.com/main-differences-between-free-and-paid-plans-bl0v9) · [日次枠](https://help.metricool.com/daily-posting-limits-on-social-media-sh58j) |
| YouTube Data API | videos.insertと再開可能アップロードは公式対応。ユーザーOAuthとプロジェクト設定が必要。現行資料ではVideo Uploads専用枠100回/日、1回1単位。改訂履歴では未確認APIプロジェクトへの一律非公開制限の撤廃が記載されている。クォータ拡張には監査がある。認証・運用保守と端末検証が必要なため直接接続は見送った。[videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [改訂履歴](https://developers.google.com/youtube/v3/docs/revision_history) · [監査](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) |
| Shorts関連動画 | 対象Shortのアップロード後にStudioで設定。上級者向け機能が有効で、対象本編は公開または限定公開が必要。Data APIの動画リソースに設定項目を確認できず、手動設定と確認記録を採用。[設定方法](https://support.google.com/youtube/answer/14075157) · [Videosリソース](https://developers.google.com/youtube/v3/docs/videos) |
| Spotify for Creators | 公式画面でアップロード・下書き・予約・公開に対応。ブラウザー自動操作の正式経路を確認できず、MFA、画面変更、誤公開防止の再現性を検証できないため、β2の承認済み素材の半自動方式を維持する。[配信手順](https://support.spotify.com/sr-en/creators/article/publishing-audio-episodes/) · [利用規約](https://www.spotify.com/us/legal/spotify-for-creators-terms/) |
