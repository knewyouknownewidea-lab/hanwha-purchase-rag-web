declare module "*.png" {
  const src: string;
  export default src;
}
declare module "virtual:brand" {
  export const BRAND: import("./brand/types").Brand;
}
