// WAV → 整音 → MP3 変換を UI スレッドから切り離す Web Worker。
//
// ファイルは File.slice() でブロックごとに読む。全体を展開すると 60分ステレオで
// 1GB を超え、スマホでは確実に落ちるため。
//
// 2パス構成:
//   1回目 ノイズフロアを測る
//   2回目 整音した状態の積分ラウドネス(LUFS)を測る
//   (必要時) リミッターで下がる分を試し処理で測り、ゲインを補正する
//   最後  整音 → 目標ラウドネスへ調整 → リミッター → MP3を2本書き出す
//     - 配信用: 設定のビットレート
//     - AI用  : モノラル 32kbps。アップロード量を約4分の1に減らすため
//
// ラウドネスは配信されるチャンネル構成で測る。モノラルに落とすと合算が減って
// 約3dB下がるため、ステレオのまま測ると目標を外す。
//
// purpose:"ai" のときは上の手順を全部飛ばし、1回読んで AI 用の1本だけ作る。
// 「ショート」ページは配信用 MP3 も揃った音量も使わないため(3〜4倍速い)。
//
// 受信: { file, dsp, mono, bitrate, purpose? }
// 送信: { type:"progress", stage, fraction } / { type:"done", ... } / { type:"error", message }

import {
  Analyzer,
  HighPassFilter,
  LowPassFilter,
  NoiseReducer,
  PauseDetector,
  SilenceTrimmer,
  SpeechLeveler,
  applyGain,
  type DspOptions,
} from "./audio/dsp";
import { LoudnessMeter, gainForTarget, targetLufs } from "./audio/loudness";
import { Diagnostics } from "./audio/diagnostics";
import { CEILING_DBFS, Limiter } from "./audio/limiter";
import { openAudio, type BlockHandler, type BlockReader } from "./audio/source";
import { MixedReader, dbToGain, matchGainsDb, type MixSource } from "./audio/mix";
import { SpectrumMeter, matchToneDb, toneFilters, toneLevelShiftDb, BANDS } from "./audio/tone";
import type { ToneCurve } from "./audio/tone";
import { Mp3Stream, decimationFactor } from "./audio/mp3";

const BLOCK_SECONDS = 10;
const AI_BITRATE_KBPS = 32;

interface Request {
  file: File;
  /**
   * 人ごとに分かれた音声。オンライン収録の道具は参加者ごとに別ファイルで
   * 書き出せるものが多く、分かれていれば別々に音量を測って合わせられる。
   * 1件だけなら file と同じ扱い。
   */
  files?: File[];
  /** 各ファイルに掛ける手動の増減(dB)。自動で合わせた上に足す。 */
  manualDb?: number[];
  /** 話者どうしの音色を揃えるか。既定は揃える。 */
  matchTone?: boolean;
  /**
   * 測定済みの結果。選択画面で一度測っているので、変換のときは測り直さない。
   * 測り直すと 10分の素材で3秒ほど無駄になる。
   */
  measured?: TrackInfo[];
  dsp: DspOptions;
  mono: boolean;
  bitrate: number;
  /**
   * "ai" にすると、AI に聴かせる音声だけを1パスで作る。
   * 「ショート」ページのように配信用 MP3 が要らない場面のためのもの。
   */
  purpose?: "publish" | "ai" | "measure";
}

/**
 * 人ごとのファイルを1本にまとめる読み手を作る。
 *
 * 音量の測定は各ファイルを1回ずつ読むだけで済む(エンコードしない)ので軽い。
 * 測った結果から倍率を決め、以降の変換はまとめた1本として流す。
 */
