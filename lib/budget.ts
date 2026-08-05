// The hard budget stop CLAUDE.md's cost envelope names explicitly ("the budget guard in
// lib/budget.ts is a hard stop, not a warning"). This module is deliberately independent of
// lib/llm.ts and imports neither the Anthropic SDK nor any I/O primitive (composer
// resolution F-05 #7) — it answers one pure question ("does trailing spend plus a pending
// estimate exceed the ceiling?") so the arithmetic is unit-testable without a network or
// database double standing in for anything. lib/llm.ts is responsible for gathering the
// trailing 30-day spend (from `runs`) and a conservative pending-call estimate, and for
// calling `assertBudget` with them *before* dispatching a call (composer resolution #6) —
// a post-hoc check does not satisfy SPEC F-05 criterion 4.

import { BudgetExceededError } from './errors.js';

export interface BudgetCheckInput {
  /** Actual spend recorded in `runs` over the trailing window (e.g. 30 days), in USD. */
  trailingSpendUsd: number;
  /**
   * A conservative upper-bound estimate of the call about to be dispatched, in USD.
   * "Conservative" is load-bearing here: a false refusal is a visible annoyance, a false
   * approval is a budget breach (composer resolution #6) — so callers should round this
   * estimate up, never down.
   */
  pendingEstimateUsd: number;
  /** The configured hard ceiling (Config.budgetCeilingUsd), in USD. */
  ceilingUsd: number;
}

export interface BudgetStatus extends BudgetCheckInput {
  /** trailingSpendUsd + pendingEstimateUsd — the projected spend if this call dispatches. */
  projectedUsd: number;
  /** true when projectedUsd has not yet passed ceilingUsd. */
  withinBudget: boolean;
}

/**
 * Pure projection: never throws, never does I/O. `assertBudget` below is the enforcement
 * wrapper most callers want; this is exported separately so a caller (or a test) can inspect
 * the projected total without catching an exception to get at it.
 */
export function evaluateBudget(input: BudgetCheckInput): BudgetStatus {
  const projectedUsd = input.trailingSpendUsd + input.pendingEstimateUsd;
  return {
    ...input,
    projectedUsd,
    // SPEC F-05 criterion 4 says "push ... past the configured ceiling" — strictly past, so
    // a projection landing exactly on the ceiling is still within budget.
    withinBudget: projectedUsd <= input.ceilingUsd,
  };
}

/**
 * Throws `BudgetExceededError` when dispatching the pending call would push the rolling
 * 30-day projection past the configured ceiling. Callers must call this before dispatch,
 * not after — see the module comment above.
 */
export function assertBudget(input: BudgetCheckInput): void {
  const status = evaluateBudget(input);
  if (!status.withinBudget) {
    throw new BudgetExceededError(
      `Projected spend $${status.projectedUsd.toFixed(2)} (trailing $${status.trailingSpendUsd.toFixed(2)} + pending estimate $${status.pendingEstimateUsd.toFixed(2)}) would exceed the $${status.ceilingUsd.toFixed(2)} budget ceiling`,
      {
        context: {
          trailingSpendUsd: status.trailingSpendUsd,
          pendingEstimateUsd: status.pendingEstimateUsd,
          ceilingUsd: status.ceilingUsd,
          projectedUsd: status.projectedUsd,
        },
      },
    );
  }
}
