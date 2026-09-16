// 60分の回。実際に使う長さで、時間とメモリが持つかを見る。
const fs = require("fs");
const SR = 44100, MIN = 60, N = SR * 60 * MIN;
const fd = fs.openSync("long60.wav", "w");
const head = Buffer.alloc(44);
head.write("RIFF", 0); head.writeUInt32LE(36 + N * 2, 4); head.write("WAVE", 8);
head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
head.writeUInt16LE(1, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28);
head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
head.write("data", 36); head.writeUInt32LE(N * 2, 40);
fs.writeSync(fd, head);
const period = SR / 147;
const wave = new Float32Array(Math.ceil(period));
for (let h = 1; h * 147 < SR * 0.45; h++)
  for (let i = 0; i < wave.length; i++) wave[i] += Math.pow(h, -1.1) * Math.sin((2 * Math.PI * h * i) / period);
let pk = 0; for (const v of wave) pk = Math.max(pk, Math.abs(v));
for (let i = 0; i < wave.length; i++) wave[i] /= pk;
const CH = SR * 10;
const buf = Buffer.alloc(CH * 2);
for (let at = 0; at < N; at += CH) {
  const len = Math.min(CH, N - at);
  for (let i = 0; i < len; i++) {
    const g = at + i, t = g / SR;
    const inGap = t % 3 > 2.65;
    let v = inGap ? 0 : wave[g % wave.length] * 0.3 * (0.6 + 0.4 * Math.abs(Math.sin(t * 4)));
    v += (Math.random() - 0.5) * 0.0006;
    buf.writeInt16LE(Math.max(-32700, Math.min(32700, Math.round(v * 32700))), i * 2);
  }
  fs.writeSync(fd, buf, 0, len * 2);
}
fs.closeSync(fd);
console.log("long60.wav", (fs.statSync("long60.wav").size / 1024 / 1024).toFixed(0), "MB");
