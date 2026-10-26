// 단일 Worker ESM을 만든다. 실행 중 비밀 환경변수를 번들에 주입하지 않는다.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let out = join(root, "hosting", "dist");
let siteSource = null;
let appBuild = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--skip-app-build") { appBuild = false; continue; }
  if ((args[i] === "--out" || args[i] === "--site-source") && args[i + 1] && !args[i + 1].startsWith("--")) {
    const value = resolve(args[++i]);
    if (args[i - 1] === "--out") out = value;
    else siteSource = value;
    continue;
  }
  throw new Error("사용법: node hosting/build.mjs [--skip-app-build] [--out <artifact-directory>] [--site-source <Sites-checkout>]");
}
if (appBuild) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const outfile = join(out, "server", "index.js");
await mkdir(dirname(outfile), { recursive: true });
await build({ entryPoints: [join(root, "hosting", "worker.mjs")], outfile, bundle: true, format: "esm", platform: "browser", target: "es2022", loader: { ".html": "text" }, minify: true, legalComments: "none", logLevel: "warning" });
const artifact = await readFile(outfile);
console.log(JSON.stringify({ worker: outfile, bytes: artifact.byteLength, sha256: createHash("sha256").update(artifact).digest("hex") }));
if (siteSource) {
  const target = join(siteSource, "worker", "index.js");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(outfile, target);
  console.log(JSON.stringify({ siteSource: target }));
}
