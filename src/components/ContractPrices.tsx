// 협력사의 계약 단가: 계약마다 품목·단가·통화·단위를 한 줄씩 보여 준다. 여러 건이면 대표값 하나를 고르지 않는다.
import type { ContractView } from "../lib/metrics";

export const MAX_LINES = 3;

export const priceText = (c: Pick<ContractView, "unitPrice" | "currency">, unit: string | undefined) =>
  `${c.unitPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${c.currency} / ${unit || "단위 미등록"}`;

export const sortContracts = (list: ContractView[]) => [...list].sort((a, b) => a.itemName.localeCompare(b.itemName, "ko") || a.contractId.localeCompare(b.contractId));

export function ContractPrices({ list, unitOf }: { list: ContractView[]; unitOf: (itemCode: string) => string | undefined }) {
  if (!list.length) return <span className="muted">계약 없음</span>;
  const sorted = sortContracts(list);
  return (
    <span className="contract-lines" data-contracts={list.length}>
      {sorted.slice(0, MAX_LINES).map((c) => (
        <span key={c.contractId} className="contract-line" title={`${c.contractId} · ${c.startDate ?? "–"} ~ ${c.endDate ?? "–"}`}>
          <span className="cl-item">{c.itemName}</span>
          <span className="cl-price">{priceText(c, unitOf(c.itemCode))}</span>
        </span>
      ))}
      {sorted.length > MAX_LINES && <span className="contract-more">외 {sorted.length - MAX_LINES}건 · 상세페이지에서 확인</span>}
    </span>
  );
}
