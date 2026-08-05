// Types specific to the App Store adapter (iTunes RSS review feeds).
import type { NetClient } from '../../lib/net.js';

/** One (app, territory) pair this adapter fans out across on every call (SPEC I-03
 * criterion 1; wave 3 shared context resolution 3: "a run crosses app IDs by territories"). */
export interface AppTerritoryPair {
  readonly appId: string;
  readonly territory: string;
}

/**
 * Two high-volume, publicly listed consumer apps, verified live (2026-08-05) to carry
 * substantial recent review volume with a real spread of star ratings — including the
 * one/two-star reviews criterion 2 exists to preserve, not just five-star noise. Yelp
 * (284910350) and Duolingo (570060128) were the two candidates, out of a wider live probe of
 * well-known app IDs, that actually returned populated feeds rather than an empty one (many
 * large apps' customer-review feeds returned zero entries when probed — see the completion
 * report). Both are large enough that a first backfill plausibly hits the feed's 500-review
 * ceiling (SPEC I-03 criterion 3), which a default config with too few reviews would never
 * exercise in practice.
 */
export const DEFAULT_APP_IDS: readonly string[] = ['284910350', '570060128'];

/**
 * ISO 3166-1 alpha-2 App Store storefront codes. The two largest English-language
 * storefronts — enough to demonstrate the app-ID x territory cross-product fan-out
 * (composer resolution 3) without inflating fixture/test volume.
 */
export const DEFAULT_TERRITORIES: readonly string[] = ['us', 'gb'];

export interface CreateAppStoreAdapterOptions {
  /** App Store numeric app IDs to pull reviews for. Defaults to `DEFAULT_APP_IDS`. */
  readonly appIds?: readonly string[];
  /** App Store storefront territory codes. Defaults to `DEFAULT_TERRITORIES`. */
  readonly territories?: readonly string[];
  /**
   * Overrides the outbound HTTP client. Defaults to lib/net.ts's shared `netClient`
   * singleton so this adapter's requests share its per-host token-bucket state with every
   * other production caller (wave 3 shared context: "rate limits only hold when every call
   * for a host shares one bucket"). Tests substitute their own `createNetClient({
   * transport })` here instead of touching the network (wave 3 shared context resolution 3).
   */
  readonly netClient?: NetClient;
}

/**
 * Per-`${appId}:${territory}` high-water mark — the most recent review `createdAt` (as an
 * ISO string) this adapter has already returned for that pair — round-tripped through
 * `Cursor` (an opaque string per composer resolution 3) as one JSON object. Flat rather than
 * nested so encode/decode is a single `JSON.stringify`/`JSON.parse`, and keyed by string
 * rather than a tuple because `Cursor` itself must be a string.
 */
export type AppStoreCursorState = Readonly<Record<string, string>>;
