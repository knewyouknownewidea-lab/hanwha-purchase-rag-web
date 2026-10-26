// 이 브라우저에만 저장 (localStorage). 비공개 창·저장 차단 환경에서는 조용히 저장 없이 동작한다.
const PREFIX = "procure-ai:";

export function readStore<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStore(key: string) {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* 저장소를 쓸 수 없는 환경 */
  }
}

/** 접두어로 시작하는 저장 키 목록 (PREFIX 제외) */
export function storeKeys(startsWith = ""): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX + startsWith)) out.push(k.slice(PREFIX.length));
    }
    return out;
  } catch {
    return [];
  }
}

/** 사용자별 저장 키: u:{사용자ID}:{이름} */
export const userKey = (userId: string, key: string) => `u:${userId}:${key}`;
