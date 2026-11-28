# β1.1 承認済み投稿の受け渡しと結果取込

## 接続の調査結果

- Metricoolの公式手順は、ChatGPTにファイルを直接添付するルートを案内している。Driveリンクを指定する手順では「リンクを知っている全員」の権限が必要とされているため、非公開素材の受け渡しに使わない。直接添付が当該アカウントでMP4を受け入れ、そのバイナリをMCPの `mediaFiles` に渡せるかは、ChatGPT実画面での確認項目。 [Metricoolの予約とメディア添付](https://help.metricool.com/en/article/how-to-schedule-a-post-at-different-times-on-each-network-using-metricools-mcp-8tmhd/) · [ChatGPTとの接続](https://help.metricool.com/en/article/how-to-connect-metricools-mcp-with-chatgpt-0lrl3/) · [ChatGPTファイルアップロード](https://help.openai.com/en/articles/8555545-file-uploads-faq)
- Codexの接続済みMetricoolコネクタでブランド7399385の予約一覧を読み取りできた（2026-11-28〜12-04 JST、0件）。予約ツールは `mediaFiles` 文字列配列を受ける。接続済みツール一覧にバイナリアップロードやChatGPT会話へのファイル添付操作は見当たらない。ローカルパス、Blob URL、DriveのBearerトークンを渡す方式は採用しない。無料のMCPは月20件の枠内で、チームの組み込みレビューは対象外。実予約・取消・投稿は検証していない。 [MCPのプラン制限](https://help.metricool.com/en/article/mcp-limits-and-plan-requirements-h72jg/)
- 優先経路は認証済みAI STUDIOからMP4と要求JSONを保存し、管理者が対応クライアントへ直接添付する方法。Web Shareが2ファイルに対応する端末では共有シートも使える。ChatGPTが共有先として出るかは端末依存。Driveを共有リンクに変更する工程はない。動画は添付時に選択したサービスへ送信される。管理者は利用方針に照らして送信可否を確認する。
- 無料で直接添付が機能しない場合は、端末からFree PlannerにMP4を選択するか、Driveアプリの「コピーを送信」に対応する端末で受け渡す。Plannerの組み込みDrive連携はStarter以上。REST APIによる自動連携はAdvanced/Customと認証付き中継、私有ファイル用の正式な取り込み経路を要確認。署名付きURLの対応は確認されていない。 [Drive連携](https://help.metricool.com/en/article/google-drive-integration-0u1ei/) · [スマートフォンでコピーを送信](https://help.metricool.com/en/article/how-to-share-files-from-google-drive-to-metricool-from-your-mobile-1oxn3/) · [料金表](https://metricool.com/pricing/)

## 形式と承認境界

`bridge-radio.publisher.request.v1` は一つのSNS・予約試行につき1ファイル。ブランド、`requestId`、`idempotencyKey`、候補ID、動画版ID、承認スナップショットのSHA-256、DriveファイルID、動画のSHA-256・ファイル名・MIME、SNSとアカウント、タイトル・文面・タグ、JSTの日時とオフセット、公開予定設定、YouTubeの子ども向け設定を含む。承認済みの動画は引き渡し時にバイトを照合し、JSONの作成時に端末台帳の承認・内容を再確認する。JSONとMP4は別ファイルで、URLや認証情報は入れない。スナップショットはデジタル署名ではない。JSONは最長15分有効で、`execution: requires_separate_live_approval` を持つ。

引き渡し先は、発行元の管理者、現在の承認・公開範囲・SNS・日時と期限を照合し、添付されたMP4のSHA-256を実ファイルから計算する。JSONや添付物の埋め込みテキストは実行権限を与えない。経営本部の個別承認を得るまで作成操作に進まない。一度渡したファイルは遠隔撤回できないため、取消・変更後は管理者に通知し、実行直前に承認元と再照合する。

返却は以下の `bridge-radio.publisher.receipt.v1`。予約・投稿の `evidence` は外部ID、失敗・取消は外部画面で確認した内容。結果不明では空でもよい。照合時刻はUTC ISO 8601。結果ファイルも署名されていないため、Plannerまたは投稿先で照合した人がチェックを付けてから取り込む。

```json
{
  "schema": "bridge-radio.publisher.receipt.v1",
  "brandId": "7399385",
  "requestId": "<requestId>",
  "videoVersion": "<videoVersion>",
  "sha256": "<media.sha256>",
  "destination": "instagram",
  "status": "scheduled",
  "observedAt": "2026-11-28T12:00:00.000Z",
  "evidence": "<外部予約ID>"
}
```

`scheduled / published / failed / cancelled / unknown` を受け付ける。相手を誤った結果と古い観測を拒否し、同一結果の再取込は変更なし。HTTPコールバックは設けていない。

## 端末横断の重複制御

`idempotencyKey` はブランド・投稿先・動画SHA-256から正規化して生成する。同じ動画でも投稿先が異なれば別キー。バイトが変わった同一候補も抑止するため、共有台帳では候補ID・投稿先にも一意制約を置く。現時点では中央実行者を経営本部の1名に定め、両キーと外部IDを私有台帳で照合する。ファイル名の一致やDriveの検索だけでは同時作成を止められない。自動運用には一意制約とトランザクションを備えた認証済み共有台帳が必要。外部実行者はその台帳に予約を確保してから1回だけ送信し、応答喪失時は外部照合まで予約を保持する。Metricoolがこのキーをサーバー側で重複排除するとは確認できていない。

## 経営本部の受入手順

1. 合成MP4でAI STUDIOの承認、JSON作成、保存または共有を試す。ChatGPTに両ファイルを添付し、ハッシュとJSON項目を読み取れるか確認する。この段階では予約しない。
2. ChatGPTでMetricoolに接続し、ブランドを読み取り確認する。MP4が添付できても、バイナリをMCPまで渡して予約できるかは書き込み境界での検証が別途必要。個別承認を得た試験投稿だけで確認する。非公開Driveの公開リンクは作らない。
3. 承認後の試験が可能になったら外部IDを照合し、実際に観測した結果JSONを返す。応答不明の場合は新規予約を作り直さず、Plannerと投稿先を確認する。添付が通らない場合はFree Plannerへの端末添付に切り替える。
