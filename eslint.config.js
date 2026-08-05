// Flat config (ESLint 9+). The prohibitions below exist to prove, mechanically, criteria
// that would otherwise just be claims:
//  - F-01 criterion 4: `any`, bare `fetch`, and direct `@anthropic-ai/sdk` imports are
//    rejected everywhere except the wrapper modules CLAUDE.md designates — lib/net.ts and
//    lib/llm.ts respectively — via per-file overrides at the bottom of this array.
//  - F-06 criterion 1 ("every thrown error in the repo is an instance of a class from
//    lib/errors.ts"): banning `throw new <BuiltinCtor>(...)` alone leaves a bypass — a
//    locally declared `class Sneaky extends Error {}` thrown elsewhere would pass that
//    check while still not being an AppError. So this also bans declaring a class that
//    extends the built-in Error directly, forcing every custom error class to route
//    through AppError (lib/errors.ts) instead. `@typescript-eslint/only-throw-error`
//    closes the remaining gap: throwing a non-Error value at all (`throw 'oops'`).
//  - F-06 criterion 2 ("no `catch {}`"): `no-empty` with `allowEmptyCatch` left at its
//    default `false`.
//
// `only-throw-error` requires type information (`requiresTypeChecking: true` in its own
// metadata), so this file turns on typed linting via `parserOptions.projectService`.
// `allowDefaultProject` lets tests/eslint-rules.test.ts keep proving these rules against
// virtual, non-existent-on-disk file paths via `lintText` (matching the existing F-01 test
// style) without every such path needing a real tsconfig entry — real files already in
// tsconfig.json's `**/*.ts` include get the full, cross-file-aware project instead of this
// per-file fallback. typescript-eslint refuses a literal `**` or bare `*` glob here (perf
// guard against every file silently falling back to the slow default project — see
// https://tseslint.com/allowdefaultproject-glob-too-wide), refuses a glob that matches a
// file the real project already covers (e.g. `sources/*.ts` would collide with the real
// sources/types.ts), and caps the default project at 8 distinct matched files per process.
// Those three restrictions rule out a directory-shaped glob here (every such shape in this
// repo already has a real `types.ts` in it) and rule out one fake path per test case, so
// this lists the small, fixed set of exact virtual paths tests/eslint-rules.test.ts reuses
// across many `lintText` calls. A prohibition test added by a later task needs either one
// of these paths or its own new entry here.
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

const NET_WRAPPER = 'lib/net.ts';
const LLM_WRAPPER = 'lib/llm.ts';
const ERRORS_MODULE = 'lib/errors.ts';

const BUILTIN_ERROR_CTORS =
  '/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError)$/';

const FETCH_BAN = {
  selector: "CallExpression[callee.name='fetch']",
  message: `Bare fetch is forbidden — route outbound HTTP through ${NET_WRAPPER} (CLAUDE.md conventions).`,
};

const THROW_BUILTIN_ERROR_BAN = {
  selector: `ThrowStatement > NewExpression[callee.name=${BUILTIN_ERROR_CTORS}]`,
  message: `Throw a subclass of AppError from ${ERRORS_MODULE} instead of a built-in error constructor (CLAUDE.md: "Throw typed errors from lib/errors.ts").`,
};

const EXTENDS_BUILTIN_ERROR_BAN = {
  selector: `:matches(ClassDeclaration, ClassExpression)[superClass.name=${BUILTIN_ERROR_CTORS}]`,
  message: `Custom error classes must extend AppError (${ERRORS_MODULE}), not a built-in error constructor directly — a bare "extends Error" bypasses the lib/errors.ts taxonomy.`,
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.next/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'lib/net.ts',
            'lib/llm.ts',
            'sources/example.ts',
            'sources/hackernews/example.ts',
            'sources/reddit/example.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-restricted-syntax': [
        'error',
        FETCH_BAN,
        THROW_BUILTIN_ERROR_BAN,
        EXTENDS_BUILTIN_ERROR_BAN,
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
    // lib/net.ts legitimately calls bare fetch (it *is* the wrapper), but it must still
    // throw only AppError subclasses and must not grow its own ad hoc Error subclass — so
    // this redefines the rule with FETCH_BAN dropped rather than turning it off wholesale.
    files: [NET_WRAPPER],
    rules: {
      'no-restricted-syntax': ['error', THROW_BUILTIN_ERROR_BAN, EXTENDS_BUILTIN_ERROR_BAN],
    },
  },
  {
    files: [LLM_WRAPPER],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // AppError itself must extend the built-in Error, and the taxonomy module is the one
    // place a bare `throw new Error(...)` would be legitimate — so no-restricted-syntax is
    // off here in full, same idiom as the NET_WRAPPER/LLM_WRAPPER overrides above.
    files: [ERRORS_MODULE],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettierConfig,
);
