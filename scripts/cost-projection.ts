// O-03 placeholder. Real projected spend requires per-run token accounting
// (F-05's `runs` writes), which does not exist yet — until then `verify`'s
// cost gate is this fixed pass-through so the mechanical gate has four steps
// from day one instead of being retrofitted later. PLAN.md: O-03 "Replaces
// the F-01 stub".
const CEILING_USD = 70.0;
const PROJECTED_USD = 0.0;

console.log(
  `Projected monthly cost: $${PROJECTED_USD.toFixed(2)} (ceiling: $${CEILING_USD.toFixed(2)}) [O-03 stub]`,
);
