import { useEffect, useRef, useState } from "react";
import type { TrackInfo } from "../lib/encoder.worker";
import { BANDS } from "../lib/audio/tone";
import type { Settings } from "../lib/settings";
import { MAX_BOOST_DB } from "../lib/audio/mix";

interface Props {
  files: File[];
  settings: Settings;
  /** この設定で変換を始める。 */
  onStart: (
    files: File[],
    manualDb: number[],
    measured: TrackInfo[],
    matchTone: boolean,
  ) => void;
  onCancel: () => void;
}

const fmtDb = (db: number) => `${db >= 0 ? "+" : ""}${db.toFixed(1)}dB`;

/**
 * 人ごとに分かれた音声の、音量を揃える画面。
 *
 * オンライン収録では参加者ごとに別ファイルで書き出せることが多い。
 * 分かれていれば**それぞれ別々に測って合わせられる**ので、
 * 「片方だけ声が小さい」を推測なしで直せる。
 *
 * 変換の前に測るのは、掛ける量を先に見せて直せるようにするため。
 * 変換まで進んでから直すと、数分かけた処理をやり直すことになる。
 */
export default function TrackPicker({ files, settings, onStart, onCancel }: Props) {
  const [tracks, setTracks] = useState<TrackInfo[] | null>(null);
  const [manual, setManual] = useState<number[]>(() => files.map(() => 0));
  const [error, setError] = useState("");
  const [matchTone, setMatchTone] = useState(true);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("../lib/encoder.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (e) => {
      if (e.data.type === "done") setTracks(e.data.tracks ?? []);
      else if (e.data.type === "error") setError(e.data.message);
      worker.terminate();
      workerRef.current = null;
    };
    worker.onerror = () => setError("音量を測れませんでした");
    // 測るだけなので軽い。エンコードは走らない
    worker.postMessage({
      file: files[0],
      files,
      purpose: "measure",
      dsp: settings.dsp,
      mono: settings.mono,
      bitrate: settings.bitrate,
    });
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [files, settings]);

  if (error) {
    return (
      <div className="card">
        <div className="error">⚠️ {error}</div>
        <button onClick={onCancel}>選び直す</button>
      </div>
    );
  }

  if (!tracks) {
    return (
      <div className="card">
        <h2>⏳ それぞれの音量を測っています…</h2>
        <p className="muted">{files.length}トラック。変換はまだ始めていません。</p>
      </div>
    );
  }

  // 音色の補正が実際に入る帯域があるか
  const tones = tracks.filter((t) => t.toneFixDb?.some((v) => Math.abs(v) >= 0.5));

  // いま音色がどれだけ違うか。切るかどうかの判断材料に出す
  const toneSpread =
    tracks.length > 1 && tracks.every((t) => t.tone)
      ? Math.max(
          ...BANDS.map((_, b) => {
            const vals = tracks.map((t) => t.tone!.db[b]);
            return Math.max(...vals) - Math.min(...vals);
          }),
        )
      : 0;

  const spread =
    tracks.length > 1
      ? Math.max(...tracks.map((t) => t.lufs).filter(Number.isFinite)) -
        Math.min(...tracks.map((t) => t.lufs).filter(Number.isFinite))
      : 0;

  return (
    <div className="card">
      <h2>🎚 人ごとの音量を揃える</h2>
      <p className="muted">
        {tracks.length}トラックを1本にまとめます。それぞれ別に測ってあるので、
        <strong>推測なしで正確に合わせられます</strong>。
        {Number.isFinite(spread) && spread > 0 && (
          <>
            <br />
            いちばん大きい人といちばん小さい人の差は <strong>{spread.toFixed(1)}dB</strong>
            {spread >= 6 ? "。かなり開いています。" : "。"}
          </>
        )}
      </p>

      {tracks.map((t, i) => {
        // 測って決めた分に、手動の増減を足したものが実際に掛かる量
        const total = t.gainDb + manual[i];
        return (
          <div key={i} className="track">
            <div className="track-head">
              <span className="track-name">{t.name}</span>
              <span className={`track-gain${Math.abs(total) >= 0.05 ? " on" : ""}`}>
                {fmtDb(total)}
              </span>
            </div>
            <div className="muted">
              測った音量 {Number.isFinite(t.lufs) ? `${t.lufs.toFixed(1)} LUFS` : "測れず"}
              {" ・ "}
              自動 {fmtDb(t.gainDb)}
              {manual[i] !== 0 && ` ・ 手動 ${fmtDb(manual[i])}`}
              {" ・ "}
              {t.durationSec >= 60
                ? `${Math.floor(t.durationSec / 60)}分${String(Math.round(t.durationSec % 60)).padStart(2, "0")}秒`
                : `${Math.round(t.durationSec)}秒`}
            </div>
            <input
              type="range"
              min={-MAX_BOOST_DB}
              max={MAX_BOOST_DB}
              step={0.5}
              value={manual[i]}
              onChange={(e) => {
                const v = Number(e.target.value);
                setManual((prev) => prev.map((x, k) => (k === i ? v : x)));
              }}
            />
          </div>
        );
      })}

      {tones.length > 0 && (
        <>
          <label className="check" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={matchTone}
              onChange={(e) => setMatchTone(e.target.checked)}
            />
            <span>
              音色も揃える
              <br />
              <span className="muted">
                マイクや部屋が違うと、同じ声量でも聞こえ方が変わります。切り替わるたびに
                耳が調整を強いられて疲れるので、周波数のバランスも寄せます(最大 ±6dB)。
                {toneSpread > 0 && (
                  <>
                    <br />
                    いまの音色の差は、いちばん開いている帯域で{" "}
                    <strong>{toneSpread.toFixed(1)}dB</strong>。
                  </>
                )}
              </span>
            </span>
          </label>

          {matchTone && (
            <div className="tone-table">
              <div className="tone-row tone-head">
                <span>Hz</span>
                {tracks.map((t, i) => (
                  <span key={i}>{t.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 8)}</span>
                ))}
              </div>
              {BANDS.map((hz, b) => (
                <div className="tone-row" key={hz}>
                  <span>{hz >= 1000 ? `${hz / 1000}k` : hz}</span>
                  {tracks.map((t, i) => {
                    const v = t.toneFixDb?.[b] ?? 0;
                    return (
                      <span key={i} className={Math.abs(v) >= 0.5 ? "on" : ""}>
                        {v >= 0 ? "+" : ""}
                        {v.toFixed(1)}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {manual.some((m) => m !== 0) && (
        <button onClick={() => setManual(files.map(() => 0))}>自動の値に戻す</button>
      )}

      <p className="muted">
        自動では<strong>平均の音量に揃えます</strong>。誰か一人を基準にすると他の全員が
        片方向へ動くことになり、上限に当たって差が埋まりきらないためです(移動幅は
        最大 {MAX_BOOST_DB}dB)。仕上がり全体の音量は、このあと −19 LUFS へ揃えます。
      </p>

      <button className="primary" onClick={() => onStart(files, manual, tracks, matchTone)}>
        🎬 この設定で変換する
      </button>
      <button onClick={onCancel}>選び直す</button>
    </div>
  );
}
