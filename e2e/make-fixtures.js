// 声に近い波形のテスト用 WAV。基本周波数 147Hz の倍音列に抑揚と間を付ける。
const fs = require("fs");
const SR = 44100, SEC = 36;
const N = SR * SEC;
const buf = Buffer.alloc(44 + N * 2);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write("WAVE", 8);
buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write("data", 36); buf.writeUInt32LE(N * 2, 40);
const period = SR / 147;
const wave = new Float32Array(Math.ceil(period));
for (let h = 1; h * 147 < SR * 0.45; h++) {
  const amp = Math.pow(h, -1.1);
  for (let i = 0; i < wave.length; i++) wave[i] += amp * Math.sin((2 * Math.PI * h * i) / period);
}
let pk = 0; for (const v of wave) pk = Math.max(pk, Math.abs(v));
for (let i = 0; i < wave.length; i++) wave[i] /= pk;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const inGap = t % 3 > 2.65;
  let v = 0;
  if (!inGap) v = wave[i % wave.length] * 0.3 * (0.6 + 0.4 * Math.abs(Math.sin(t * 4)));
  v += (Math.random() - 0.5) * 0.0006;
  buf.writeInt16LE(Math.max(-32700, Math.min(32700, Math.round(v * 32700))), 44 + i * 2);
}
fs.writeFileSync("speechlike.wav", buf);
console.log("speechlike.wav", (buf.length / 1024 / 1024).toFixed(1), "MB");
