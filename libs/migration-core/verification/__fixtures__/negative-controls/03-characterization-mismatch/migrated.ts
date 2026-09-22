// The "migrated" side — deliberately wrong (uses the tax rate as a flat addition, not a multiplier), engineered so the characterization diff mismatches.
function priceWithTax(price: number, taxRate: number): number {
  return price + taxRate;
}
