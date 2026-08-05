// Proves lib/budget.ts's guard purely through its exported pure functions — no Anthropic
// SDK, no database, no network. This is exactly what composer resolution #7 ("independently
// testable... does not import the Anthropic SDK") is for: the budget math needs nothing but
// three numbers in and a decision out.
import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../lib/errors.js';
import { assertBudget, evaluateBudget } from '../lib/budget.js';

describe('evaluateBudget — pure projection math', () => {
  it('projects trailing spend plus the pending estimate', () => {
    const status = evaluateBudget({ trailingSpendUsd: 40, pendingEstimateUsd: 5, ceilingUsd: 70 });
    expect(status.projectedUsd).toBe(45);
    expect(status.withinBudget).toBe(true);
  });

  it('is within budget when the projection lands exactly on the ceiling', () => {
    // SPEC F-05 criterion 4 says "push ... past the configured ceiling" — strictly past.
    const status = evaluateBudget({ trailingSpendUsd: 65, pendingEstimateUsd: 5, ceilingUsd: 70 });
    expect(status.projectedUsd).toBe(70);
    expect(status.withinBudget).toBe(true);
  });

  it('is over budget by even a cent past the ceiling', () => {
    const status = evaluateBudget({ trailingSpendUsd: 65, pendingEstimateUsd: 5.01, ceilingUsd: 70 });
    expect(status.withinBudget).toBe(false);
  });

  it('handles a zero trailing spend (first call of the month)', () => {
    const status = evaluateBudget({ trailingSpendUsd: 0, pendingEstimateUsd: 10, ceilingUsd: 70 });
    expect(status.projectedUsd).toBe(10);
    expect(status.withinBudget).toBe(true);
  });

  it('echoes the inputs back on the status object', () => {
    const status = evaluateBudget({ trailingSpendUsd: 1, pendingEstimateUsd: 2, ceilingUsd: 3 });
    expect(status.trailingSpendUsd).toBe(1);
    expect(status.pendingEstimateUsd).toBe(2);
    expect(status.ceilingUsd).toBe(3);
  });
});

describe('assertBudget — the enforcement wrapper (SPEC F-05 criterion 4)', () => {
  it('does not throw when the projection stays within the ceiling', () => {
    expect(() => assertBudget({ trailingSpendUsd: 10, pendingEstimateUsd: 5, ceilingUsd: 70 })).not.toThrow();
  });

  it('throws BudgetExceededError when the projection would push past the ceiling', () => {
    expect(() => assertBudget({ trailingSpendUsd: 65, pendingEstimateUsd: 10, ceilingUsd: 70 })).toThrow(
      BudgetExceededError,
    );
  });

  it('names the trailing spend, pending estimate, and ceiling in the thrown error message', () => {
    let thrown: unknown;
    try {
      assertBudget({ trailingSpendUsd: 65, pendingEstimateUsd: 10, ceilingUsd: 70 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    const err = thrown as BudgetExceededError;
    expect(err.message).toMatch(/65\.00/);
    expect(err.message).toMatch(/10\.00/);
    expect(err.message).toMatch(/70\.00/);
    expect(err.code).toBe('BUDGET_EXCEEDED');
  });

  it('carries the projection numbers in the error context, not just the message', () => {
    let thrown: unknown;
    try {
      assertBudget({ trailingSpendUsd: 65, pendingEstimateUsd: 10, ceilingUsd: 70 });
    } catch (err) {
      thrown = err;
    }
    const err = thrown as BudgetExceededError;
    expect(err.context).toEqual({
      trailingSpendUsd: 65,
      pendingEstimateUsd: 10,
      ceilingUsd: 70,
      projectedUsd: 75,
    });
  });

  it('a huge trailing spend alone (no pending call) is already over budget', () => {
    expect(() => assertBudget({ trailingSpendUsd: 100, pendingEstimateUsd: 0, ceilingUsd: 70 })).toThrow(
      BudgetExceededError,
    );
  });
});
