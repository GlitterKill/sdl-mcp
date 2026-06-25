import assert from "node:assert/strict";
import { buildCart, createCheckoutSummary } from "../src/cart.js";

const customer = { tier: "gold", region: "US", accountAgeDays: 420 };
const cart = buildCart([
  { sku: "growth-plan", quantity: 1 },
  { sku: "integration-pack", quantity: 2 },
  { sku: "priority-support", quantity: 1 }
], { promoCode: "LAUNCH10", customer });

assert.equal(cart.subtotalCents, 10400);
assert.deepEqual(cart.discounts.map((discount) => discount.code), ["LAUNCH10", "GOLD5"]);
assert.equal(cart.discountCents, 1560);
assert.equal(cart.taxCents, 729);
assert.equal(cart.totalCents, 9569);

const summary = createCheckoutSummary(cart, { customer });
assert.equal(summary.shipping.method, "priority");
assert.equal(summary.shipping.shippingCents, 0);
assert.equal(summary.grandTotalCents, 9569);
assert.equal(summary.displayTotal, "$95.69");
assert.equal(summary.flags.includes("gold-loyalty"), true);
