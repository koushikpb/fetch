// Proves F-01 criterion 4 and F-06 criteria 1-2 mechanically rather than by config
// inspection: every prohibition below (`any`, bare `fetch`, direct `@anthropic-ai/sdk`
// imports, throwing a built-in error constructor, declaring a class that extends the
// built-in Error, throwing a non-Error value, an empty catch block) must actually surface
// as a lint error, and every wrapper-module override (lib/net.ts, lib/llm.ts,
// lib/errors.ts) must actually suppress the ones it's meant to. `lintText` with a virtual
// `filePath` is sufficient — ESLint's flat-config `files` globs match against that path
// without the file needing to exist on disk, and eslint.config.js's `allowDefaultProject`
// glob is what lets typed rules (`@typescript-eslint/only-throw-error`) resolve type
// information for a path that isn't part of the real tsconfig project. This does not
// require creating lib/net.ts or lib/llm.ts (out of scope: F-04, F-05).
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
  it('reports throwing a built-in Error constructor', async () => {
    const messages = await lintMessages(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      ORDINARY_FILE,
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('reports throwing other built-in error constructors (TypeError)', async () => {
    const messages = await lintMessages(
      "export function f(): void {\n  throw new TypeError('boom');\n}\n",
      ORDINARY_FILE,
    );
    expect(
      messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('AppError')),
    ).toBe(true);
  });

  it('does not report throwing a built-in error constructor inside lib/errors.ts', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      'lib/errors.ts',
    );
    expect(ruleIds).not.toContain('no-restricted-syntax');
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

  it('still bans throwing a built-in error constructor inside lib/net.ts, despite its fetch override', async () => {
    const ruleIds = await lint(
      "export function f(): void {\n  throw new Error('boom');\n}\n",
      'lib/net.ts',
    );
    expect(ruleIds).toContain('no-restricted-syntax');
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

describe('eslint prohibitions (F-06 criterion 2: no catch {})', () => {
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
