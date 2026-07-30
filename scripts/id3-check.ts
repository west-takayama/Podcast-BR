// 自作の ID3 タグが第三者の実装で読めるかを検証する。
// mutagen(Python の標準的な ID3 ライブラリ)に読ませて突き合わせる。
// 実行: npx tsx scripts/id3-check.ts
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildId3Tag, toId3Chapters, parseTimestamp } from "../src/lib/id3";
import { encodeMp3 } from "../src/lib/audio/mp3";

const TITLE = "AIに任せられる仕事、まだ無理な仕事";
const SHOW = "ブリッジラジオ";
const DESC = "生成AIを一週間、実際の業務で使ってみた記録です。便利だった場面と限界を話しました。";

(async () => {
  const SR = 44100;
  const sig = new Float32Array(SR * 8);
  for (let i = 0; i < sig.length; i++) sig[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const mp3 = await encodeMp3([sig], SR, 96);

  // 小さな JPEG をアートワークとして用意する
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(0x10), 0xff, 0xd9,
  ]);

  const chapters = toId3Chapters(
    [
      { time: "00:00", label: "オープニング" },
      { time: "00:03", label: "AIツールの実例" },
      { time: "99:00", label: "音声長を超えるので捨てられるべき章" },
    ],
    8000,
  );

  const tag = buildId3Tag({
    title: TITLE,
    showName: SHOW,
    description: DESC,
    artwork: { data: jpeg, mime: "image/jpeg" },
    chapters,
    durationMs: 8000,
  });

  const out = new Uint8Array(tag.length + mp3.byteLength);
  out.set(tag, 0);
  out.set(new Uint8Array(mp3), tag.length);
  const path = "/tmp/claude-0/-home-user-Podcast-BR/3f859293-4465-5bd5-9206-d0b1525b93e2/scratchpad/tagged.mp3";
  writeFileSync(path, out);

  const script = `
import json, sys
from mutagen.id3 import ID3
from mutagen.mp3 import MP3
t = ID3(sys.argv[1])
m = MP3(sys.argv[1])
chaps = []
for k in t.keys():
    if k.startswith('CHAP'):
        f = t[k]
        sub = f.sub_frames.get('TIT2')
        chaps.append({'id': f.element_id, 'start': f.start_time, 'end': f.end_time,
                      'title': str(sub.text[0]) if sub else None})
chaps.sort(key=lambda c: c['start'])
toc = None
for k in t.keys():
    if k.startswith('CTOC'):
        toc = {'id': t[k].element_id, 'children': [c for c in t[k].child_element_ids]}
apic = [t[k] for k in t.keys() if k.startswith('APIC')]
print(json.dumps({
  'version': '.'.join(map(str, t.version)),
  'title': str(t['TIT2'].text[0]) if 'TIT2' in t else None,
  'artist': str(t['TPE1'].text[0]) if 'TPE1' in t else None,
  'album': str(t['TALB'].text[0]) if 'TALB' in t else None,
  'genre': str(t['TCON'].text[0]) if 'TCON' in t else None,
  'comment': str(list(t.getall('COMM'))[0].text[0]) if t.getall('COMM') else None,
  'artwork_mime': apic[0].mime if apic else None,
  'artwork_bytes': len(apic[0].data) if apic else 0,
  'artwork_type': apic[0].type if apic else None,
  'chapters': chaps, 'toc': toc,
  'audio_ok': m.info.length > 0, 'audio_len': round(m.info.length, 2),
}, ensure_ascii=False))
`;
  const raw = execFileSync("python3", ["-c", script, path], { encoding: "utf8" });
  const got = JSON.parse(raw);

  let fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };

  console.log("\n=== mutagen が読み取った内容 ===");
  check("ID3v2.3 として認識", got.version === "2.3.0", got.version);
  check("日本語タイトルが一致", got.title === TITLE, got.title);
  check("番組名(アーティスト)が一致", got.artist === SHOW, got.artist);
  check("番組名(アルバム)が一致", got.album === SHOW, got.album);
  check("ジャンル", got.genre === "Podcast", got.genre);
  check("日本語の説明文が一致", got.comment === DESC, `${String(got.comment).slice(0, 24)}…`);
  check("アートワークが埋め込まれる", got.artwork_mime === "image/jpeg" && got.artwork_bytes === jpeg.length,
    `${got.artwork_mime} ${got.artwork_bytes}B`);
  check("アートワークが表紙として登録", got.artwork_type === 3, String(got.artwork_type));
  check("音声が壊れていない", got.audio_ok === true, `${got.audio_len}秒`);

  console.log("\n=== チャプター ===");
  check("音声長を超える章は捨てられる", got.chapters.length === 2, `${got.chapters.length}件`);
  check("1章目", got.chapters[0]?.title === "オープニング" && got.chapters[0]?.start === 0,
    `${got.chapters[0]?.title} ${got.chapters[0]?.start}-${got.chapters[0]?.end}ms`);
  check("2章目の開始時刻", got.chapters[1]?.start === 3000,
    `${got.chapters[1]?.title} ${got.chapters[1]?.start}-${got.chapters[1]?.end}ms`);
  check("最終章の終了が音声長", got.chapters[1]?.end === 8000, `${got.chapters[1]?.end}ms`);
  check("章の間に隙間がない", got.chapters[0]?.end === got.chapters[1]?.start);
  check("目次が章を参照", got.toc?.children?.length === 2, JSON.stringify(got.toc));

  console.log("\n=== 時刻の解析 ===");
  check("MM:SS", parseTimestamp("04:30") === 270000);
  check("HH:MM:SS", parseTimestamp("01:12:30") === 4350000);
  check("60分超の分表記", parseTimestamp("72:30") === 4350000);
  check("不正な値は null", parseTimestamp("あ:い") === null && parseTimestamp("") === null);

  console.log(fail === 0 ? "\n✅ ALL OK\n" : `\n❌ ${fail} 件失敗\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
