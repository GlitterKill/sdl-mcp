import assert from "node:assert/strict";
import { auditOrder } from "../src/audit.js";
import { buildCart } from "../src/cart.js";
import { listOrders, placeOrder } from "../src/orders.js";

const cart = buildCart([{ sku: "starter-plan", quantity: 2 }]);
const order = placeOrder(cart, { token: "tok_live_secret_123456" });

assert.match(order.id, /^ord_[a-f0-9]{12}$/);
assert.equal(JSON.stringify(order).includes("tok_live_secret"), false);
assert.equal(auditOrder(order).includes("tok_live_secret"), false);
assert.equal(auditOrder(order).includes("paymentFingerprint"), true);

const listed = listOrders();
listed[0].status = "cancelled";
assert.equal(listOrders()[0].status, "paid");
