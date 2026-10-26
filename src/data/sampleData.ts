// SAMPLE 데이터 로더 — src/data/sample/*.json (scripts/generate-sample.mjs로 생성)
import type {
  BomRow,
  CompetitorSupply,
  Contract,
  DataMeta,
  DataSet,
  FxRate,
  IndustryNews,
  InventoryRecord,
  Item,
  LaborWage,
  MaterialPrice,
  PurchaseOrder,
  Supplier,
} from "./types";
import meta from "./sample/meta.json";
import suppliers from "./sample/suppliers.json";
import items from "./sample/items.json";
import purchaseOrders from "./sample/purchaseOrders.json";
import contracts from "./sample/contracts.json";
import inventory from "./sample/inventory.json";
import bom from "./sample/bom.json";
import materialPrices from "./sample/materialPrices.json";
import fxRates from "./sample/fxRates.json";
import laborWages from "./sample/laborWages.json";
import competitorSupply from "./sample/competitorSupply.json";
import industryNews from "./sample/industryNews.json";

export function loadSample(): { data: DataSet; meta: DataMeta } {
  return {
    data: {
      suppliers: structuredClone(suppliers) as Supplier[],
      items: structuredClone(items) as Item[],
      purchaseOrders: structuredClone(purchaseOrders) as PurchaseOrder[],
      contracts: structuredClone(contracts) as Contract[],
      inventory: structuredClone(inventory) as InventoryRecord[],
      bom: structuredClone(bom) as BomRow[],
      materialPrices: structuredClone(materialPrices) as MaterialPrice[],
      fxRates: structuredClone(fxRates) as FxRate[],
      laborWages: structuredClone(laborWages) as LaborWage[],
      competitorSupply: structuredClone(competitorSupply) as CompetitorSupply[],
      industryNews: structuredClone(industryNews) as IndustryNews[],
    },
    meta: {
      label: meta.label,
      asOf: meta.asOf,
      isSample: true,
      sources: {
        suppliers: "sample/suppliers.json",
        items: "sample/items.json",
        purchaseOrders: "sample/purchaseOrders.json",
        contracts: "sample/contracts.json",
        inventory: "sample/inventory.json",
        bom: "sample/bom.json",
        materialPrices: "sample/materialPrices.json",
        fxRates: "sample/fxRates.json",
        laborWages: "sample/laborWages.json",
        competitorSupply: "sample/competitorSupply.json",
        industryNews: "sample/industryNews.json",
      },
      version: 1,
      dataId: "sample",
      uploaded: [],
    },
  };
}
