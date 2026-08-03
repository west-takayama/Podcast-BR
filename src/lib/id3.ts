// ID3v2.3 タグの書き出し。
//
// これまで MP3 にタグが一切入っておらず、プレイヤーでは
// ファイル名しか表示されなかった。タイトル・番組名・アートワークを埋め込むと、
// 配信前の確認時も、リスナーの手元でも正しく表示される。
//
// チャプターは ID3v2 Chapter Frame Addendum(CHAP / CTOC)で書く。
// Apple Podcasts や Overcast などが対応しており、対応していないプレイヤーは
// 未知のフレームとして読み飛ばすため害がない。
//
// 文字コードは UTF-16LE(BOM付き)を使う。ID3v2.3 のもう一方の選択肢である
// ISO-8859-1 では日本語が表現できない。

export interface Chapter {
  /** 開始位置(ミリ秒)。 */
  startMs: number;
  endMs: number;
  title: string;
}

export interface Id3Options {
  title: string;
  /** 番組名。アーティストとアルバムの両方に入れる。 */
  showName: string;
  description: string;
  year?: number;
  /** アートワーク(JPEG推奨。PNGだと肥大するため)。 */
  artwork?: { data: Uint8Array; mime: string };
  chapters?: Chapter[];
  durationMs?: number;
}

const ENCODING_UTF16 = 0x01;

function utf16(text: string): Uint8Array {
  // BOM(0xFF 0xFE)+ UTF-16LE 本体 + 終端の2バイト
  const body = new Uint8Array(2 + text.length * 2 + 2);
  body[0] = 0xff;
  body[1] = 0xfe;
  let at = 2;
  for (const unit of text) {
    for (let i = 0; i < unit.length; i++) {
      const code = unit.charCodeAt(i);
      body[at++] = code & 0xff;
      body[at++] = code >> 8;
    }
  }
  return body.subarray(0, at + 2);
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function uint32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** ID3v2.3 のフレーム。サイズは同期安全整数ではなく素の32bit。 */
function frame(id: string, body: Uint8Array): Uint8Array {
  return concat([latin1(id), uint32be(body.length), new Uint8Array([0, 0]), body]);
}

function textFrame(id: string, text: string): Uint8Array {
  return frame(id, concat([new Uint8Array([ENCODING_UTF16]), utf16(text)]));
}

/** タグ全体のサイズだけは同期安全整数(各バイト7bit)で書く。 */
function synchsafe(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function apicFrame(data: Uint8Array, mime: string): Uint8Array {
  return frame(
    "APIC",
    concat([
      new Uint8Array([ENCODING_UTF16]),
      latin1(mime),
      new Uint8Array([0]), // MIME の終端
      new Uint8Array([0x03]), // 3 = 表紙(front cover)
      utf16("Cover"),
      data,
    ]),
  );
}

function chapFrame(id: string, chapter: Chapter): Uint8Array {
  return frame(
    "CHAP",
    concat([
      latin1(id),
      new Uint8Array([0]),
      uint32be(Math.max(0, Math.round(chapter.startMs))),
      uint32be(Math.max(0, Math.round(chapter.endMs))),
      // バイト位置は使わないので未使用を示す 0xFFFFFFFF を入れる
      uint32be(0xffffffff),
      uint32be(0xffffffff),
      textFrame("TIT2", chapter.title),
    ]),
  );
}

function ctocFrame(childIds: string[]): Uint8Array {
  return frame(
    "CTOC",
    concat([
      latin1("toc"),
      new Uint8Array([0]),
      // 0x02 = 最上位、0x01 = 順序あり
      new Uint8Array([0x03]),
      new Uint8Array([childIds.length]),
      ...childIds.map((id) => concat([latin1(id), new Uint8Array([0])])),
    ]),
  );
}

export function buildId3Tag(opts: Id3Options): Uint8Array {
  const frames: Uint8Array[] = [];

  if (opts.title) frames.push(textFrame("TIT2", opts.title));
  if (opts.showName) {
    frames.push(textFrame("TPE1", opts.showName));
    frames.push(textFrame("TALB", opts.showName));
  }
  frames.push(textFrame("TCON", "Podcast"));
  frames.push(textFrame("TYER", String(opts.year ?? new Date().getFullYear())));
  if (opts.durationMs) frames.push(textFrame("TLEN", String(Math.round(opts.durationMs))));

  if (opts.description) {
    // COMM は言語コード3バイトと短い説明が先に来る
    frames.push(
      frame(
        "COMM",
        concat([
          new Uint8Array([ENCODING_UTF16]),
          latin1("jpn"),
          utf16(""), // 短い説明(空)
          utf16(opts.description),
        ]),
      ),
    );
  }

  if (opts.artwork) frames.push(apicFrame(opts.artwork.data, opts.artwork.mime));

  const chapters = (opts.chapters ?? []).filter((c) => c.title);
  if (chapters.length > 0) {
    const ids = chapters.map((_, i) => `chp${i}`);
    frames.push(ctocFrame(ids));
    chapters.forEach((c, i) => frames.push(chapFrame(ids[i], c)));
  }

  const body = concat(frames);
  const header = concat([
    latin1("ID3"),
    new Uint8Array([3, 0]), // v2.3.0
    new Uint8Array([0]), // フラグなし
    synchsafe(body.length),
  ]);
  return concat([header, body]);
}

/** "MM:SS" または "HH:MM:SS" をミリ秒に変換する。読めない場合は null。 */
export function parseTimestamp(text: string): number | null {
  // AI は "01:23" のほかに "83"(秒)や "1:23.4" のように返してくることがある。
  // 読めないものを捨てると候補が全滅するため、素直に受け取れる形は受け取る。
  const cleaned = text.trim().replace(/[秒s]$/i, "").replace(/分/g, ":");
  if (!cleaned) return null;
  const parts = cleaned.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 1) return parts[0] * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

/**
 * 生成されたチャプター一覧を ID3 用に整える。
 * 終了時刻は次の開始時刻とし、最後は音声の長さに合わせる。
 * 開始時刻が音声長を超えるものは捨てる(AIが実時間を外すことがある)。
 */
export function toId3Chapters(
  chapters: { time: string; label: string }[],
  durationMs: number,
): Chapter[] {
  const parsed = chapters
    .map((c) => ({ startMs: parseTimestamp(c.time), title: c.label }))
    .filter((c): c is { startMs: number; title: string } => c.startMs !== null)
    .filter((c) => c.startMs < durationMs)
    .sort((a, b) => a.startMs - b.startMs);

  return parsed.map((c, i) => ({
    startMs: c.startMs,
    endMs: i + 1 < parsed.length ? parsed[i + 1].startMs : durationMs,
    title: c.title,
  }));
}

export function attachId3(mp3: ArrayBuffer, tag: Uint8Array): Blob {
  // タグを先頭に置くだけでよい。MP3 のフレームは自己同期するため、
  // 前に別データがあってもデコーダは正しく読み始められる。
  const out = new Uint8Array(tag.length + mp3.byteLength);
  out.set(tag, 0);
  out.set(new Uint8Array(mp3), tag.length);
  return new Blob([out.buffer], { type: "audio/mpeg" });
}
