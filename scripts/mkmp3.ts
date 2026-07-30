// 圧縮入力のテスト用に、間を持つ2分の音声を MP3 で書き出す
import { writeFileSync } from "node:fs";
import { encodeMp3 } from "../src/lib/audio/mp3";

const OUT = process.argv[2] ?? "call.mp3";
const SR = 44100, secs = 120, frames = SR * secs;
const a = new Float32Array(frames);
let ph = 0;
for (let i = 0; i < frames; i++) {
  const t = i / SR;
  const voiced = (t % 25) < 20; // 20秒話して5秒黙る
  let v = (Math.random() - 0.5) * 0.0008;
  if (voiced) {
    const f0 = 140 + 15 * Math.sin(2 * Math.PI * 0.9 * t);
    ph += (2 * Math.PI * f0) / SR;
    v += 0.07 * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph));
  }
  a[i] = v;
}
encodeMp3([a], SR, 128).then((buf) => {
  writeFileSync(OUT, new Uint8Array(buf));
  console.log(`${OUT} 作成 ${(buf.byteLength / 1024 / 1024).toFixed(2)} MB / 2分`);
});
