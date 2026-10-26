// 가로로 넘치는 표: 옆에 더 볼 열이 있으면 가장자리에 그림자를 보여 준다 (처음 쓰는 사람이 가로 스크롤을 알아채도록)
import { useEffect, useRef, type ReactNode } from "react";

export function ScrollX({ className = "", children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const shell = el?.parentElement;
    if (!el || !shell) return;
    // 스크롤할 때마다 다시 그리지 않도록 상태 대신 클래스만 바꾼다
    const update = () => {
      const rest = el.scrollWidth - el.clientWidth - el.scrollLeft;
      shell.classList.toggle("can-l", el.scrollLeft > 2);
      shell.classList.toggle("can-r", rest > 2);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  return (
    <div className="scroll-shell">
      <div ref={ref} className={`table-scroll ${className}`}>
        {children}
      </div>
    </div>
  );
}
