// Proves SPEC I-01 criterion 3 ("registry is the only way to obtain an adapter") at the
// API level — the mechanical, import-site enforcement is tests/eslint-rules.test.ts's job,
// this file proves createSourceRegistry's own behavior: correct lookup, a helpful failure
// for an unregistered source, and refusal to build a registry with a duplicate source in
// the first place. Every test builds its own registry via createSourceRegistry rather than
// touching the shared `registry` export, exactly per that function's own doc comment: a
// fresh instance per test is what keeps one test's registration from bleeding into another.
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { createFakeAdapter } from '../../sources/fake-adapter.js';
import { createSourceRegistry, registry } from '../../sources/registry.js';

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
});

describe('registry (the production export)', () => {
  // I-01 builds the seam, not the adapters that plug into it (SPEC I-01: "do not implement
  // any real adapter") — this documents that deliberate starting state so the next task to
  // touch sources/registry.ts (I-02, adding the Hacker News adapter) sees a failing
  // assertion here as a prompt to update it, not a surprise.
  it('starts empty — I-02/I-03/I-04 each add their adapter as they land', () => {
    expect(registry.list()).toEqual([]);
  });

  it('conforms to the SourceRegistry shape (get, list)', () => {
    expect(typeof registry.get).toBe('function');
    expect(typeof registry.list).toBe('function');
  });
});