async function openMixed(
  files: File[],
  manualDb: number[],
  blockSeconds: number,
  measured?: TrackInfo[],
  matchTone = true,
): Promise<{ reader: BlockReader; tracks: TrackInfo[] }> {
  const readers = await Promise.all(files.map((f) => openAudio(f, blockSeconds)));

  // サンプリングレートが違うと足したときに速度がずれる。
  // 同じ収録の書き出しなら揃っているはずなので、違う場合は直してもらう
  const rates = [...new Set(readers.map((r) => r.sampleRate))];
  if (rates.length > 1) {
    throw new Error(
      `音声のサンプリングレートが揃っていません(${rates.join(" / ")}Hz)。` +
        `同じ設定で書き出し直してください。`,
    );
  }

  // 測定済みなら測り直さない。選択画面で既に1回読んでいる
  const reuse = measured?.length === files.length ? measured : null;
  // 音量と音色は同じ1回の読み込みで測る
  const measurements = reuse
    ? reuse.map((t) => ({ lufs: t.lufs, curve: t.tone ?? null }))
    : await Promise.all(
        readers.map(async (r) => {
          const meter = new LoudnessMeter(r.sampleRate, r.numChannels);
          const spectrum = new SpectrumMeter(r.sampleRate, r.durationSec);
          await r.read((channels, length) => {
            meter.push(channels, length);
            // 音色は元の波形で測る。ゲインを掛けても形は変わらない
            spectrum.push(channels, length);
          });
          return { lufs: meter.integratedLufs(), curve: spectrum.curve() };
        }),
      );
  const lufs = measurements.map((m) => m.lufs);
  const sampleRate = readers[0].sampleRate;
  // 音色を揃えるかは呼び出し側が決める(既定は揃える)
  const toneFix = matchTone
    ? matchToneDb(measurements.map((m) => m.curve))
    : measurements.map(() => BANDS.map(() => 0));
  // 音量を揃えるための増減。画面に出すのはこちら
  const matchDb = matchGainsDb(lufs, manualDb);
  // 音色を直すと音量も動く。そのぶんを差し引いて、上の狙い通りに着地させる。
  // 差し引かないと、音色を揃えたせいで音量が最大 5.7dB ずれる(実測)
  const toneShift = measurements.map((m, i) =>
    m.curve ? toneLevelShiftDb(sampleRate, m.curve, toneFix[i]) : 0,
  );
  const gainsDb = matchDb.map((g, i) => g - toneShift[i]);
  const tracks: TrackInfo[] = files.map((f, i) => ({
    name: f.name,
    lufs: lufs[i],
    gainDb: matchDb[i],
    durationSec: readers[i].durationSec,
    tone: measurements[i].curve ?? undefined,
    toneFixDb: toneFix[i],
  }));

  const info = {
    sampleRate,
    // 1本でもステレオが混ざっていればステレオで扱う
    numChannels: Math.max(...readers.map((r) => r.numChannels)),
    durationSec: Math.max(...readers.map((r) => r.durationSec)),
    formatLabel: `${files.length}トラックを合成`,
  };
  const open = async (): Promise<MixSource[]> => {
    // 読み直しのたびに開き直す。読み手は先頭からしか進めないため
    const fresh = await Promise.all(files.map((f) => openAudio(f, blockSeconds)));
    return fresh.map((reader, i) => ({
      reader,
      gain: dbToGain(gainsDb[i]),
      filters: toneFilters(reader.sampleRate, reader.numChannels, toneFix[i]),
    }));
  };
  return {
    reader: new MixedReader(open, info, sampleRate * blockSeconds),
    tracks,
  };
}

export interface TrackInfo {
  name: string;
  /** 測ったラウドネス。 */
  lufs: number;
  /**
   * 音量を揃えるための増減(dB)。
   * 音色の補正でも音量は動くが、それは内部で打ち消しているので、
   * 最終的にこの値どおりの音量差に着地する。
   */
  gainDb: number;
  durationSec: number;
  /** 測った帯域バランス(BANDS と同じ並び)。測り直しを省くために持ち回る。 */
  tone?: ToneCurve;
  /** 音色を揃えるための補正量(BANDS と同じ並び)。 */
  toneFixDb?: number[];
}

/** 音色を測る帯域。UI で見せるために公開する。 */
export { BANDS as TONE_BANDS };

