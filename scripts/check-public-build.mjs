import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const secret = /AIza[A-Za-z0-9_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const forbidden = /(^|\/)(station|private-audio|\.env(?:\.[^/]+)?)(\/|$)|\.(mp3|wav|m4a|aac|flac|opus|ogg|caf|aiff|map|pem|p12|key)$/i;

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const path = relative(root, file).split("\\").join("/");
    if (entry.isSymbolicLink() || forbidden.test(path)) {
      throw new Error(`公開成果物に禁止対象が含まれています: ${path}`);
    }
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|html|json)$/i.test(path) && secret.test(readFileSync(file, "utf8"))) {
      throw new Error(`公開成果物に資格情報の疑いがあります: ${path}`);
    }
  }
}
walk(root);
if (/AudioPanel-/.test(readFileSync(join(root, "sw.js"), "utf8"))) {
  throw new Error("AUDIOの入口がサービスワーカーで先読みされています。");
}
console.log("OK: public build audio, private directories, source maps and prefetch checks");
