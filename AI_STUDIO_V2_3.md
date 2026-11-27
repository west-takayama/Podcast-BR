# AI STUDIO 2.3 経営本部向け報告

2.3.1以降のGoogle Drive初期設定は「設定」タブから行います。 [2.3.1の操作手順](./AI_STUDIO_V2_3_1.md)

ショート動画を書き出した画面から、完成動画と投稿情報を Google Drive の [01_投稿候補](https://drive.google.com/drive/folders/14tBUxITSF8mdAx5eAtBqZvGeKbSq-oqu) に個別・一括保存できます。通常制作、旧制作、履歴からの再編集は同じ保存画面を使います。保存にあたり Gemini への追加通信は発生しません。

## 初回設定と日常操作

1. Google Cloud の同一プロジェクトで Google Drive API と Google Picker API を有効化します。OAuth 同意画面を構成し、テスト運用では保存担当者をテストユーザーに加えます。
2. ウェブアプリケーション用 OAuth クライアントを作成し、検証サイトのオリジンを承認済み JavaScript 生成元に登録します。ローカル検証例は `http://localhost:5173` です。本番公開が承認された場合のオリジンは `https://west-takayama.github.io` です。
3. Picker キーは Google Picker API と使用するサイトの HTTP リファラーに制限します。「Google接続設定」に OAuth クライアント ID、Google Cloud プロジェクト**番号**、制限済み Picker キーを入力し、保存します。
4. 「Googleに接続」を押して、指定フォルダに書き込める Google アカウントで承認します。必要に応じて Picker で「01_投稿候補」を選びます。別アカウントでやり直す場合は「Googleアカウントを選ぶ」を使います。
5. 日常は完成動画と投稿文を確認し、「完成動画をまとめてGoogleドライブに保存」または個別保存を押します。失敗分は再試行できます。ブラウザを再読み込みしたときや OAuth トークンが切れたときは「Googleに接続」を押します。

Google 接続設定はこのブラウザのサイトデータに保持します。「接続設定を消去」で消せます。OAuth の範囲は `drive.file` です。アクセストークンはページのメモリだけに保持し、有効な間は同じページ内で再利用します。既存の設定・履歴・バックアップは従来どおりです。動画のアクセス権は保存先フォルダから継承します。運用前にフォルダの共有先を確認してください。Drive API は無償の Standard Tier で運用でき、動画は保存アカウントの Drive 容量を消費します。 [Picker 設定](https://developers.google.com/workspace/drive/picker/guides/web-picker) · [Drive OAuth スコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) · [Drive API 利用枠](https://developers.google.com/workspace/drive/api/guides/quotas)

## 候補ID・版IDと承認

- **候補ID**は元素材の SHA-256 と切り抜き範囲から計算します。同じ素材の同じ範囲であれば、字幕・話者名・投稿文を修正しても候補IDは共通です。
- **版ID**は完成動画のバイト列と、投稿タイトル・投稿文・ハッシュタグから計算します。字幕や話者名は再書き出しした動画に反映したうえで保存します。書き出し後の投稿文はその場で編集できます。再エンコードで完成動画のバイト列が変わると、見た目が同じでも新しい版になります。元素材自体のバイト列や切り抜き範囲が変わると別候補になります。
- 各版を動画と投稿情報 JSON（`schemaVersion: 2`）の一組で保存します。JSON の状態は `pending_owner_approval` です。Drive 上で両ファイルがそろった版のうち、JSON の作成日時が最も新しい版を「保存時の最新版」と表示します。アプリの版IDリンクから対象 JSON を開けます。Drive では候補IDの接頭辞で絞り込み、JSON の作成日時と記載の版IDを確認できます。版管理導入前のファイルも保管されます。
- 同一候補・同一版の再試行では既存ファイルまたは事前発行した同じファイル ID を使います。未完了ファイルは先頭から再送します。別端末で同じ版を同時に保存する場合は重複の余地があるため、同じ候補の保存操作は1台に集約してください。 [Drive の事前発行 ID](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- 経営本部は**候補IDと投稿先**で重複を確認し、**承認した版ID**を記録します。承認後に修正版を使う場合は、新しい版を確認・承認して既存の予約を更新します。Drive 保存で投稿や予約は行われません。

## MP4とiPhone

書き出しは 1080×1920・30fps の H.264/AAC MP4 を優先し、MP4 の再生開始に必要な情報を先頭に置きます。音声は 48 kHz にそろえます。端末が対応する組み合わせに応じて出力形式を表示し、WebM に切り替わった場合は投稿用 MP4 が必要なことを案内します。Apple は Safari 26.0 で WebCodecs の AudioEncoder 対応を案内しています。端末ごとの書き出し可否は実際の機能検出で判断します。 [Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) · [Metricool の動画要件](https://help.metricool.com/publishing-requirements-for-images-and-videos-from-metricool-vfc8n)

## Metricoolへの受け渡し比較

| 方法 | 追加費用と条件 | 人間が行う操作 |
| --- | --- | --- |
| Planner の Google Drive 連携 | Metricool Starter 以上。Google アカウントで接続した担当者が、Drive のアクセス権の範囲で選択できます。 [Drive 連携](https://help.metricool.com/google-drive-integration-0u1ei) | 初回に Drive を接続。承認版の動画を選択し、文面と予約を確認。 |
| ChatGPT の Metricool コネクタ／MCP | Metricool 側の MCP は Free も対象。Free の予約は月20件までで、ChatGPT 側の Apps 利用資格も適用されます。Metricool 内の承認フローは Advanced 以上です。非公開の Drive URL は MCP のメディア取得に使えません。公式には ChatGPT への直接添付の経路もありますが、利用中の環境での動画添付と転送は未検証です。 [プラン別の条件](https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg) · [ChatGPTとの接続](https://help.metricool.com/how-to-connect-metricools-mcp-with-chatgpt-0lrl3) · [動画と承認の要件](https://help.metricool.com/how-to-schedule-a-post-at-different-times-on-each-network-using-metricools-mcp-8tmhd) | アカウント連携、投稿先指定、添付・プレビュー確認、主宰者の承認が必要。実運用前にデータ送信先の承認を得る。 |
| 認証付きファイル転送 | Drive の非公開ファイルは認証済み端末で取得できます。Metricool API は Advanced または Custom 向けです。通常のURL取り込みは公開・失効なしのURLが条件です。認証付きDrive URLや短期署名URLでの直接取込は公式に確認できません。Driveアプリの「コピーを送信」からMetricoolに手渡す公式手順があります。無料アカウントと対象端末での利用は要確認です。 [API対象プラン](https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg) · [Metricool API](https://help.metricool.com/common-questions-and-errors-when-using-the-api-8x9nq) · [モバイル共有](https://help.metricool.com/how-to-share-files-from-google-drive-to-metricool-from-your-mobile-1oxn3) | Drive と Metricool にサインインした担当者が承認版を共有し、受け渡しと投稿内容を確認。 |

追加課金なしで用意できる範囲は、ブラウザでの動画制作と Drive Standard Tier の範囲内での非公開保存までです。初回の Google Cloud 設定と同意、セッションが切れた際の再接続、Metricool への受け渡し、主宰者の承認は人間が行います。

## テスト結果と公開前の確認

- `npm test`、ビルド、Chromium E2E 全14件が成功しました。Drive モックでは、端末設定が再読み込み後に残ること、トークンがブラウザの保存領域へ書き込まれないこと、途中失敗の再試行、候補IDを維持した投稿文の版更新、旧版の保持を確認しました。
- iPhone 15相当の画面設定を使った Linux 版 WebKit で、合成音声から2秒のMP4を書き出しました。ffprobe と FFmpeg で H.264 High、AAC-LC 48 kHz、1080×1920、30 fps、先頭側の `moov`、ファイル全体のデコードを確認しました。Linux 版 WebKit のプレーヤーでは再生開始を確認しましたが、末尾までの連続再生は確認できませんでした。

主宰者の iPhone で、Safari とホーム画面版の書き出し・再生・共有、Google ログインと Picker、実フォルダへの2本の保存、修正版の識別、再接続、経営本部アカウントへの受け渡しを確認します。Google 認証・Drive 書き込みの自動テストはモックです。課金、一般公開、投稿予約、本番反映は行っていません。