/**
 * AI に聴かせる音声だけを作る速い経路。
 *
 * 通常の変換は「ノイズフロアを測る → 整音後のラウドネスを測る →
 * (必要なら試し処理)→ 本番」と最大4回読む。配信する音を狙った音量に
 * 収めるために要る手順だが、**AI に聴かせるだけなら1回も要らない**。
 * ラウドネスもリミッターも配信用 MP3 も捨てるだけなので、丸ごと省く。
 */
async function runAiOnly(file: File, dsp: DspOptions): Promise<void> {
  const reader = await openAudio(file, BLOCK_SECONDS);
  if (!(reader.durationSec > 0)) throw new Error("音声データが空です");
  const sampleRate = reader.sampleRate;
  const numChannels = reader.numChannels;

  const factor = decimationFactor(sampleRate);
  const outRate = sampleRate / factor;
  // 間引く前に折り返し防止の低域通過を入れる。入れないと高い音が
  // 低い音に化けて紛れ込み、聞き取りを邪魔する。
  // バイカッド1段では新しいナイキスト(outRate/2)の少し上が素通りしてしまうので
  // 3段重ねる。声の明瞭度に要るのは 8kHz あたりまでなので、切り所は低めでよい。
  // バイカッド3本は全体の処理時間からすれば誤差の範囲。
  const antiAlias =
    factor > 1
      ? Array.from({ length: 3 }, () => new LowPassFilter(sampleRate, numChannels, outRate * 0.40))
      : [];
  // 低域の暗騒音(空調・机の振動)は落としておく。安いわりに効く
  const hp = dsp.highPass ? new HighPassFilter(sampleRate, numChannels) : null;

  const stream = new Mp3Stream(1, outRate, AI_BITRATE_KBPS);
  // ブロックの長さは読み手まかせ(デコーダ経由だと可変)なので、足りなければ広げる
  let scratch = new Float32Array(Math.ceil((sampleRate * (BLOCK_SECONDS + 1)) / factor));
  let frames = 0;
  // 間引きの位相をブロックをまたいで保つ。ブロックごとに 0 に戻すと
  // 継ぎ目でサンプルが増減して、わずかに時刻がずれる
  let phase = 0;

  await reader.read(async (channels, length, fraction) => {
    if (hp) hp.process(channels, length);
    for (const lp of antiAlias) lp.process(channels, length);

    const need = Math.ceil(length / factor) + 1;
    if (scratch.length < need) scratch = new Float32Array(need);

    // モノラル化と間引きを1回のループでまとめる
    let n = 0;
    if (numChannels === 1) {
      const ch = channels[0];
      for (let i = phase; i < length; i += factor) scratch[n++] = ch[i];
    } else {
      const l = channels[0];
      const r = channels[1];
      for (let i = phase; i < length; i += factor) scratch[n++] = (l[i] + r[i]) * 0.5;
    }
    phase = (phase - length) % factor;
    if (phase < 0) phase += factor;

    frames += n;
    await stream.write([scratch], n);
    post("process", fraction);
  });

  const aiMp3 = await stream.finish();
  self.postMessage(
    {
      type: "done",
      aiMp3,
      durationSec: frames / outRate,
      sourceDurationSec: reader.durationSec,
      inputFormat: reader.formatLabel,
      sampleRate: outRate,
      channels: 1,
    },
    [aiMp3],
  );
}

function post(stage: "analyze" | "process", fraction: number) {
  self.postMessage({ type: "progress", stage, fraction });
}

/** ステレオを平均してモノラルにする。左右で位相が揃った音声を前提とする。 */
function downmix(channels: Float32Array[], length: number, out: Float32Array): Float32Array {
  if (channels.length === 1) {
    out.set(channels[0].subarray(0, length));
  } else {
    const l = channels[0];
    const r = channels[1];
    for (let i = 0; i < length; i++) out[i] = (l[i] + r[i]) * 0.5;
  }
  return out.subarray(0, length);
}

