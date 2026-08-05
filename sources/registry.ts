// The only door onto a platform adapter's internals (SPEC I-01 criterion 3; composer
// resolution 4): eslint.config.js's ADAPTER_DEEP_IMPORT_BAN mechanically forbids importing
// `sources/hackernews/*`, `sources/appstore/*`, or `sources/reddit/*` from anywhere except
// this file, with a paired positive/negative proof in tests/eslint-rules.test.ts. I-02,
// I-03, and I-04 each add one import and one array entry to the `registry` instance below
// as their adapter lands; nothing else in the repo should ever import an adapter module
// directly.
//
// A factory (`createSourceRegistry`) rather than a mutable module-level map, mirroring
// lib/net.ts's `createNetClient`/`netClient` split — that module's own comment explains why:
// tests build one per case "so state never leaks between them". The same reasoning applies
// here: a shared mutable registry would let one test's registration bleed into an unrelated
// test's lookup for the same source. `registry` below is this file's equivalent of
// `netClient` — the ready instance production code imports.
import { AppError } from '../lib/errors.js';
import type { Source } from '../lib/types.js';
import { createAppStoreAdapter } from './appstore/adapter.js';
import { createHackerNewsAdapter } from './hackernews/adapter.js';
import { createRedditAdapter } from './reddit/adapter.js';
import type { SourceAdapter } from './types.js';

export interface SourceRegistry {
  /**
   * Throws rather than returning `undefined` (composer resolution 4's "the registry is the
   * only way to obtain an adapter" only holds if callers can rely on getting one back) — a
   * missing registration is a wiring bug to surface immediately, not a per-source runtime
   * condition every I-05 call site needs an `undefined` branch to handle. Contrast this with
   * `SourceAdapter.checkHealth`, which reports failure as data on purpose: that is a
   * *reachability* signal I-05 is expected to see routinely, this is a *configuration*
   * error it is not.
   */
  get(source: Source): SourceAdapter;
  list(): readonly Source[];
}

/**
 * Builds a registry from an explicit adapter list. Rejects two adapters claiming the same
 * `source` at construction time rather than silently letting the later one win — a
 * duplicate here is a wiring mistake (an adapter registered twice, or its `source` field
 * copy-pasted from a different adapter), and construction time is the cheapest place to
 * catch that, well before any run depends on which of the two silently "won".
 */
export function createSourceRegistry(adapters: readonly SourceAdapter[]): SourceRegistry {
  const bySource = new Map<Source, SourceAdapter>();
  for (const adapter of adapters) {
    if (bySource.has(adapter.source)) {
      throw new AppError(
        'DUPLICATE_ADAPTER_SOURCE',
        `More than one adapter registered for source "${adapter.source}"`,
        { context: { source: adapter.source } },
      );
    }
    bySource.set(adapter.source, adapter);
  }

  return {
    get(source) {
      const adapter = bySource.get(source);
      if (adapter === undefined) {
        throw new AppError(
          'ADAPTER_NOT_REGISTERED',
          `No adapter registered for source "${source}"`,
          { context: { source, registered: [...bySource.keys()] } },
        );
      }
      return adapter;
    },
    list: () => [...bySource.keys()],
  };
}

/**
 * The production registry ingest code imports. Nothing else in the repo should construct its
 * own registry outside tests, which use `createSourceRegistry` directly with fakes instead of
 * mutating this shared instance.
 *
 * Every adapter here is currently built with its own defaults, which means every one of them
 * is inert — Reddit in particular cannot fetch anything without credentials. That is a
 * consequence of wave 3's "exactly two lines of this file" rule, which was what let the three
 * adapters be written concurrently without a three-way collision. I-05 replaces this with a
 * `createRegistry(config)` factory, following the `createDb(connectionString)` /
 * `createNetClient(options)` pattern the rest of the codebase already uses.
 */
export const registry: SourceRegistry = createSourceRegistry([
  createAppStoreAdapter(),
  createHackerNewsAdapter(),
  createRedditAdapter(),
]);
