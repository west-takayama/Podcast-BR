// 生成プロンプトの組み立て。番組ごとの個性(トーン・長さ・禁止語)を
// 設定として切り出し、プロンプト本文と分離して管理する。

export type Tone = "casual" | "friendly" | "professional" | "energetic" | "calm";

export const TONE_LABELS: Record<Tone, string> = {
  casual: "カジュアル(友人と話すような砕けた口調)",
  friendly: "フレンドリー(親しみやすい丁寧語)",
  professional: "プロフェッショナル(落ち着いた信頼感のある文体)",
  energetic: "エネルギッシュ(勢いがあり熱量の高い文体)",
  calm: "穏やか(静かで思索的な文体)",
};

export type TitleStyle = "curiosity" | "descriptive" | "keyword";

export const TITLE_STYLE_LABELS: Record<TitleStyle, string> = {
  curiosity: "興味を引く(問いかけ・意外性で聴きたくさせる)",
  descriptive: "内容説明型(何の話か一目でわかる)",
  keyword: "検索重視(キーワードを前方に置く)",
};

export interface PromptConfig {
  /** 番組名。プロンプトと告知画像の両方で使う。 */
  showName: string;
  showContext: string;
  /** 話者の呼び名(カンマ区切り)。書き起こしで話者を具体名にするために使う。 */
  speakers: string;
  /**
   * この番組でよく出る言葉(カンマ区切り)。
   * 番組名・相方の名前・造語・お店の名前など、AI が聞き間違えやすいものを
   * 先に渡しておくと、書き起こしと字幕の表記が揃う。
   */
  glossary: string;
  tone: Tone;
  titleStyle: TitleStyle;
  descriptionLength: number; // 説明文の目安文字数
  bannedWords: string; // 使ってほしくない語(カンマ区切り)
  fixedFooter: string; // 毎回説明文の末尾に付ける定型文
  generateSocial: boolean; // SNS 告知文も生成するか
}

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  showName: "",
  showContext: "",
  speakers: "",
  glossary: "",
  tone: "friendly",
  titleStyle: "curiosity",
  descriptionLength: 350,
  bannedWords: "",
  fixedFooter: "",
  generateSocial: true,
};

/** JSON スキーマを文章で示すより、実際の型定義を見せた方が構造が安定する。 */
function schemaBlock(generateSocial: boolean): string {
  const social = generateSocial
    ? `,
  "social": {
    "x": string,          // X(Twitter)向け。140文字以内。ハッシュタグ込み
    "instagram": string,  // Instagram向け。改行を使った読みやすい構成。300文字程度
    "newsletter": string  // メール/ブログ向けの案内文。400文字程度
  }`
    : "";
  return `{
  "titles": string[],     // タイトル案3つ
  "description": string,  // エピソード説明文
  "showNotes": string,    // Markdown箇条書きのショーノート
  "chapters": [{ "time": string, "label": string }],  // time は "MM:SS"
  "hashtags": string[],   // "#"付きのハッシュタグ5つ
  "transcriptSummary": string,  // 200文字以内の要約
  "keywords": string[],   // 検索されうるキーワード5〜8語(#なし)
  "imageQuote": string,   // 告知画像に載せる一言。30文字以内
  "clips": [{ "start": string, "end": string, "hook": string, "why": string }]  // 切り抜き候補3つ${social}
}`;
}

/** 秒を "MM:SS" に整える。60分を超えても分表記のまま(例 "72:30")。 */
export function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface PromptContext {
  /** 端末側で検出した話の切り替わり候補(秒)。チャプター時刻の精度を上げるために渡す。 */
  pauses?: number[];
  /** 音声の長さ(秒)。ありえない時刻を返させないために伝える。 */
  durationSec?: number;
  /** 直近の回のタイトル。番号の付け方や切り口の重複を避けるために渡す。 */
  previousTitles?: string[];
  /** 今回の出演者。回ごとに変わるので、設定の話者とは別に渡す。 */
  cast?: string;
}

