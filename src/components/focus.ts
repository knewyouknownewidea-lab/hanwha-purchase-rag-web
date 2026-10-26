// 대화상자 키보드 조작 도우미
import { useEffect, type KeyboardEvent } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 대화상자 안에서 Tab·Shift+Tab이 바깥으로 나가지 않고 처음·끝에서 돌아오게 한다 */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/** 열릴 때 초점이 있던 곳을 기억했다가 닫힐 때 돌려준다 (그 요소가 아직 화면에 있을 때만) */
export function useReturnFocus() {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      if (prev && prev.isConnected && prev !== document.body) setTimeout(() => prev.isConnected && prev.focus({ preventScroll: true }), 0);
    };
  }, []);
}
