// 빌드: esbuild로 번들한 JS·CSS를 HTML 한 파일에 넣는다.
//   node scripts/build.mjs          → dist/index.html    (로컬·GitHub 실행용, 한화엔진 로고·표기 포함)
//                                      dist/artifact.html (claude.ai 공유 링크 게시용 본문, 회사 로고·이름 없음)
//   node scripts/build.mjs --watch  → 소스가 바뀔 때마다 다시 빌드
import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");
mkdirSync(dist, { recursive: true });

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">';

const TARGETS = [
  { brand: "hanwha", title: "한화엔진 구매·협력사 AI 분석 플랫폼", out: "index.html", full: true },
  { brand: "neutral", title: "구매·협력사 AI 분석", out: "artifact.html", full: false },
];

function writeHtml(target, result) {
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  const html = target.full
    ? `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<title>${target.title}</title>\n${FONTS}\n<style>${css}</style></head>\n<body><div id="root"></div><script>${safeJs}</script></body></html>\n`
    : `<title>${target.title}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${FONTS}\n<style>${css}</style>\n<div id="root"></div>\n<script>${safeJs}</script>\n`;
  writeFileSync(join(dist, target.out), html);
  console.log(`[build] dist/${target.out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${target.brand})`);
}

const options = (target) => ({
  entryPoints: [join(root, "src", "main.tsx")],
  bundle: true,
  minify: !watch,
  sourcemap: false,
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  outdir: join(dist, ".tmp-" + target.brand),
  write: false,
  loader: { ".json": "json", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  legalComments: "none",
  logLevel: "warning",
  plugins: [
    {
      // "virtual:brand" → src/brand/hanwha.ts 또는 neutral.ts (공유 링크 빌드에는 로고 파일이 들어가지 않는다)
      name: "brand",
      setup(build) {
        build.onResolve({ filter: /^virtual:brand$/ }, () => ({ path: join(root, "src", "brand", `${target.brand}.ts`) }));
      },
    },
    {
      name: "single-html",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length) return;
          writeHtml(target, result);
        });
      },
    },
  ],
});

if (watch) {
  for (const t of TARGETS) {
    const ctx = await esbuild.context(options(t));
    await ctx.watch();
  }
  console.log("[build] 변경을 감시합니다");
} else {
  await Promise.all(TARGETS.map((t) => esbuild.build(options(t))));
}
