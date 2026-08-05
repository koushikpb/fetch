// Proves F-01 criterion 4 and F-06 criteria 1-2 mechanically rather than by config
// inspection: every prohibition below (`any`, bare `fetch`, direct `@anthropic-ai/sdk`
// imports, constructing a built-in error type, declaring a class that extends the
// built-in Error, throwing a non-Error value, an empty catch block, a bare rethrow) must
// actually surface as a lint error, and every wrapper/exemption (lib/net.ts, lib/llm.ts,
// lib/errors.ts, tests/**) must actually suppress only what it's meant to and nothing
// more — fix round 1 found that lib/errors.ts's override had been suppressing the fetch
// ban too, which a config-shape read would not have caught but a real `lintText` assertion
// did. `lintText` with a `filePath` works whether or not that path is real on disk — ESLint's
// flat-config `files` globs match against the given path regardless, and the `code` argument
// always overrides whatever (if anything) is really there. Some paths below are still
// virtual (`sources/example.ts` and its siblings) and depend on eslint.config.js's
// `allowDefaultProject` for typed rules (`@typescript-eslint/only-throw-error`) to resolve
// type information without a real tsconfig entry; others are real, on-disk paths (lib/net.ts,
// lib/llm.ts, lib/errors.ts, tests/errors.test.ts — created by F-04, F-05, and F-06
// respectively) that resolve through the actual tsconfig project instead and need no
// `allowDefaultProject` entry at all. R-02 made that split self-maintaining: eslint.config.js
// now filters its `allowDefaultProject` candidate list by `existsSync` at load time, so
// lib/net.ts and lib/llm.ts moved from the first group to the second automatically the moment
// F-04 and F-05 created them on disk, with no edit required in either file. The dedicated
// "R-02 regression" describe block at the bottom of this file proves that split holds in both
// directions at once, rather than relying on it being incidentally exercised by unrelated
// prohibition tests above.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';

// A `fatal` message (ruleId: null) means ESLint couldn't run the rules at all — most
// often a parser or type-information failure such as exceeding the default project's
// matched-file cap (see ORDINARY_FILE below). Filtering those out by `ruleId !== null`
// alone would silently turn "the check never ran" into "the check found nothing",
// which is indistinguishable from a genuine negative assertion passing. Throwing here
// caught exactly that failure mode during development, so every test below asserts on a
// check that actually executed.
async function lintMessages(
  code: string,
  filePath: string,
): Promise<{ ruleId: string | null; message: string }[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  const messages = result?.messages ?? [];
  const fatal = messages.find((message) => message.fatal === true);
  if (fatal) {
    throw new AppError('LINT_FATAL', `lintText fatal error for ${filePath}: ${fatal.message}`);
  }
  return messages.map((message) => ({ ruleId: message.ruleId, message: message.message }));
}

async function lint(code: string, filePath: string): Promise<string[]> {
  const messages = await lintMessages(code, filePath);
  return messages.map((message) => message.ruleId).filter((id): id is string => id !== null);
}

