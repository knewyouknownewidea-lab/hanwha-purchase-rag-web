// 확인 창 (브라우저 기본 confirm 대신) — 되돌릴 수 없는 동작 전에 띄운다
import { useEffect, useRef, type ReactNode } from "react";
import { LuTriangleAlert } from "react-icons/lu";
import { trapTab, useReturnFocus } from "./focus";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "취소",
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "normal";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useReturnFocus();
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal modal-sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        ref={boxRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
          trapTab(e, boxRef.current);
        }}
      >
        <div className="modal-head">
          <h2 id="confirm-title">
            {tone === "danger" && <LuTriangleAlert aria-hidden className="confirm-ic" />} {title}
          </h2>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={onCancel} ref={cancelRef}>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} data-confirm>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
