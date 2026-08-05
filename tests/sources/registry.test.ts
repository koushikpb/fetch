// Proves SPEC I-01 criterion 3 ("registry is the only way to obtain an adapter") at the
// API level — the mechanical, import-site enforcement is tests/eslint-rules.test.ts's job,
// this file proves createSourceRegistry's own behavior: correct lookup, a helpful failure
// for an unregistered source, and refusal to build a registry with a duplicate source in
// the first place. Every test builds its own registry rather than sharing one, exactly per
// that function's own doc comment: a fresh instance per test is what keeps one test's
// registration from bleeding into another.
//
// I-05 replaced the `registry` singleton this file used to assert against with
// `createRegistry(config)` (composer resolution 2) — the old export built all three adapters
// with their own defaults, which made every one of them inert. The tripwire that block
// carried (an exhaustive assertion, so a fourth adapter cannot land silently) moves to the
// `createRegistry` block below rather than being dropped.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../lib/config.js';
import { AppError } from '../../lib/errors.js';
import { createFakeAdapter } from '../../sources/fake-adapter.js';
import { createRegistry, createSourceRegistry } from '../../sources/registry.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user@localhost:5432/db',
  ANTHROPIC_API_KEY: 'placeholder-key',
};

const REDDIT_ENV = {
  REDDIT_CLIENT_ID: 'placeholder-client-id',
  REDDIT_CLIENT_SECRET: 'placeholder-client-secret',
  REDDIT_USER_AGENT: 'fetch-app/0.1 (by /u/example)',
};

describe('createSourceRegistry', () => {
  it('returns the adapter registered for a source', () => {
    const hackernews = createFakeAdapter({ source: 'hackernews' });
    const reg = createSourceRegistry([hackernews]);
    expect(reg.get('hackernews')).toBe(hackernews);
  });

  it('list() returns exactly the registered sources', () => {
    const hackernews = createFakeAdapter({ source: 'hackernews' });
    const reddit = createFakeAdapter({ source: 'reddit' });
    const reg = createSourceRegistry([hackernews, reddit]);
    expect(new Set(reg.list())).toEqual(new Set(['hackernews', 'reddit']));
    expect(reg.list()).toHaveLength(2);
  });

  it('list() is empty for a registry built with no adapters', () => {
    const reg = createSourceRegistry([]);
    expect(reg.list()).toEqual([]);
  });

  it('throws an AppError for a source nothing was registered under', () => {
    const reg = createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]);
    expect(() => reg.get('reddit')).toThrow(AppError);
    expect(() => reg.get('reddit')).toThrow(/reddit/);
  });

  it('throws an AppError at construction time for a duplicate source', () => {
    const first = createFakeAdapter({ source: 'appstore' });
    const second = createFakeAdapter({ source: 'appstore' });
    expect(() => createSourceRegistry([first, second])).toThrow(AppError);
    expect(() => createSourceRegistry([first, second])).toThrow(/appstore/);
  });

  it('skipped() is empty for a registry built from a bare adapter list', () => {
    expect(createSourceRegistry([createFakeAdapter({ source: 'hackernews' })]).skipped()).toEqual(
      [],
    );
  });

  it('refuses to build a registry where a source is both registered and skipped', () => {
    const adapter = createFakeAdapter({ source: 'reddit' });
    const build = (): unknown =>
      createSourceRegistry([adapter], [{ source: 'reddit', reason: 'no credentials' }]);
    expect(build).toThrow(AppError);
    expect(build).toThrow(/reddit/);
  });
});

describe('createRegistry (the production wiring, I-05 composer resolution 2)', () => {
  // Deliberately exhaustive rather than a subset check: I-01 wrote this as a tripwire so that
  // a task registering an adapter cannot do so without one assertion failing to prompt the
  // update. A `toContain` here would let a fourth source register silently, which is the one
  // thing this test exists to prevent.
  it('registers exactly the three adapters that have landed when every source is configured', () => {
    const registry = createRegistry(loadConfig({ ...BASE_ENV, ...REDDIT_ENV }));
    expect(new Set(registry.list())).toEqual(new Set(['appstore', 'hackernews', 'reddit']));
    expect(registry.list()).toHaveLength(3);
    expect(registry.skipped()).toEqual([]);
  });

  it('leaves Reddit out — with a reason — when no credentials are configured (blocker B-09)', () => {
    const registry = createRegistry(loadConfig(BASE_ENV));
    expect(new Set(registry.list())).toEqual(new Set(['appstore', 'hackernews']));
    // The reason is what makes this a recorded skip rather than a silent absence: I-05 writes
    // it onto the run's counts so "Reddit was never asked" is distinguishable from "Reddit
    // ran and found nothing".
    expect(registry.skipped()).toHaveLength(1);
    expect(registry.skipped()[0]?.source).toBe('reddit');
    expect(registry.skipped()[0]?.reason).toMatch(/credentials/i);
  });

  it('still refuses to hand back an adapter for a skipped source', () => {
    const registry = createRegistry(loadConfig(BASE_ENV));
    expect(() => registry.get('reddit')).toThrow(AppError);
  });

  it('builds adapters that satisfy the SourceAdapter shape', () => {
    const registry = createRegistry(loadConfig({ ...BASE_ENV, ...REDDIT_ENV }));
    for (const source of registry.list()) {
      const adapter = registry.get(source);
      expect(adapter.source).toBe(source);
      expect(typeof adapter.fetchIncremental).toBe('function');
      expect(typeof adapter.fetchBackfill).toBe('function');
      expect(typeof adapter.checkHealth).toBe('function');
    }
  });
});