export function buildPrompt(config: PromptConfig, context: PromptContext = {}): string {
  const sections: string[] = [];

  sections.push(
    `あなたは日本語ポッドキャストの制作を長年支えてきたプロデューサーです。添付の音声エピソードを最初から最後まで聴き取り、Spotify for Creators に投稿するためのメタデータ一式を作成してください。`,
  );

  const background = [
    config.showName.trim() && `番組名: ${config.showName.trim()}`,
    // 今回の出演者が分かっていればそちらを使う。設定の「話者」はレギュラーの
    // 控えで、ゲスト回だと実際と食い違うため、どちらを渡したかも書き分ける
    context.cast?.trim()
      ? `今回の出演者: ${context.cast.trim()}`
      : config.speakers.trim() && `話者: ${config.speakers.trim()}`,
    config.glossary.trim() && `この番組でよく出る言葉(この表記を使う): ${config.glossary.trim()}`,
    config.showContext.trim(),
  ]
    .filter(Boolean)
    .join("\n");
  if (background) sections.push(`# 番組の背景\n${background}`);

  if (context.previousTitles && context.previousTitles.length > 0) {
    sections.push(`# 直近の回のタイトル(新しい順)
${context.previousTitles.map((t) => `- ${t}`).join("\n")}

これを踏まえて:
- 番号や記号の付け方(「#12」「第12回」など)が使われていれば、同じ体裁で続きの番号にする。
  使われていなければ番号を付けない。
- 過去回と同じ切り口・同じ言い回しの繰り返しを避ける。
- ただし今回の内容が過去回と関連する場合は、その繋がりが伝わる表現にしてよい。`);
  }

  if (context.cast?.trim()) {
    sections.push(`# 出演者の扱い
- 今回の出演者は「${context.cast.trim()}」。書き起こしや説明文で人を指すときはこの呼び名を使う。
- **description に「出演:」から始まる行を自分で書かないこと。** その行はアプリ側で必ず頭に付ける。
  二重になるので、説明文の本文は内容の話から始める。`);
  }

  sections.push(`# 文体
- トーン: ${TONE_LABELS[config.tone]}
- 実際に話されている内容だけを根拠にすること。推測で事実を補わない。
- 一般論や当たり障りのない表現を避け、このエピソード固有の話題・固有名詞・具体例を必ず織り込む。
- 誇張した煽り表現(「衝撃の」「絶対に」など)は使わない。`);

  sections.push(`# 各項目の作り方
## titles(3案)
- 方向性: ${TITLE_STYLE_LABELS[config.titleStyle]}
- 全角30文字以内を目安。3案は互いに切り口を変える(同じ言い換えにしない)。
- エピソード内で実際に語られたキーワードを1つ以上含める。

## description
- 冒頭1〜2文でこの回の核心を伝える。ここだけ読んでも内容がわかるように。
- 続けて聴きどころを2〜3点、具体的に挙げる。
- ${config.descriptionLength}文字程度。

## showNotes
- 話題の流れを時系列で追える箇条書き(Markdown)。
- 各項目は体言止めではなく、何が語られたかがわかる一文にする。

## chapters
- 話題が実際に切り替わった箇所のみ。無理に細分化しない。
- time は音声の実時間に基づく "MM:SS"。60分を超える場合も分表記のまま(例 "72:30")。${
    context.durationSec
      ? `\n- この音声の長さは ${formatTimecode(context.durationSec)} です。これを超える時刻は返さない。`
      : ""
  }${
    context.pauses && context.pauses.length > 0
      ? `
- 下に「一定以上の沈黙のあとに話が再開した位置」を挙げます。話題の切り替わりは
  ここで起きている可能性が高いので、チャプターの time は**原則この一覧から選ぶ**こと。
  一覧に該当が無いと判断した場合のみ、それ以外の時刻を使ってよい。
  候補: ${context.pauses.map(formatTimecode).join(", ")}`
      : ""
  }

## imageQuote
- SNSの告知画像に大きく載せる一言。この回で最も引きの強い言葉を選ぶ。
- 全角30文字以内。体言止めか短い問いかけが望ましい。
- エピソード内で実際に語られた言葉を優先する。

## clips(切り抜き候補)
- 縦型ショート動画(TikTok / Reels / YouTube Shorts)にする箇所を3つ選ぶ。
- 音声を実際に聴いて、**それ単体で完結して面白い**区間を選ぶこと。前後の文脈が
  無いと意味が通らない箇所は選ばない。
- 長さは30〜60秒。start と end は "MM:SS"。
- 選ぶ基準(この順に強い):
  1. 笑いが起きている、声が跳ねている
  2. 言い切っている・断言している(「結局これは〇〇です」)
  3. 意外な事実や数字が出てくる
  4. 話が急に転換して引きが立つ
- **冒頭2秒で引きが立つ位置から始める。** 前置きや「えー」から始めない。
- hook は縦動画の1行目に大きく出す見出し。20文字以内。続きを聴きたくなる言葉にする。
  ネタバレで完結させず、答えは音声の中に残す。
- why は「なぜここが伸びると思うか」を20文字程度で。選び直す判断に使う。

## hashtags / keywords
- hashtags は日本語圏のリスナーが実際に使う語を選ぶ。
- keywords は検索意図に近い語(#なし、単語または短い句)。`);

  if (config.generateSocial) {
    sections.push(`## social
- x: 140文字以内。エピソードの引きを一言で。ハッシュタグを2つまで含める。
- instagram: 改行で読みやすく整形。冒頭に興味を引く一文、末尾にハッシュタグ。
- newsletter: 配信メールやブログに貼れる案内文。丁寧語で、聴くとどうなるかを伝える。`);
  }

  const constraints: string[] = [];
  if (config.bannedWords.trim()) {
    constraints.push(
      `- 次の語は使用しない: ${config.bannedWords
        .split(/[,、]/)
        .map((w) => w.trim())
        .filter(Boolean)
        .join(" / ")}`,
    );
  }
  if (config.fixedFooter.trim()) {
    constraints.push(
      `- description の末尾に、次の定型文をそのまま改行して付け加える:\n${config.fixedFooter.trim()}`,
    );
  }
  if (constraints.length > 0) {
    sections.push(`# 制約\n${constraints.join("\n")}`);
  }

  sections.push(`# 出力形式
次の構造の JSON のみを出力する(コードブロックや前置きの文章は不要):
${schemaBlock(config.generateSocial)}`);

  return sections.join("\n\n");
}
