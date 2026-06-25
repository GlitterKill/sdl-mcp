const orders = [];

export function placeOrder(cart, payment) {
  if (!payment?.token) throw new Error("payment token required");
  const order = {
    id: `ord_${Date.now()}`,
    lines: cart.entries,
    totalCents: cart.totalCents,
    paymentToken: payment.token,
    status: "paid"
  };
  orders.push(order);
  return order;
}

export function listOrders() {
  return orders;
}
