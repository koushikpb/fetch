// Flat config (ESLint 9+). The three restricted-* rules below exist to prove
// F-01 criterion 4: `any`, bare `fetch`, and direct `@anthropic-ai/sdk` imports
// are rejected everywhere except the wrapper modules CLAUDE.md designates —
// lib/net.ts and lib/llm.ts respectively — via per-file overrides at the
// bottom of this array.
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

const NET_WRAPPER = 'lib/net.ts';
const LLM_WRAPPER = 'lib/llm.ts';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.next/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: `Bare fetch is forbidden — route outbound HTTP through ${NET_WRAPPER} (CLAUDE.md conventions).`,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message: `Import the Anthropic SDK only in ${LLM_WRAPPER} — all model calls route through it (CLAUDE.md conventions).`,
            },
          ],
        },
      ],
    },
  },
  {
    files: [NET_WRAPPER],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: [LLM_WRAPPER],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettierConfig,
);