self.onmessage = async (e: MessageEvent<Request>) => {
  try {
    const { file, dsp, mono, bitrate, purpose } = e.data;
    const files = e.data.files?.length ? e.data.files : [file];
    const manualDb = e.data.manualDb ?? [];

    // AI に聴かせるだけなら、測るための読み直しも配信用 MP3 も要らない
    if (purpose === "ai") return await runAiOnly(file, dsp);

    // 音量を測るだけ。変換の前に「どれだけ合わせるか」を見せるために使う
    if (purpose === "measure") {
      const { tracks } = await openMixed(files, manualDb, BLOCK_SECONDS, undefined, e.data.matchTone !== false);
      self.postMessage({ type: "done", tracks });
      return;
    }

    // 人ごとに分かれていれば、音量を揃えてから1本にまとめる。
    // まとめた結果は BlockReader として振る舞うので、以降の流れは変わらない
    const mixed =
      files.length > 1
        ? await openMixed(files, manualDb, BLOCK_SECONDS, e.data.measured, e.data.matchTone !== false)
        : null;
    const reader = mixed ? mixed.reader : await openAudio(file, BLOCK_SECONDS);
    if (!(reader.durationSec > 0)) throw new Error("音声データが空です");
    // 以降の処理はブロック単位で読み進める。WAV は専用経路、
    // それ以外はデコーダを通すが、呼び出し側からは同じ形で扱える
    const info = {
      sampleRate: reader.sampleRate,
      numChannels: reader.numChannels,
      durationSec: reader.durationSec,
    };
    const forEachBlock = async (_f: unknown, _i: unknown, onBlock: BlockHandler) => {
      await (reader as BlockReader).read(onBlock);
    };

    const outChannels = mono ? 1 : info.numChannels;
    const target = targetLufs(outChannels);

    const monoScratch = new Float32Array(info.sampleRate * BLOCK_SECONDS);

    // --- 1回目: ノイズフロアを測る ---
    // ハイパスを通してから測る。低域の暗騒音を含んだままだと過大評価になる。
    const analyzer = new Analyzer(info.sampleRate);
    // 収録そのものの問題は、処理を通す前の生の状態でないと分からない
    const diagnostics = new Diagnostics();
    const rawMeter = new LoudnessMeter(info.sampleRate, info.numChannels);
    const floorHp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    // 声の大きさの移り変わりも同じ読みで溜める。読み直しは増やさない
    const leveler = dsp.levelSpeech ? new SpeechLeveler(info.sampleRate) : null;
    await forEachBlock(file, info, (channels, length, fraction) => {
      diagnostics.push(channels, length);
      rawMeter.push(channels, length);
      if (floorHp) floorHp.process(channels, length);
      analyzer.push(channels, length);
      leveler?.push(channels, length);
      post("analyze", fraction / 3);
    });
    const { noiseFloor, voiceRms } = analyzer.result();
    // SNR は「声が鳴っている区間の RMS」と比べる。全体の RMS で比べると
    // 沈黙の多い回ほど声が小さく見え、環境音の警告が誤って出る。
    const findings = diagnostics.result(
      info.sampleRate,
      rawMeter.integratedLufs(),
      noiseFloor,
      voiceRms,
    );
    // 声の大きさを揃える曲線。ここから先のパスは「揃えたあと」を見る。
    // 揃える前で測ると、目標のラウドネスを外す
    const curve = leveler ? leveler.build(noiseFloor) : null;
    const levelRange = curve && !curve.isEmpty ? curve.rangeDb : null;

    // 2人別マイクの独立処理では、チャンネルごとのノイズフロアを使う
    const perChannel = dsp.perChannelNoise && info.numChannels > 1;
    const floors: number | number[] = perChannel ? analyzer.channelNoiseFloors() : noiseFloor;
    const makeNr = () =>
      dsp.noiseReduction ? new NoiseReducer(info.sampleRate, floors, perChannel) : null;

    // --- 2回目: 整音後のラウドネスを測る ---
    // ノイズ低減は信号の音量を下げるため、その後の状態で測らないと
    // 目標ラウドネスを外す(実測で 9dB 以上ずれた)。
    // ノイズ低減にはノイズフロアが必要で、それには全体を見る必要があるため、
    // 解析を2回に分けている。読み込みは軽く、変換に比べれば僅かな時間で済む。
    const meter = new LoudnessMeter(info.sampleRate, outChannels);
    const measureHp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    const measureNr = makeNr();
    curve?.reset();
    await forEachBlock(file, info, (channels, length, fraction) => {
      if (measureHp) measureHp.process(channels, length);
      if (measureNr) measureNr.process(channels, length);
      curve?.process(channels, length);
      // ラウドネスは配信されるチャンネル構成で測る
      meter.push(
        outChannels === 1 ? [downmix(channels, length, monoScratch)] : channels,
        length,
      );
      post("analyze", 1 / 3 + fraction / 3);
    });

    const measuredLufs = meter.integratedLufs();
    let gain = gainForTarget(measuredLufs, target);
    let correctionDb = 0;

    // --- 必要なときだけ: リミッターの効きを見て音量を補正する ---
    //
    // 突発的な大音量(笑い声など)は全体エネルギーの多くを占めることがあり、
    // それをリミッターで抑えると積分ラウドネスが目標より下がる(実測で 1.9dB)。
    // そこで一度だけ試し処理をして、下がった分を足し戻す。
    //
    // ゲインを掛けてもピークが上限に届かない素材ではリミッターが働かないので、
    // その場合はこのパスを省いて時間を無駄にしない。会話中心の録音では
    // ピーク余裕が大きく、多くの場合ここは省かれる。
    const peakAfterGainDb = meter.peakDbfs() + 20 * Math.log10(gain);
    const needsCorrection = Number.isFinite(measuredLufs) && peakAfterGainDb > CEILING_DBFS;

    if (needsCorrection) {
      const trialMeter = new LoudnessMeter(info.sampleRate, outChannels);
      const trialLimiter = new Limiter(info.sampleRate, outChannels);
      const trialHp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
      const trialNr = makeNr();

      curve?.reset();
      await forEachBlock(file, info, (channels, length, fraction) => {
        if (trialHp) trialHp.process(channels, length);
        if (trialNr) trialNr.process(channels, length);
        curve?.process(channels, length);
        const shaped =
          outChannels === 1 ? [downmix(channels, length, monoScratch)] : channels;
        applyGain(shaped, length, gain);
        trialLimiter.process(shaped, length, (limited, len) => trialMeter.push(limited, len));
        post("analyze", 2 / 3 + fraction / 3);
      });
      trialLimiter.flush((limited, len) => trialMeter.push(limited, len));

      const achieved = trialMeter.integratedLufs();
      if (Number.isFinite(achieved)) {
        // 足し戻しは +6dB までに制限する。これを超えるほど抑制が必要な素材は
        // 無理に持ち上げると抑揚が失われるため、狙いを外したまま報告する
        correctionDb = Math.min(6, Math.max(0, target - achieved));
        gain *= Math.pow(10, correctionDb / 20);
      }
    }
    post("analyze", 1);

    // --- 3回目: 整音して MP3 を書き出す ---
    const publish = new Mp3Stream(outChannels, info.sampleRate, bitrate);
    const forAi = new Mp3Stream(1, info.sampleRate, AI_BITRATE_KBPS);

    const hp = dsp.highPass ? new HighPassFilter(info.sampleRate, info.numChannels) : null;
    const nr = makeNr();
    const trimmer = dsp.trimSilence
      ? new SilenceTrimmer(info.sampleRate, info.numChannels, noiseFloor)
      : null;
    const limiter = new Limiter(info.sampleRate, outChannels);
    // 仕上がりのラウドネスを実測して報告する。リミッターが働いた分だけ
    // 目標から下がるため、狙い通りかを利用者が確認できるようにする
    const outMeter = new LoudnessMeter(info.sampleRate, outChannels);
    // 話の切り替わり候補。出力の時間軸で拾うので、無音カット後でも再生位置と一致する
    const pauses = new PauseDetector(info.sampleRate, noiseFloor);

    let outputFrames = 0;

    // 無音カットは 20ms 単位で出力してくる。そのまま流すとエンコーダへの
    // 呼び出しが細かすぎるので、ブロック分を溜めてからまとめて渡す。
    const queue: { channels: Float32Array[]; length: number }[] = [];
    let queuedFrames = 0;

    const collect = (channels: Float32Array[], length: number) => {
      if (length <= 0) return;
      queue.push({ channels: channels.map((ch) => ch.subarray(0, length)), length });
      queuedFrames += length;
    };

    const monoOut = new Float32Array(info.sampleRate * (BLOCK_SECONDS + 2));

    /** リミッター通過後のサンプルをエンコーダへ渡す。 */
    const writeLimited = async (limited: Float32Array[], length: number) => {
      outputFrames += length;
      outMeter.push(limited, length);
      pauses.push(limited, length);
      const monoView =
        outChannels === 1 ? limited[0].subarray(0, length) : downmix(limited, length, monoOut);
      await publish.write(limited, length);
      await forAi.write([monoView], length);
    };

    const drain = async () => {
      if (queuedFrames === 0) return;
      const total = queuedFrames;
      const merged = Array.from({ length: info.numChannels }, () => new Float32Array(total));
      let at = 0;
      for (const item of queue) {
        for (let c = 0; c < info.numChannels; c++) merged[c].set(item.channels[c], at);
        at += item.length;
      }
      queue.length = 0;
      queuedFrames = 0;

      // 配信チャンネル数へ落としてからゲインとリミッターを通す
      const shaped =
        outChannels === 1 ? [downmix(merged, total, monoOut)] : merged;
      applyGain(shaped, total, gain);

      const pending: Promise<void>[] = [];
      limiter.process(shaped, total, (limited, len) => {
        pending.push(writeLimited(limited, len));
      });
      await Promise.all(pending);
    };

    curve?.reset();
    await forEachBlock(file, info, async (channels, length, fraction) => {
      if (hp) hp.process(channels, length);
      if (nr) nr.process(channels, length);
      // 無音カットより前に掛ける。解析と同じ時間軸でないと位置がずれる
      curve?.process(channels, length);

      if (trimmer) trimmer.process(channels, length, collect);
      else collect(channels, length);

      // ブロックごとに必ず書き出す。共有バッファが次のブロックで
      // 上書きされる前にエンコーダへコピーさせる必要があるため。
      await drain();
      post("process", fraction);
    });

    let removedSec = 0;
    if (trimmer) {
      const removedFrames = trimmer.finish(collect);
      removedSec = removedFrames / info.sampleRate;
    }
    await drain();

    // 先読み分の残りを出し切る
    const tail: Promise<void>[] = [];
    limiter.flush((limited, len) => {
      tail.push(writeLimited(limited, len));
    });
    await Promise.all(tail);

    const [publishMp3, aiMp3] = await Promise.all([publish.finish(), forAi.finish()]);

    self.postMessage(
      {
        type: "done",
        mp3: publishMp3,
        aiMp3,
        durationSec: outputFrames / info.sampleRate,
        sourceDurationSec: info.durationSec,
        inputFormat: reader.formatLabel,
        // 人ごとにどれだけ合わせたか。結果画面で見せる
        tracks: mixed?.tracks,
        removedSec,
        channels: outChannels,
        sampleRate: info.sampleRate,
        // 音量の実測値。UI で狙い通りか示すために返す
        sourceLufs: measuredLufs,
        outputLufs: outMeter.integratedLufs(),
        targetLufs: target,
        correctionDb,
        peakDbfs: outMeter.peakDbfs(),
        limitedSamples: limiter.reducedSamples,
        // 声の大きさをどれだけ動かしたか。効いたかどうかを見せる
        levelRange,
        // チャプター時刻を吸着させるための候補位置(秒)
        pauses: pauses.result(),
        // 収録そのものの問題。次回の設定で直せるものが多いので伝える
        findings,
      },
      [publishMp3, aiMp3],
    );
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
