import assert from "node:assert/strict";
import { buildCart, summarizeCart } from "../src/cart.js";

const cart = buildCart([
  { sku: "growth-plan", quantity: 1 },
  { sku: "integration-pack", quantity: 1 }
], { promoCode: "LAUNCH10" });

assert.equal(cart.subtotalCents, 6400);
assert.equal(cart.discountCents, 640);
assert.equal(cart.taxCents, 475);
assert.equal(cart.totalCents, 6235);
assert.equal(summarizeCart(cart).total, "$62.35");
