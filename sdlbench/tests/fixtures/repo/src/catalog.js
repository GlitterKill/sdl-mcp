export const PRODUCTS = [
  { sku: "starter-plan", name: "Starter Plan", category: "plan", priceCents: 1900, stock: 12, tags: ["recurring"] },
  { sku: "growth-plan", name: "Growth Plan", category: "plan", priceCents: 4900, stock: 6, tags: ["recurring", "popular"] },
  { sku: "integration-pack", name: "Integration Pack", category: "addon", priceCents: 1500, stock: 20, tags: ["implementation"] },
  { sku: "priority-support", name: "Priority Support", category: "service", priceCents: 2500, stock: 4, tags: ["support"] }
];

export function getProduct(sku) {
  const product = PRODUCTS.find((item) => item.sku === sku);
  if (!product) throw new Error(`Unknown SKU: ${sku}`);
  return product;
}

export function listProductsByTag(tag) {
  return PRODUCTS.filter((item) => item.tags.includes(tag));
}
