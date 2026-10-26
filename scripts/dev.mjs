// 개발 실행: 소스 변경 감시 빌드 + 로컬 서버를 함께 띄운다 (npm run dev)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args) => spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
const build = run(["scripts/build.mjs", "--watch"]);
const server = run(["server/index.mjs"]);
const stop = () => {
  build.kill();
  server.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
