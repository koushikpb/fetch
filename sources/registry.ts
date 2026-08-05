// The only door onto a platform adapter's internals (SPEC I-01 criterion 3; composer
// resolution 4): eslint.config.js's ADAPTER_DEEP_IMPORT_BAN mechanically forbids importing
// `sources/hackernews/*`, `sources/appstore/*`, or `sources/reddit/*` from anywhere except
// this file, with a paired positive/negative proof in tests/eslint-rules.test.ts. Nothing
// else in the repo should ever import an adapter module directly.
//
// Two factories, for two different jobs. `createSourceRegistry(adapters)` is the low-level
// constructor — an explicit adapter list in, a registry out — mirroring lib/net.ts's
// `createNetClient`, whose own comment explains why a factory beats a mutable module-level
// map: tests build one per case "so state never leaks between them". `createRegistry(config)`
// on top of it is the production wiring: it decides *which* adapters exist and hands each one
// its configuration, following the same `createDb(connectionString)` /
// `createNetClient(options)` shape the rest of the codebase already uses.
//
// I-05 composer resolution 2 replaced the previous `export const registry` singleton, which
// built all three adapters with their own defaults. That made every entry inert — Reddit in
// particular cannot fetch anything without credentials — and was a consequence of wave 3's
// "exactly two lines of this file" rule, which was what let the three adapters be written
// concurrently without a three-way collision. There is no configuration-free registry any
// more, because there is no such thing as a usable configuration-free registry.
import { AppError } from '../lib/errors.js';
import type { Config } from '../lib/config.js';
import type { Source } from '../lib/types.js';
import { createAppStoreAdapter } from './appstore/adapter.js';
import { createHackerNewsAdapter } from './hackernews/adapter.js';
import { createRedditAdapter } from './reddit/adapter.js';
import type { SourceAdapter } from './types.js';

/**
 * A source that has no adapter in this registry because it is *configured off* — not an
 * error and not a failure, but not something to lose track of either. I-05 records these on
 * the `runs` row so "Reddit produced nothing this run" is distinguishable from "Reddit was
 * never asked", which a bare absence from `list()` would not be.
 */
export interface SkippedSource {
  readonly source: Source;
  /** Human-readable — recorded verbatim by I-05, never parsed. */
  readonly reason: string;
}

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
  /**
   * Sources deliberately left out, with the reason. Empty for a registry built directly from
   * an adapter list — "not passed in" carries no explanation worth recording.
   */
  skipped(): readonly SkippedSource[];
}

/**
 * Builds a registry from an explicit adapter list. Rejects two adapters claiming the same
 * `source` at construction time rather than silently letting the later one win — a
 * duplicate here is a wiring mistake (an adapter registered twice, or its `source` field
 * copy-pasted from a different adapter), and construction time is the cheapest place to
 * catch that, well before any run depends on which of the two silently "won".
 */
export function createSourceRegistry(
  adapters: readonly SourceAdapter[],
  skipped: readonly SkippedSource[] = [],
): SourceRegistry {
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

  for (const entry of skipped) {
    if (bySource.has(entry.source)) {
      // A source cannot be both registered and skipped: whichever of the two a caller then
      // consulted would decide the run's behaviour, and the other would be a silent lie.
      throw new AppError(
        'ADAPTER_REGISTERED_AND_SKIPPED',
        `Source "${entry.source}" is both registered and marked skipped`,
        { context: { source: entry.source } },
      );
    }
  }

  const skippedCopy = [...skipped];

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
    skipped: () => [...skippedCopy],
  };
}

/**
 * The production wiring: every adapter the supplied `Config` can actually run, each built
 * with that configuration, plus an explanation for every source left out.
 *
 * Hacker News and App Store are free and unauthenticated, so they are always registered —
 * with configured queries/app ids/territories where the config supplies them, and each
 * adapter's own defaults where it does not. Reddit is registered only when credentials are
 * present: it blocks unauthenticated API access outright (blocker B-09), so without them the
 * adapter cannot fetch a single document, and registering an adapter guaranteed to throw
 * `ConfigError` on first call would turn a configuration choice into a run failure.
 *
 * Every option below is passed straight through, `undefined` included. `exactOptionalPropertyTypes`
 * is off in this repo's tsconfig, so an explicitly-`undefined` property is accepted where an
 * optional one is declared, and each adapter factory resolves it with its own `?? DEFAULT` —
 * which is why this file restates no adapter default and the two can never drift apart.
 */
export function createRegistry(config: Config): SourceRegistry {
  const adapters: SourceAdapter[] = [
    createHackerNewsAdapter({ queries: config.hackernews.queries }),
    createAppStoreAdapter({
      appIds: config.appstore.appIds,
      territories: config.appstore.territories,
    }),
  ];
  const skipped: SkippedSource[] = [];

  const reddit = config.reddit;
  if (reddit === undefined) {
    skipped.push({
      source: 'reddit',
      reason:
        'No Reddit credentials configured (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT) — Reddit blocks unauthenticated API access, so the adapter cannot fetch anything',
    });
  } else {
    adapters.push(
      createRedditAdapter({
        clientId: reddit.clientId,
        clientSecret: reddit.clientSecret,
        userAgent: reddit.userAgent,
        subreddits: reddit.subreddits,
        // Spread into a `Partial<RedditCommentExpansionOptions>` inside the adapter, where a
        // present-but-undefined key would overwrite the adapter's own default with
        // `undefined` rather than falling back to it — so the whole object is omitted when
        // there is nothing to override, instead of the key being set to `undefined`.
        commentExpansion:
          reddit.minCommentsToExpand === undefined
            ? undefined
            : { minCommentsToExpand: reddit.minCommentsToExpand },
      }),
    );
  }

  return createSourceRegistry(adapters, skipped);
}
