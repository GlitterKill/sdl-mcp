export function resolvePromo(code, subtotalCents) {
  if (code === "LAUNCH10") {
    return { code, amountCents: Math.round(subtotalCents * 0.1), reason: "launch promotion" };
  }
  if (code === "BUNDLE15" && subtotalCents >= 6500) {
    return { code, amountCents: 1500, reason: "bundle promotion" };
  }
  return { code: null, amountCents: 0, reason: null };
}

export function customerAdjustment(_customer, _subtotalCents) {
  return { code: null, amountCents: 0, reason: null };
}
