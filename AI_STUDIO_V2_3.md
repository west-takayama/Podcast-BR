# AI STUDIO 2.3 経営本部向け実装報告

ショート動画を書き出した画面から、完成動画と投稿情報を Google Drive の [01_投稿候補](https://drive.google.com/drive/folders/14tBUxITSF8mdAx5eAtBqZvGeKbSq-oqu) に個別・一括保存できます。通常制作、旧制作、履歴からの再編集で、同じショート制作画面を使います。保存のために Gemini を追加で呼び出すことはありません。

## 初回設定と操作

1. Google Cloud の同一プロジェクトで Google Drive API と Google Picker API を有効化します。OAuth 同意画面を構成し、テスト運用では保存担当者をテストユーザーに加えます。
2. OAuth クライアントを「ウェブアプリケーション」で作成し、検証サイトのオリジンを承認済みの JavaScript 生成元に登録します。ローカル検証の例は `http://localhost:5173` です。本番公開の承認後に使うオリジンは `https://west-takayama.github.io` です。
3. Picker 用のブラウザキーを発行し、検証サイトの HTTP リファラーと Google Picker API に制限します。OAuth クライアント ID、プロジェクト**番号**、Picker キーはアプリの「Google接続設定」に入力します。OAuth クライアントシークレットの入力欄はありません。
4. 書き出した動画の画面で「Googleドライブへ保存」を開き、「Google接続を準備」→「Googleに接続」と進みます。指定フォルダに書き込めるアカウントを使い、必要に応じて Picker で「01_投稿候補」を選びます。
5. 「完成動画をまとめてGoogleドライブに保存」または各動画の保存ボタンを押します。途中で通信が切れたら、必要に応じて再接続し、「失敗分だけ再試行」を選びます。「Drive保存を中断」で停止できます。完成動画はその場で引き続き保存・共有できます。

ブラウザから Google に直接接続します。App の OAuth スコープは `drive.file` です。OAuth トークンと接続設定はページのメモリに保持し、再読み込みで消えます。ブラウザの永続ストレージには重複防止用の ID のみ記録します。既存の Gemini 設定と履歴には書き込みません。ドライブには保存ボタンで選んだ完成動画と投稿情報を送信し、ファイルの共有設定は保存先フォルダから継承します。経営本部は、運用開始前にフォルダの共有先を確認してください。

Drive API は無償の Standard Tier を使います。動画は保存アカウントの Drive 容量を消費します。

[Google Picker の設定](https://developers.google.com/workspace/drive/picker/guides/web-picker) · [Drive OAuth スコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) · [Drive API の利用枠](https://developers.google.com/workspace/drive/api/guides/quotas)

## 保存と重複防止

- 動画を1本ずつ保存し、その隣にタイトル・投稿文・ハッシュタグ・候補 ID・動画の Drive ファイル ID・切り抜き範囲を含む JSON を保存します。JSON の状態は `pending_owner_approval` です。
- 候補 ID は元素材の SHA-256 とミリ秒単位の切り抜き範囲から計算します。同じファイルと範囲で書き出した候補は、既存の保存を再利用します。同じ範囲のまま字幕や文面を差し替えた場合も旧版を再利用するため、差し替えは管理担当者と調整してください。再エンコードなどで元素材のバイト列が変わると候補 ID も変わります。
- 途中失敗時は保存済みのファイルを再利用します。完了応答が失われた場合は、Drive が発行した同じファイル ID を再利用して既存ファイルを確認します。未完了ファイルの送信は先頭から再試行します。別端末で同一候補を同時保存した場合の重複は完全に防げないため、同一候補の保存操作は1台に集約してください。

[Drive の再開可能なアップロードと事前発行 ID](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

## Metricool への受け渡し

- 推奨は縦型の MP4（9:16、H.264/AAC）です。WebM で書き出された動画も候補フォルダに保存できます。投稿先に合わせて管理側で MP4 版を用意してください。尺・容量の上限は投稿先ごとに確認してください。 [Metricool の投稿メディア要件](https://help.metricool.com/publishing-requirements-for-images-and-videos-from-metricool-vfc8n)
- Starter 以上では、管理担当者が Planner の Google Drive から対象動画を選べます。スマートフォンには Drive アプリの「コピーを送信」から Metricool アプリに渡す手順もあります。無料プランでは、利用中のアカウントと端末でモバイル共有が使えるか確認してください。 [Drive 連携](https://help.metricool.com/google-drive-integration-0u1ei) · [モバイル共有](https://help.metricool.com/how-to-share-files-from-google-drive-to-metricool-from-your-mobile-1oxn3)
- 管理担当者は JSON の投稿文・ハッシュタグを確認し、候補 ID と投稿先の組み合わせで下書き・承認・予約を管理してください。主宰者の承認後に経営本部が予約します。アプリの保存ボタンで投稿や予約は行われません。Metricool の API／CSV で動画を渡す方式は公開アクセス可能な URL を要求するため、今回は採用していません。 [Metricool API](https://help.metricool.com/common-questions-and-errors-when-using-the-api-8x9nq) · [CSV](https://help.metricool.com/common-troubleshooting-when-importing-csv-into-metricool-m2lcv)

## 公開前の実機確認

主宰者の iPhone で、Google の認証と Picker、実素材2本の保存、投稿情報の対応、通信中断からの再試行、保存先の共有権限を確認します。Google 認証とファイル保存の自動テストはモックを使用します。実アカウントの書き込みと Metricool での受け渡しは公開前の確認事項です。
