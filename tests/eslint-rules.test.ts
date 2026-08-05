// Proves F-01 criterion 4 mechanically rather than by config inspection: the
// three prohibitions (`any`, bare `fetch`, direct `@anthropic-ai/sdk` imports)
// must actually surface as lint errors, and the two wrapper-module overrides
// (lib/net.ts, lib/llm.ts) must actually suppress them. `lintText` with a
// virtual `filePath` is sufficient — ESLint's flat-config `files` globs match
// against that path without the file needing to exist on disk, so this does
// not require creating lib/net.ts or lib/llm.ts (out of scope: F-04, F-05).
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

async function lint(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .map((message) => message.ruleId)
    .filter((id): id is string => id !== null);
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
