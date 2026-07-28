# 🎙️ Podcast BR

スマホ完結型のポッドキャスト運営ツール。収録した **.WAV をアップロードするだけ**で、AI がタイトル・説明文・ショーノート・チャプター・ハッシュタグを自動生成し、Spotify for Creators への投稿を最短化します。

## 仕組み

```
[スマホブラウザ PWA]
  ① .WAV を選択
  ② ブラウザ内で MP3 変換 + 音量正規化(サーバー不要・Web Worker)
  ③ Gemini API(無料枠)で文字起こし+メタデータ一括生成
  ④ ワンタップコピー + MP3 ダウンロード
  → Spotify for Creators アプリに貼り付けて投稿(約30秒)
```

- **完全無料で運用可能**: 静的サイト(GitHub Pages)+ Gemini API 無料枠。サーバー費用ゼロ。
- **プライバシー**: 音声変換はすべて端末内で完結。音声は Google の Gemini API 以外へ送信されません。API キーは端末の localStorage にのみ保存。
- **Spotify for Creators に投稿 API がないため**、最後の投稿操作のみ Creators アプリで行う半自動方式です。

## セットアップ

### 1. デプロイ(初回のみ・PCでもスマホでも可)

1. GitHub リポジトリの **Settings → Pages → Source** を「**GitHub Actions**」に設定
2. `main` ブランチに push すると自動でビルド&デプロイされます
3. 発行された URL をスマホで開き、「ホーム画面に追加」で PWA 化

### 2. API キー(初回のみ・無料)

1. [Google AI Studio](https://aistudio.google.com/apikey) で API キーを無料発行(クレジットカード不要)
2. アプリの ⚙️ 設定画面にキーを貼り付け
3. 「番組の背景情報」に番組名やテーマを書いておくと生成品質が上がります

### 3. 毎回の運用

1. 収録した .WAV をアップロード
2. 完成したら MP3 をダウンロード、タイトル・説明文をコピー
3. Spotify for Creators アプリで新規エピソード → MP3 選択 → 貼り付け → 公開

## 開発

```bash
npm install
npm run dev        # 開発サーバー
npm run build      # 本番ビルド
npx tsx scripts/smoke-test.ts   # WAV→MP3 変換のスモークテスト
```

## ロードマップ

- **v1(現在)**: WAV→MP3 変換、音量正規化、タイトル・説明文・ショーノート・チャプター・ハッシュタグの自動生成
- **v2**: エピソード履歴の保存(IndexedDB)、生成文のトーン設定・テンプレート、SNS 告知文の生成
- **v3**: 無音カット・ノイズ低減、複数話者の話者分離表示、RSS 自前配信による完全自動投稿(Creators からの移行)

## 制約・既知の注意点

- Gemini 無料枠にはレート制限があります(429 エラー時は1分ほど待って再試行)
- 長時間(60分超)のエピソードはスマホでの変換に数分かかることがあります
- 対応 WAV 形式: 16/24/32bit 整数 PCM・32bit float、モノラル/ステレオ