describe('eslint prohibitions (F-01 criterion 4)', () => {
  it('reports `any` in a normal source file', async () => {
    const ruleIds = await lint(
      'export function identity(value: any): unknown {\n  return value;\n}\n',
      'sources/example.ts',
    );
    expect(ruleIds).toContain('@typescript-eslint/no-explicit-any');
  });

  it('reports bare fetch(...) outside lib/net.ts', async () => {
    const ruleIds = await lint(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'sources/hackernews/example.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('does not report bare fetch(...) inside lib/net.ts', async () => {
    const ruleIds = await lint(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'lib/net.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  it('reports an @anthropic-ai/sdk import outside lib/llm.ts', async () => {
    const ruleIds = await lint(
      "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic();\n",
      'sources/reddit/example.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('does not report an @anthropic-ai/sdk import inside lib/llm.ts', async () => {
    const ruleIds = await lint(
      "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic();\n",
      'lib/llm.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });
});

describe('eslint prohibitions (F-03 criterion 2: no process.env access outside lib/config.ts)', () => {
  it('reports process.env access outside lib/config.ts', async () => {
    const messages = await lintMessages(
      'export function f(): string | undefined {\n  return process.env.DATABASE_URL;\n}\n',
      'sources/example.ts',
    );
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/config.ts'),
      ),
    ).toBe(true);
  });

  it('does not report process.env access inside lib/config.ts', async () => {
    const ruleIds = await lint(
      'export function f(): string | undefined {\n  return process.env.DATABASE_URL;\n}\n',
      'lib/config.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  // Guards against the exact F-06 fix-round-1 regression class documented above (Finding 1
  // there): an override that turns the whole rule off for its file, rather than redefining
  // it, silently drops every other ban that rule was carrying for that file too.
  it('still reports bare fetch(...) inside lib/config.ts — the process.env exemption is scoped, not a blanket rule-off', async () => {
    const messages = await lintMessages(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'lib/config.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/net.ts')),
    ).toBe(true);
  });

  it('still reports process.env access inside tests/** — no exemption there either', async () => {
    const messages = await lintMessages(
      'export function f(): string | undefined {\n  return process.env.DATABASE_URL;\n}\n',
      'tests/config.test.ts',
    );
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/config.ts'),
      ),
    ).toBe(true);
  });

  // Fix round 1, Finding 2: the dot-notation selector clause alone
  // (`property.name='env'`) only matches `Identifier` property nodes, so bracket access
  // with a string literal — `process["env"]` — slipped through with zero lint messages
  // (reviewer-verified against the live config before this fix). The added
  // `[computed=true][property.value='env']` clause targets that Literal-property shape
  // specifically.
  it('reports bracket-notation process["env"].FOO access outside lib/config.ts', async () => {
    const messages = await lintMessages(
      'export function f(): string | undefined {\n  return process["env"].DATABASE_URL;\n}\n',
      'sources/example.ts',
    );
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/config.ts'),
      ),
    ).toBe(true);
  });

  it('reports fully bracketed process["env"]["FOO"] access outside lib/config.ts', async () => {
    const messages = await lintMessages(
      'export function f(): string | undefined {\n  return process["env"]["DATABASE_URL"];\n}\n',
      'sources/example.ts',
    );
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/config.ts'),
      ),
    ).toBe(true);
  });

  it('does not report bracket-notation process["env"] access inside lib/config.ts', async () => {
    const ruleIds = await lint(
      'export function f(): string | undefined {\n  return process["env"].DATABASE_URL;\n}\n',
      'lib/config.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });
});

// A single shared fake path for the "should fire in an ordinary file" cases below,
// reused across many `lintText` calls rather than one fake path per case. typescript-eslint's
// project service caps how many distinct paths may fall back to the default project within
// one process (`maximumDefaultProjectFileMatchCount`, default 8 — see
// https://tseslint.com/allowdefaultproject-glob-too-wide) and this file already needs
// several distinct paths for the override-specific cases (lib/net.ts, sources/hackernews,
// sources/reddit); reusing one path for content-only variations keeps the total well under
// that cap instead of registering a fresh entry in eslint.config.js's `allowDefaultProject`
// per test.
const ORDINARY_FILE = 'sources/example.ts';

describe('eslint prohibitions (F-06 criterion 1: every thrown error is an AppError)', () => {
  it('reports constructing a built-in Error, thrown inline', async () => {
    const messages = await lintMessages(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      ORDINARY_FILE,
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('reports constructing other built-in error types (TypeError), thrown inline', async () => {
    const messages = await lintMessages(
      "export function f(): void {\n  throw new TypeError('boom');\n}\n",
      ORDINARY_FILE,
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  // Fix round 1 (Finding 3): a throw-site-only selector (`ThrowStatement > NewExpression`)
  // misses this — the built-in error is constructed on one line and thrown, as a bare
  // identifier, on the next. The construction ban below fires at the `new Error(...)` site
  // regardless of what happens to the resulting value afterward, which is what closes this.
  it('reports constructing a built-in Error even when not thrown inline (indirect throw)', async () => {
    const messages = await lintMessages(
      "export function f(): void {\n  const e = new Error('boom');\n  throw e;\n}\n",
      ORDINARY_FILE,
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('does not report constructing a built-in error inside lib/errors.ts', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      'lib/errors.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  // Fix round 1 (Finding 1): the previous lib/errors.ts override turned the whole
  // `no-restricted-syntax` rule off, which also silently suppressed FETCH_BAN — a
  // regression of F-01 criterion 4 that the test above (which never exercises fetch)
  // could not have caught. This asserts the fetch ban specifically, on the same file.
  it('still reports bare fetch(...) inside lib/errors.ts', async () => {
    const messages = await lintMessages(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'lib/errors.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/net.ts')),
    ).toBe(true);
  });

  it('reports declaring a class that extends the built-in Error directly', async () => {
    const messages = await lintMessages(
      'export class SneakyError extends Error {}\n',
      ORDINARY_FILE,
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('does not report a class extending Error inside lib/errors.ts (AppError itself)', async () => {
    const ruleIds = await lint(
      "export class AppError extends Error {\n  constructor() {\n    super('x');\n  }\n}\n",
      'lib/errors.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  it('still bans constructing a built-in error inside lib/net.ts, despite its fetch override', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      'lib/net.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  // Composer decision (fix round 1, Finding 3): tests/** is exempted from the construction
  // ban only, so a test can legitimately synthesize a foreign plain Error to prove
  // AppError's `cause` option — this is exactly what tests/errors.test.ts:38-51 does.
  // Reuses tests/errors.test.ts's own real path (lintText overrides its content) rather
  // than a fake tests/ path, so no new allowDefaultProject entry is needed.
  it('does not report constructing a built-in Error inside tests/** (the cause-wrapping exemption)', async () => {
    const ruleIds = await lint("const e = new Error('boom');\n", 'tests/errors.test.ts');
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  it('still reports a class extending Error inside tests/** — the exemption is construction-only', async () => {
    const messages = await lintMessages(
      'export class SneakyTestError extends Error {}\n',
      'tests/errors.test.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('still reports bare fetch(...) inside tests/** — the exemption is construction-only', async () => {
    const messages = await lintMessages(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'tests/errors.test.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/net.ts')),
    ).toBe(true);
  });

  it('reports throwing a non-Error literal value (@typescript-eslint/only-throw-error)', async () => {
    const ruleIds = await lint("export function f(): void {\n  throw 'oops';\n}\n", ORDINARY_FILE);
    expect(ruleIds).toContain('@typescript-eslint/only-throw-error');
  });

  it('reports throwing a plain object (@typescript-eslint/only-throw-error)', async () => {
    const ruleIds = await lint(
      'export function f(): void {\n  throw { code: 1 };\n}\n',
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('@typescript-eslint/only-throw-error');
  });

  it('does not report throwing a subclass of AppError', async () => {
    const ruleIds = await lint(
      "import { ConfigError } from '../lib/errors.js';\nexport function f(): void {\n  throw new ConfigError('boom');\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).not.toContain('@typescript-eslint/only-throw-error');
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });
});

describe('eslint prohibitions (F-06 criterion 2, part 1: no catch {})', () => {
  it('reports an empty catch block', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  try {\n    JSON.parse('{}');\n  } catch {\n  }\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-empty');
  });

  it('does not report a catch block that does something', async () => {
    const ruleIds = await lint(
      "import { ConfigError } from '../lib/errors.js';\nexport function f(): void {\n  try {\n    JSON.parse('{}');\n  } catch (err) {\n    throw new ConfigError('parse failed', { cause: err });\n  }\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).not.toContain('no-empty');
  });
});

describe('eslint prohibitions (F-06 criterion 2, part 2: no bare rethrow-and-swallow)', () => {
  // `no-restricted-syntax` selectors can't express "the thrown identifier is the same one
  // the catch clause bound" (esquery has no cross-node identity comparison), so this uses
  // ESLint core's `no-useless-catch`, which does that check via real scope analysis —
  // exactly the kind of "assert on real lint output, not config shape" the F-01 test style
  // requires, just via a different, better-suited existing rule instead of a hand-rolled one.
  it('reports a bare rethrow (catch (e) { throw e; }, nothing else in the block)', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  try {\n    JSON.parse('{}');\n  } catch (e) {\n    throw e;\n  }\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-useless-catch');
  });

  it('does not report a catch block that wraps the error before rethrowing', async () => {
    const ruleIds = await lint(
      "import { ConfigError } from '../lib/errors.js';\nexport function f(): void {\n  try {\n    JSON.parse('{}');\n  } catch (err) {\n    throw new ConfigError('parse failed', { cause: err });\n  }\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).not.toContain('no-useless-catch');
  });

  // Composer decision (fix round 1, Finding 3): the bare-rethrow ban has no exemption
  // anywhere, tests and lib/errors.ts included — unlike the construction ban above.
  it('still reports a bare rethrow inside lib/errors.ts (no exemption for this ban)', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  try {\n    JSON.parse('{}');\n  } catch (e) {\n    throw e;\n  }\n}\n",
      'lib/errors.ts',
    );
    expect(ruleIds).toContain('no-useless-catch');
  });
});

describe('eslint prohibitions (I-01 criterion 3: adapters are only reachable through the registry)', () => {
  it('reports importing sources/hackernews/* outside the registry', async () => {
    const ruleIds = await lint(
      "import { x } from './hackernews/adapter.js';\nexport const y = x;\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('reports importing sources/appstore/* outside the registry', async () => {
    const ruleIds = await lint(
      "import { x } from './appstore/adapter.js';\nexport const y = x;\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('reports importing sources/reddit/* outside the registry', async () => {
    const ruleIds = await lint(
      "import { x } from './reddit/adapter.js';\nexport const y = x;\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  // The ban is location-independent (a regex over the specifier text, not a set of glob
  // shapes tied to the importer's own depth) — this proves it fires from a file nowhere
  // near sources/ too, using an existing real on-disk path so no new allowDefaultProject
  // entry is needed (lintText's `code` argument overrides whatever is really there).
  it('reports a deep adapter import from a file outside sources/ entirely', async () => {
    const ruleIds = await lint(
      "import { x } from '../sources/reddit/adapter.js';\nexport const y = x;\n",
      'tests/errors.test.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  // Exercises the `(/|$)` end-of-string branch specifically, not just the `/` branch every
  // case above already covers — a bare directory import with no trailing file segment.
  it('reports a bare directory import with no trailing file (./hackernews, no extension)', async () => {
    const ruleIds = await lint(
      "import { x } from './hackernews';\nexport const y = x;\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  // Boundary check: a same-named file that merely starts with one of the banned words must
  // not false-positive — the regex requires a `/` or string boundary on both sides, so this
  // proves it discriminates a directory *segment* from a filename that happens to start the
  // same way (mirrors this file's PROCESS_ENV_BAN bracket-notation boundary tests above).
  it('does not false-positive on a same-named file that is not the adapter directory', async () => {
    const ruleIds = await lint(
      "import { x } from './hackernews-utils.js';\nexport const y = x;\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  it('does not report a deep adapter import inside sources/registry.ts', async () => {
    const ruleIds = await lint(
      "import { x } from './hackernews/adapter.js';\nexport const y = x;\n",
      'sources/registry.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  // Fix-round-1-style regression guard (see the F-06/F-03 overrides above): the
  // sources/registry.ts exemption redefines `no-restricted-imports` with only
  // ADAPTER_DEEP_IMPORT_BAN dropped, not the whole rule turned off — this proves the
  // @anthropic-ai/sdk ban still applies there.
  it('still reports an @anthropic-ai/sdk import inside sources/registry.ts — the exemption is deep-adapter-import-only', async () => {
    const ruleIds = await lint(
      "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic();\n",
      'sources/registry.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  // Fix round 1, Finding 1 (CRITICAL): the sources/registry.ts exemption above was the
  // *only* one that existed — tests/** inherited the base ban unmodified, leaving I-02/
  // I-03/I-04 with nowhere to unit-test their own adapter module directly. Reviewer-verified
  // failure mode before this fix: a tests/sources/hackernews/adapter.test.ts importing
  // ../../../sources/hackernews/adapter.js was rejected.
  it('does not report a deep adapter import inside tests/sources/hackernews/**', async () => {
    const ruleIds = await lint(
      "import { x } from '../../../sources/hackernews/adapter.js';\nexport const y = x;\n",
      'tests/sources/hackernews/example.test.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  // A second, distinct platform directory — proves the `files` glob genuinely covers all
  // three adapter test directories (composer resolution 4 names all three), not just the
  // one directory a single test case happens to exercise.
  it('does not report a deep adapter import inside tests/sources/appstore/**', async () => {
    const ruleIds = await lint(
      "import { x } from '../../../sources/appstore/adapter.js';\nexport const y = x;\n",
      'tests/sources/appstore/example.test.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  // Regression guards for the tests/sources/<platform>/** override, mirroring every other
  // "the exemption is scoped, not a blanket rule-off" test in this file: it must lift
  // exactly the adapter-import ban and nothing else a plain tests/** file is bound by.
  it('still reports an @anthropic-ai/sdk import inside tests/sources/hackernews/** — the exemption is deep-adapter-import-only', async () => {
    const ruleIds = await lint(
      "import Anthropic from '@anthropic-ai/sdk';\nexport const client = new Anthropic();\n",
      'tests/sources/hackernews/example.test.ts',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('still reports bare fetch(...) inside tests/sources/hackernews/**', async () => {
    const messages = await lintMessages(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'tests/sources/hackernews/example.test.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/net.ts')),
    ).toBe(true);
  });

  it('still reports process.env access inside tests/sources/hackernews/**', async () => {
    const messages = await lintMessages(
      'export function f(): string | undefined {\n  return process.env.DATABASE_URL;\n}\n',
      'tests/sources/hackernews/example.test.ts',
    );
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/config.ts'),
      ),
    ).toBe(true);
  });
});

describe('eslint prohibitions (I-01 criterion 3, fix round 1 Finding 2: the dynamic import() form)', () => {
  it('reports a dynamic import() of sources/hackernews/* outside the registry', async () => {
    const ruleIds = await lint(
      "export async function f() {\n  const m = await import('./hackernews/adapter.js');\n  return m;\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('reports a dynamic import() of sources/appstore/* outside the registry', async () => {
    const ruleIds = await lint(
      "export async function f() {\n  const m = await import('./appstore/adapter.js');\n  return m;\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  it('reports a dynamic import() of sources/reddit/* outside the registry', async () => {
    const ruleIds = await lint(
      "export async function f() {\n  const m = await import('./reddit/adapter.js');\n  return m;\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).toContain('no-restricted-syntax');
  });

  // Same boundary condition as the static-import ban's own test: a same-named file that
  // merely starts with one of the banned words must not false-positive.
  it('does not false-positive on a dynamic import() of a same-named file', async () => {
    const ruleIds = await lint(
      "export async function f() {\n  const m = await import('./hackernews-utils.js');\n  return m;\n}\n",
      ORDINARY_FILE,
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  it('does not report a dynamic import() of an adapter inside sources/registry.ts', async () => {
    const ruleIds = await lint(
      "export async function f() {\n  const m = await import('./hackernews/adapter.js');\n  return m;\n}\n",
      'sources/registry.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  it('does not report a dynamic import() of an adapter inside tests/sources/hackernews/**', async () => {
    const ruleIds = await lint(
      "export async function f() {\n  const m = await import('../../../sources/hackernews/adapter.js');\n  return m;\n}\n",
      'tests/sources/hackernews/example.test.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
  });

  // Regression guards: dropping ADAPTER_DEEP_IMPORT_EXPRESSION_BAN for sources/registry.ts
  // required adding a `no-restricted-syntax` entry to that override for the first time (it
  // previously had none, inheriting the base array wholesale) — restating FETCH_BAN,
  // CONSTRUCT_BUILTIN_ERROR_BAN, EXTENDS_BUILTIN_ERROR_BAN, and PROCESS_ENV_BAN rather than
  // silently dropping them is exactly the mistake fix round 1 flagged elsewhere in this
  // file (F-06 fix round 1, Finding 1) — this proves that restatement actually took.
  it('still reports bare fetch(...) inside sources/registry.ts', async () => {
    const messages = await lintMessages(
      'export async function load(): Promise<Response> {\n  return fetch("https://example.com");\n}\n',
      'sources/registry.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/net.ts')),
    ).toBe(true);
  });

  it('still reports constructing a built-in Error inside sources/registry.ts', async () => {
    const messages = await lintMessages(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      'sources/registry.ts',
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('still reports process.env access inside sources/registry.ts', async () => {
    const messages = await lintMessages(
      'export function f(): string | undefined {\n  return process.env.DATABASE_URL;\n}\n',
      'sources/registry.ts',
    );
    expect(
      messages.some(
        (m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('lib/config.ts'),
      ),
    ).toBe(true);
  });
});

// Regression test for R-02: eslint.config.js's `allowDefaultProject` used to be a fixed
// array that never changed, so it silently drifted out of sync the moment a listed path
// became a real file — F-04's lib/net.ts and F-05's lib/llm.ts both did this, and
// typescript-eslint then hard-errored on *every* file in the run ("was included by
// allowDefaultProject but also was found in the project service"), not just the two stale
// entries. That failure mode is a fatal parser error, which surfaces as a `ruleId: null`
// message — `lintMessages` above throws on exactly that rather than letting a test's rule-ID
// assertion silently see an empty array and read "no violations" instead of "the check never
// ran". A test that only exercised one of the two paths below would have passed even before
// R-02's fix existed (each direction worked fine on its own; the bug was specifically the
// interaction between a fixed candidate list and a path crossing from one side to the other),
// so this asserts both directions in one place: a path R-02's `existsSync` filter now excludes
// from `allowDefaultProject` because it is real on disk (lib/net.ts, resolved through the
// actual tsconfig project), and a path the filter still includes because nothing has created
// it (sources/example.ts, resolved through the default-project fallback). Both use
// `@typescript-eslint/only-throw-error` specifically because it requires type information
// (`requiresTypeChecking: true`) — exactly the kind of check that goes silently missing, not
// loudly wrong, if type resolution for a path breaks.
describe('eslint.config.js: allowDefaultProject derived from disk state (R-02)', () => {
  it('resolves typed linting through a real, on-disk path (lib/net.ts) via the actual tsconfig project', async () => {
    const ruleIds = await lint("export function f(): void {\n  throw 'oops';\n}\n", 'lib/net.ts');
    expect(ruleIds).toContain('@typescript-eslint/only-throw-error');
  });

  it('resolves typed linting through a still-virtual path (sources/example.ts) via the allowDefaultProject fallback', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  throw 'oops';\n}\n",
      'sources/example.ts',
    );
    expect(ruleIds).toContain('@typescript-eslint/only-throw-error');
  });
});
