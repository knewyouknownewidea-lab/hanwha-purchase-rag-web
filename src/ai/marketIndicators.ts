import type { MarketIndicator } from "../lib/priceComparison";

export async function getMarketIndicators(signal?: AbortSignal): Promise<MarketIndicator[]> {
  const controller = new AbortController();
  const aborted = () => controller.abort();
  signal?.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(aborted, 8000);
  try {
    if (signal?.aborted || location.protocol === "file:") throw new Error("unavailable");
    const response = await fetch("/api/market/indicators", { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error("unavailable");
    const body = await response.json();
    if (!Array.isArray(body?.indicators) || body.indicators.length > 5) throw new Error("invalid response");
    return body.indicators.map((value: unknown) => {
      if (!value || typeof value !== "object") throw new Error("invalid indicator");
      const i = value as MarketIndicator;
      if (typeof i.id !== "string" || typeof i.label !== "string" || typeof i.source !== "string" || !["fx", "material", "index"].includes(i.kind) || !["connected", "unavailable", "not_configured", "example"].includes(i.status) || typeof i.isSample !== "boolean" || typeof i.message !== "string" || typeof i.unit !== "string" || (i.status === "connected" && (typeof i.value !== "number" || !Number.isFinite(i.value) || !i.observedAt || !i.fetchedAt)) || (i.sourceUrl !== null && !/^https:\/\//.test(i.sourceUrl))) throw new Error("invalid indicator");
      return i;
    });
  } catch {
    return [{ id: "indicator-request", kind: "fx", label: "외부 지표 API", status: "unavailable", source: "미조회", sourceUrl: null, observedAt: null, fetchedAt: new Date().toISOString(), value: null, unit: "–", currency: null, message: "외부 지표를 확인하지 못했습니다. 예시값으로 대체하지 않았습니다.", isSample: false }];
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", aborted); }
}
