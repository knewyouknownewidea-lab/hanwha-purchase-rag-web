// 간이 로그인 (시연용) — 이름·사번만 이 브라우저에 저장한다. 비밀번호를 받지 않으며 보안 인증이 아니다.
import { readStore, removeStore, storeKeys, userKey, writeStore } from "./storage";
import { idbDel } from "./idb";

export interface User {
  id: string;
  name: string;
  dept?: string;
  createdAt: string;
  lastLogin: string;
  demo?: boolean;
}

const USERS_KEY = "users.v1";
const CURRENT_KEY = "current-user.v1";
const LEGACY_KEYS = ["session.v2", "view-settings.v2"]; // v0.2.0 저장 내용 (사용자 구분 없음)

export const listUsers = (): User[] => (readStore<User[]>(USERS_KEY) ?? []).filter((u) => u && u.id && u.name);

export function currentUser(): User | null {
  const id = readStore<string>(CURRENT_KEY);
  return id ? listUsers().find((u) => u.id === id) ?? null : null;
}

const newId = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function save(user: User) {
  const users = listUsers().filter((u) => u.id !== user.id);
  writeStore(USERS_KEY, [user, ...users].slice(0, 20));
  writeStore(CURRENT_KEY, user.id);
}

export function login(name: string, dept?: string): User {
  const n = name.trim();
  const d = (dept ?? "").trim();
  const now = new Date().toISOString();
  const existing = listUsers().find((u) => u.name === n && (u.dept ?? "") === d);
  const user: User = existing ? { ...existing, lastLogin: now } : { id: newId(), name: n, dept: d || undefined, createdAt: now, lastLogin: now };
  save(user);
  migrateLegacy(user.id);
  return user;
}

export function demoLogin(): User {
  const now = new Date().toISOString();
  const existing = listUsers().find((u) => u.id === "demo");
  const user: User = existing ? { ...existing, lastLogin: now } : { id: "demo", name: "시연 계정", dept: "구매팀 (데모)", createdAt: now, lastLogin: now, demo: true };
  save(user);
  migrateLegacy(user.id);
  return user;
}

export function switchTo(id: string): User | null {
  const u = listUsers().find((x) => x.id === id);
  if (!u) return null;
  const user = { ...u, lastLogin: new Date().toISOString() };
  save(user);
  return user;
}

/** v0.2.0 때 저장된 대화·결과·보기 설정을 처음 로그인한 사용자에게 옮긴다 */
export function migrateLegacy(userId: string) {
  for (const k of LEGACY_KEYS) {
    const v = readStore<unknown>(k);
    if (v === null) continue;
    const target = userKey(userId, k === "session.v2" ? "session.v3" : k);
    if (readStore(target) === null) writeStore(target, v);
    removeStore(k);
  }
}

/** 로그아웃. wipe면 이 사용자의 저장 내용(대화·이력·설정·관심 목록·업로드 데이터)도 지운다 */
export async function logout(userId: string, wipe: boolean) {
  removeStore(CURRENT_KEY);
  if (!wipe) return;
  for (const k of storeKeys(`u:${userId}:`)) removeStore(k);
  writeStore(
    USERS_KEY,
    listUsers().filter((u) => u.id !== userId),
  );
  await idbDel(userKey(userId, "uploads"));
}
