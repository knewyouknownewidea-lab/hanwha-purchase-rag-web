// Python RAG와 브라우저 업로드가 같은 필드·기본 키를 사용하도록 확인한다.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const source = new URL("../src/data/schema.ts", import.meta.url);
const target = new URL("../purchase-rag/backend/web_schema.json", import.meta.url);
const { code } = transformSync(readFileSync(source, "utf8"), { loader: "ts", format: "esm" });
const { SCHEMAS } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
if (process.argv.includes("--write")) {
  writeFileSync(target, JSON.stringify(SCHEMAS, null, 2) + "\n");
  console.log("[schema] updated " + fileURLToPath(target));
} else {
  const saved = JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, ""));
  if (JSON.stringify(saved) !== JSON.stringify(SCHEMAS)) {
    throw new Error("RAG 업로드 스키마가 다릅니다. node scripts/check-rag-schema.mjs --write 실행 후 함께 검토하세요.");
  }
  console.log("[schema] 11 upload schemas match the Python RAG schema");
}
