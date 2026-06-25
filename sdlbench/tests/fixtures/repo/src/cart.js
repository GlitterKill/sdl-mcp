import { getProduct } from "./catalog.js";
import { customerAdjustment, resolvePromo } from "./discounts.js";
import { formatMoney } from "./money.js";

const TAX_RATE = 0.0825;

export function buildCart(lines, options = {}) {
  const entries = lines.map((line) => {
    const product = getProduct(line.sku);
    return {
      sku: product.sku,
      name: product.name,
      quantity: line.quantity,
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * line.quantity
    };
  });
  const subtotalCents = entries.reduce((sum, entry) => sum + entry.lineTotalCents, 0);
  const promo = resolvePromo(options.promoCode, subtotalCents);
  const customerDiscount = customerAdjustment(options.customer, subtotalCents);
  const discounts = [promo, customerDiscount].filter((discount) => discount.amountCents > 0);
  const discountCents = discounts.reduce((sum, discount) => sum + discount.amountCents, 0);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const totalCents = subtotalCents - discountCents + taxCents;

  return { entries, subtotalCents, discounts, discountCents, taxCents, totalCents };
}

export function summarizeCart(cart) {
  return {
    itemCount: cart.entries.reduce((sum, entry) => sum + entry.quantity, 0),
    subtotal: formatMoney(cart.subtotalCents),
    discounts: formatMoney(cart.discountCents),
    tax: formatMoney(cart.taxCents),
    total: formatMoney(cart.totalCents)
  };
}
