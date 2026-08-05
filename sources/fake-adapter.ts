// A first-class test double (SPEC I-01 criterion 4; composer resolution 6), not a
// throwaway stub — I-02/I-03/I-04's own adapter tests and I-05's orchestrator tests are all
// expected to build on this rather than each hand-rolling their own `SourceAdapter`
// implementation. Deliberately lives at the top level of sources/, not under
// sources/hackernews/, sources/appstore/, or sources/reddit/, so eslint.config.js's
// ADAPTER_DEEP_IMPORT_BAN — which forbids importing those three directories' internals from
// anywhere but sources/registry.ts — has no occasion to apply to it; every test file is
// free to import this module directly.
import type { AppError } from '../lib/errors.js';
import type { Document, Source } from '../lib/types.js';
import type {
  BackfillRange,
  Cursor,
  FetchPage,
  HealthCheckResult,
  SourceAdapter,
} from './types.js';

/**
 * Extra, test-only controls layered onto a real `SourceAdapter`. Kept under a separate
 * `fake` property rather than merged into the adapter's own surface so a `FakeSourceAdapter`
 * still structurally satisfies plain `SourceAdapter` with nothing extra for production-
 * shaped code to notice — `createSourceRegistry` and any future I-05 orchestrator code
 * accept it unmodified, exactly as they would a real adapter.
 */
export interface FakeAdapterControls {
  /** Replaces the configured incremental pages and resets pagination to the first one. */
  setPages(pages: readonly (readonly Document[])[]): void;
  /** Replaces the configured backfill pages and resets pagination to the first one. */
  setBackfillPages(pages: readonly (readonly Document[])[]): void;
  setHealth(result: HealthCheckResult): void;
  /** `undefined` clears a previously configured failure — later fetches succeed again. */
  setFetchError(error: AppError | undefined): void;
  incrementalCallCount(): number;
  backfillCallCount(): number;
  healthCallCount(): number;
}

export interface FakeSourceAdapter extends SourceAdapter {
  readonly fake: FakeAdapterControls;
}

export interface CreateFakeAdapterOptions {
  readonly source?: Source;
  readonly pages?: readonly (readonly Document[])[];
  readonly backfillPages?: readonly (readonly Document[])[];
  readonly health?: HealthCheckResult;
  readonly fetchError?: AppError;
}

const DEFAULT_HEALTH: HealthCheckResult = { healthy: true, detail: 'fake adapter: ok' };

/**
 * Cursors here are stringified page indices ("0", "1", ...) — an implementation detail of
 * this fake alone, invisible to any caller per composer resolution 3 (cursors are opaque
 * and adapter-owned). Deriving the page from the *cursor value itself*, rather than from an
 * internal call counter, is what makes re-invoking with an old (or `undefined`) cursor
 * deterministically replay that same page instead of silently advancing regardless of what
 * was passed in — the exact re-run behaviour I-05's "re-running immediately inserts zero
 * new rows" criterion needs a fake to be able to simulate.
 */
function pageAt(pages: readonly (readonly Document[])[], cursor: Cursor | undefined): FetchPage {
  const index = cursor === undefined ? 0 : Number(cursor);
  const documents = pages[index] ?? [];
  const nextIndex = index + 1;
  const nextCursor = nextIndex < pages.length ? String(nextIndex) : undefined;
  return { documents, cursor: nextCursor };
}

/**
 * Building block for every I-02/I-03/I-04 adapter test and every I-05 orchestrator test.
 * `createFakeAdapter()` called with no arguments *is* the "no-op fake adapter" SPEC I-01
 * criterion 4 asks for outright: healthy, returns no documents, cursor always `undefined`,
 * never throws. Every other scenario (documents, cursor exhaustion, an unhealthy report, a
 * thrown fetch error) is the same factory, configured via `options` or reconfigured
 * mid-test via the returned `.fake` controls.
 */
export function createFakeAdapter(options: CreateFakeAdapterOptions = {}): FakeSourceAdapter {
  let pages = options.pages ?? [];
  let backfillPages = options.backfillPages ?? [];
  let health = options.health ?? DEFAULT_HEALTH;
  let fetchError = options.fetchError;
  let incrementalCalls = 0;
  let backfillCalls = 0;
  let healthCalls = 0;

  return {
    source: options.source ?? 'hackernews',

    async fetchIncremental(cursor: Cursor | undefined) {
      incrementalCalls += 1;
      // Checked after incrementing the call counter, not before — a test asserting "the
      // orchestrator attempted this source" must see the attempt counted even though it
      // failed, the same way a real adapter's call would be attempted before its own
      // internal `netClient.request` rejects.
      if (fetchError !== undefined) {
        throw fetchError;
      }
      return pageAt(pages, cursor);
    },

    async fetchBackfill(_range: BackfillRange, cursor: Cursor | undefined) {
      backfillCalls += 1;
      if (fetchError !== undefined) {
        throw fetchError;
      }
      return pageAt(backfillPages, cursor);
    },

    async checkHealth() {
      healthCalls += 1;
      return health;
    },

    fake: {
      setPages(next) {
        pages = next;
      },
      setBackfillPages(next) {
        backfillPages = next;
      },
      setHealth(next) {
        health = next;
      },
      setFetchError(next) {
        fetchError = next;
      },
      incrementalCallCount: () => incrementalCalls,
      backfillCallCount: () => backfillCalls,
      healthCallCount: () => healthCalls,
    },
  };
}
