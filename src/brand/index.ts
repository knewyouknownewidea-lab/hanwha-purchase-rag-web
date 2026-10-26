// 빌드할 때 scripts/build.mjs가 "virtual:brand"를 hanwha.ts 또는 neutral.ts로 바꿔 끼운다.
// (타입 검사·테스트에서는 neutral을 기본으로 본다)
export { BRAND } from "virtual:brand";
export type { Brand } from "./types";
