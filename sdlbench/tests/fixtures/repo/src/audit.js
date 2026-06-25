export function auditOrder(order) {
  return `${order.id}:${order.paymentToken}:${order.totalCents}:${order.status}`;
}
