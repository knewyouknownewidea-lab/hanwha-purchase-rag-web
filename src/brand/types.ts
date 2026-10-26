export interface Brand {
  kind: "hanwha" | "neutral";
  logo: string | null; // 이미지 주소(data URL)
  company: string | null;
  companyEn: string | null;
  product: string;
  docTitle: string;
}
