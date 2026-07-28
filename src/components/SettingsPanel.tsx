import type { Settings } from "../lib/settings";
import { TONE_LABELS, TITLE_STYLE_LABELS, type Tone, type TitleStyle } from "../lib/prompt";

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

export default function SettingsPanel({ settings, onChange, onClose }: Props) {
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
          onChange={(e) => onChange({ ...settings, model: e.target.value })}
        >
          <option value="gemini-2.5-flash">gemini-2.5-flash(推奨)</option>
          <option value="gemini-2.5-pro">gemini-2.5-pro(高品質・枠少なめ)</option>
          <option value="gemini-2.0-flash">gemini-2.0-flash(軽量)</option>
        </select>
      </label>

      <h3>番組の個性</h3>
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
