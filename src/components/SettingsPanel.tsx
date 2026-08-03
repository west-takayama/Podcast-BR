import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Settings } from "../lib/settings";
import { TONE_LABELS, TITLE_STYLE_LABELS, type Tone, type TitleStyle } from "../lib/prompt";
import { listModels, pickDefaultModel, pickImageModel, type ModelInfo } from "../lib/gemini";

interface Props {
  settings: Settings;
  /**
   * setState と同じ形にしてある。モデル一覧の取得は非同期で、
   * その間に利用者が別の項目を編集しうるため、更新関数を渡せる必要がある。
   */
  onChange: Dispatch<SetStateAction<Settings>>;
  onClose: () => void;
}

export default function SettingsPanel({ settings, onChange, onClose }: Props) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelError, setModelError] = useState("");

  // モデル一覧はキーを入れた時点で取りに行く。Google 側の廃止でアプリ内の
  // 固定リストが古くなる問題を避けるため、選択肢は常に API の返り値から作る。
  useEffect(() => {
    if (!settings.apiKey) {
      setModels(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setModelError("");
      listModels(settings.apiKey, controller.signal)
        .then((list) => {
          setModels(list);
          // 取得中に編集された項目を消さないよう、必ず最新の設定を基に更新する
          onChange((prev) => {
            const next = { ...prev };
            let changed = false;
            // 保存済みのモデルが廃止されていたら、使えるものへ寄せておく
            if (list.length > 0 && !list.some((m) => m.id === prev.model && !m.image)) {
              const fallback = pickDefaultModel(list);
              if (fallback) {
                next.model = fallback;
                changed = true;
              }
            }
            // イラスト用モデルは利用者に選ばせず、無料枠のあるものを自動で採る
            if (!list.some((m) => m.id === prev.imageModel && m.image)) {
              const picked = pickImageModel(list) ?? "";
              if (picked !== prev.imageModel) {
                next.imageModel = picked;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setModelError(e instanceof Error ? e.message : String(e));
        });
    }, 500); // 入力途中のキーで何度も叩かないよう少し待つ
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKey]);

  const setPrompt = <K extends keyof Settings["prompt"]>(
    key: K,
    value: Settings["prompt"][K],
  ) => onChange({ ...settings, prompt: { ...settings.prompt, [key]: value } });

  const setDsp = <K extends keyof Settings["dsp"]>(key: K, value: Settings["dsp"][K]) =>
    onChange({ ...settings, dsp: { ...settings.dsp, [key]: value } });

  return (
    <div className="card">
      <h2>設定</h2>

      <label>
        Gemini API キー(必須)
        <input
          type="password"
          value={settings.apiKey}
          placeholder="AIza..."
          onChange={(e) => onChange({ ...settings, apiKey: e.target.value.trim() })}
        />
      </label>
      <p className="muted">
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          Google AI Studio
        </a>
        で無料発行できます(クレジットカード不要)。キーはこの端末にのみ保存されます。
      </p>

      <label>
        モデル
        <select
          value={settings.model}
          disabled={!models || models.length === 0}
          onChange={(e) => onChange({ ...settings, model: e.target.value })}
        >
          {models === null && <option>{settings.apiKey ? "取得中…" : "APIキーを入力してください"}</option>}
          {models
            ?.filter((m) => !m.image)
            .map((m, i) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {i === 0 ? "(推奨)" : ""}
              </option>
            ))}
        </select>
      </label>
      {modelError ? (
        <p className="muted">⚠️ {modelError}</p>
      ) : (
        <p className="muted">
          利用可能なモデルをキーから取得して表示しています。Google がモデルを廃止した場合は、生成時に自動で新しいモデルへ切り替えます。
        </p>
      )}

      <h3>番組の個性</h3>
      <label>
        番組名(告知画像にも入ります)
        <input
          type="text"
          value={settings.prompt.showName}
          placeholder="例: ◯◯ラジオ"
          onChange={(e) => setPrompt("showName", e.target.value)}
        />
      </label>
      <label>
        話者の呼び名(カンマ区切り・任意)
        <input
          type="text"
          value={settings.prompt.speakers}
          placeholder="例: たかやま, ゲストの佐藤さん"
          onChange={(e) => setPrompt("speakers", e.target.value)}
        />
      </label>
      <p className="muted">
        書き起こしで話者を具体名にできます。空欄の場合は「A」「B」になります。
      </p>

      <label>
        この番組でよく出る言葉(カンマ区切り・任意)
        <input
          type="text"
          value={settings.prompt.glossary}
          placeholder="例: ねぎ塩, ジャガイモ回, 西さん, 高山商店"
          onChange={(e) => setPrompt("glossary", e.target.value)}
        />
      </label>
      <p className="muted">
        AI が聞き間違えやすい言葉を先に登録しておくと、書き起こしと字幕の表記が揃います。
        番組名・相方の名前・造語・お店の名前など、
        <strong>音は近いけれど普通の日本語には無い言葉</strong>ほど効きます。
      </p>

      <label>
        番組の背景情報(生成品質が大きく上がります)
        <textarea
          value={settings.prompt.showContext}
          placeholder="例: 番組名「◯◯ラジオ」。30代の2人が雑談形式でテックニュースを語る番組。リスナーはエンジニアが中心。"
          onChange={(e) => setPrompt("showContext", e.target.value)}
        />
      </label>

      <label>
        文体のトーン
        <select
          value={settings.prompt.tone}
          onChange={(e) => setPrompt("tone", e.target.value as Tone)}
        >
          {Object.entries(TONE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label>
        タイトルの方向性
        <select
          value={settings.prompt.titleStyle}
          onChange={(e) => setPrompt("titleStyle", e.target.value as TitleStyle)}
        >
          {Object.entries(TITLE_STYLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label>
        説明文の目安文字数: {settings.prompt.descriptionLength}文字
        <input
          type="range"
          min={150}
          max={800}
          step={50}
          value={settings.prompt.descriptionLength}
          onChange={(e) => setPrompt("descriptionLength", Number(e.target.value))}
        />
      </label>

      <label>
        使ってほしくない語(カンマ区切り・任意)
        <input
          type="text"
          value={settings.prompt.bannedWords}
          placeholder="例: 超, ヤバい, 神回"
          onChange={(e) => setPrompt("bannedWords", e.target.value)}
        />
      </label>

      <label>
        説明文の末尾に必ず付ける定型文(任意)
        <textarea
          value={settings.prompt.fixedFooter}
          placeholder="例: ご感想は #◯◯ラジオ でお寄せください。お便りはこちら → https://example.com"
          onChange={(e) => setPrompt("fixedFooter", e.target.value)}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.prompt.generateSocial}
          onChange={(e) => setPrompt("generateSocial", e.target.checked)}
        />
        SNS告知文(X / Instagram / メール)も生成する
      </label>

      <h3>告知画像</h3>
      <label>
        アクセント色
        <input
          type="color"
          value={settings.accentColor}
          onChange={(e) => onChange({ ...settings, accentColor: e.target.value })}
        />
      </label>
      <p className="muted">
        告知画像の差し色です。毎回同じ色にしておくと、並んだときに番組として見分けやすくなります。
        {settings.imageModel
          ? ` AIイラストの生成には ${settings.imageModel} を使います。`
          : " このキーではAIイラストの生成は利用できません。"}
      </p>

      <h3>書き出し</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.mono}
          onChange={(e) => onChange({ ...settings, mono: e.target.checked })}
        />
        モノラルで書き出す(トーク番組の標準。処理が約1.7倍速く、ファイルも半分)
      </label>
      <label>
        ビットレート: {settings.bitrate} kbps
        <input
          type="range"
          min={64}
          max={192}
          step={32}
          value={settings.bitrate}
          onChange={(e) => onChange({ ...settings, bitrate: Number(e.target.value) })}
        />
      </label>
      <p className="muted">
        会話中心なら 96kbps モノラルで十分な音質です。音楽や環境音を聴かせたい回はステレオ・高ビットレートにしてください。
      </p>

      <h3>音声処理</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.dsp.highPass}
          onChange={(e) => setDsp("highPass", e.target.checked)}
        />
        低域カット(空調音・机の振動などのゴロつきを除去)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.dsp.noiseReduction}
          onChange={(e) => setDsp("noiseReduction", e.target.checked)}
        />
        ノイズ低減(ファンの音などの定常ノイズを抑える)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.dsp.perChannelNoise}
          onChange={(e) => setDsp("perChannelNoise", e.target.checked)}
        />
        2人を別マイクで左右に分けて録っている(チャンネルごとに独立してノイズ低減)
      </label>
      <p className="muted">
        話していない人のマイクの環境音を個別に抑えられます。左右で同じ音を録っている素材で有効にすると定位が崩れるため、別マイクのときだけ入れてください。
      </p>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.dsp.trimSilence}
          onChange={(e) => setDsp("trimSilence", e.target.checked)}
        />
        無音カット(1秒を超える沈黙を詰める)
      </label>
      <p className="muted">
        音量の正規化は常に適用されます。処理はすべて端末内で行われ、音声がサーバーに送られることはありません(生成時のみ Gemini に送信)。
      </p>

      <button className="primary" onClick={onClose}>
        保存して閉じる
      </button>
    </div>
  );
}
