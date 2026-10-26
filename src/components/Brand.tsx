// 헤더 브랜드: [로고] 한화엔진 / HANWHA ENGINE │ 구매·협력사 AI 분석 플랫폼
// "HANWHA ENGINE"은 "한화엔진"과 좌우 너비가 같도록 글자 간격을 벌려 맞춘다 (두 줄 모두 같은 칸 너비에 양끝 맞춤)
import { BRAND } from "../brand";

const Spread = ({ text, className }: { text: string; className: string }) => (
  <span className={className} aria-hidden>
    {[...text].map((ch, i) => (ch === " " ? <span key={i} className="sp-gap" /> : <span key={i}>{ch}</span>))}
  </span>
);

export function BrandBlock({ as: Tag = "h1" }: { as?: "h1" | "div" }) {
  if (BRAND.kind === "hanwha" && BRAND.company) {
    return (
      <div className="brand brand-hanwha">
        {BRAND.logo && <img className="brand-logo" src={BRAND.logo} alt="" width={37} height={34} />}
        <span className="brand-co" role="img" aria-label={`${BRAND.company} ${BRAND.companyEn ?? ""}`}>
          <Spread text={BRAND.company} className="brand-ko" />
          {BRAND.companyEn && <Spread text={BRAND.companyEn} className="brand-en" />}
        </span>
        <span className="brand-divider" aria-hidden />
        <Tag className="brand-product">{BRAND.product}</Tag>
      </div>
    );
  }
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden>
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M4 17h3V9H4v8Zm6.5 0h3V5h-3v12Zm6.5 0h3v-6h-3v6Z" fill="currentColor" />
        </svg>
      </span>
      <Tag className="brand-product">{BRAND.product}</Tag>
    </div>
  );
}
