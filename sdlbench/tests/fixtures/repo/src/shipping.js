export function estimateShipping(cart, customer = {}) {
  const shippingCents = cart.subtotalCents >= 6500 ? 0 : 799;
  return {
    method: customer.region === "EU" ? "international" : "standard",
    etaDays: customer.region === "EU" ? 8 : 5,
    shippingCents
  };
}
