// Flat config (ESLint 9+). The prohibitions below exist to prove, mechanically, criteria
// that would otherwise just be claims:
//  - F-01 criterion 4: `any`, bare `fetch`, and direct `@anthropic-ai/sdk` imports are
//    rejected everywhere except the wrapper modules CLAUDE.md designates — lib/net.ts and
//    lib/llm.ts respectively — via per-file overrides at the bottom of this array.
//  - F-06 criterion 1 ("every thrown error in the repo is an instance of a class from
//    lib/errors.ts"): four layers close successively narrower gaps.
//    (1) `no-restricted-syntax` bans *constructing* a built-in error type at all
//        (`new Error(...)`, `new TypeError(...)`, ...) — not just `throw new Error(...)`
//        inline, because `const e = new Error(...); throw e;` and any other indirection
//        would otherwise slip past a throw-site-only check while still not being an
//        AppError. This subsumes an earlier, narrower `ThrowStatement > NewExpression`
//        selector (fix round 1), which is why only one construction-banning selector
//        exists below rather than two.
//    (2) `no-restricted-syntax` also bans declaring a class that extends one of those
//        built-ins directly — a locally declared `class Sneaky extends Error {}` would
//        defeat (1) while still not being an AppError.
//    (3) `@typescript-eslint/only-throw-error` bans throwing a non-Error value at all
//        (`throw 'oops'`, `throw {code: 1}`).
//    (4) `no-useless-catch` (ESLint core) bans a bare rethrow — `catch (e) { throw e; }`
//        with nothing else in the block — using its own scope-based check that the
//        thrown identifier is literally the caught one, which a `no-restricted-syntax`
//        selector cannot express (esquery selectors can't compare one node's property to
//        another's). SPEC's "no bare rethrow-and-swallow" text is what this closes.
//    None of these four discriminate *why* a value was constructed, so `tests/**` is
//    exempted from (1) only — a test proving `AppError`'s `cause` option preserves an
//    externally-caught error legitimately needs to synthesize a foreign plain `Error`
//    (see tests/errors.test.ts). Tests remain subject to (2), (3), and (4).
//  - F-06 criterion 2 ("no `catch {}` or bare rethrow-and-swallow"): `no-empty` with
//    `allowEmptyCatch` left at its default `false` bans the empty case; `no-useless-catch`
//    (above) bans the bare-rethrow case. Neither has an exemption anywhere.
//  - F-03 criterion 2 ("no `process.env` access anywhere outside the config module"):
//    `no-restricted-syntax` bans a `process.env` member expression everywhere except
//    lib/config.ts, via the same redefine-the-rule idiom as the fetch/error bans above —
//    every override that already redefines `no-restricted-syntax` for its file (NET_WRAPPER,
//    ERRORS_MODULE, TESTS_GLOB) picks this ban back up explicitly rather than losing it by
//    omission, since lib/config.ts is the only file that should ever be exempt from it.
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
// of these paths, or a real on-disk path (which needs no entry here at all — see how the
// lib/errors.ts and tests/errors.test.ts override tests below reuse real paths), or its
// own new allowDefaultProject entry.
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

const NET_WRAPPER = 'lib/net.ts';
const LLM_WRAPPER = 'lib/llm.ts';
const ERRORS_MODULE = 'lib/errors.ts';
const CONFIG_MODULE = 'lib/config.ts';
const TESTS_GLOB = 'tests/**';

const BUILTIN_ERROR_CTORS =
  '/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError)$/';

const FETCH_BAN = {
  selector: "CallExpression[callee.name='fetch']",
  message: `Bare fetch is forbidden — route outbound HTTP through ${NET_WRAPPER} (CLAUDE.md conventions).`,
};

// Matches `new Error(...)` etc. anywhere — assigned to a variable, passed as an argument,
// used as a `cause`, or thrown inline — not just as the direct child of a `throw`. A
// throw-site-only selector (`ThrowStatement > NewExpression[...]`) misses
// `const e = new Error(...); throw e;`, which is exactly as much a criterion-1 violation
// as throwing the constructor call directly.
const CONSTRUCT_BUILTIN_ERROR_BAN = {
  selector: `NewExpression[callee.name=${BUILTIN_ERROR_CTORS}]`,
  message: `Construct errors via AppError or a subclass from ${ERRORS_MODULE} instead of a built-in error constructor directly (CLAUDE.md: "Throw typed errors from lib/errors.ts").`,
};

const EXTENDS_BUILTIN_ERROR_BAN = {
  selector: `:matches(ClassDeclaration, ClassExpression)[superClass.name=${BUILTIN_ERROR_CTORS}]`,
  message: `Custom error classes must extend AppError (${ERRORS_MODULE}), not a built-in error constructor directly — a bare "extends Error" bypasses the lib/errors.ts taxonomy.`,
};

// Matches `process.env` itself and any deeper access through it (`process.env.FOO`, since
// that is a MemberExpression whose `object` is the `process.env` MemberExpression this
// selector already matches). The dot-notation clause alone missed bracket-notation access
// to the same property — `process["env"]` is a MemberExpression whose `property` is a
// `Literal` node, so it has `property.value` ('env'), not `property.name` (that's only set
// on `Identifier` nodes) — fix round 1, Finding 2 (reviewer verified `process["env"].FOO`
// and `process["env"]["FOO"]` produced zero lint messages against the dot-only selector).
// The second clause below closes that gap the same way the dot clause covers
// `process.env.FOO`: matching the inner `process["env"]` sub-expression, regardless of how
// it's chained afterward.
const PROCESS_ENV_BAN = {
  selector:
    ':matches(' +
    "MemberExpression[object.name='process'][property.name='env'], " +
    "MemberExpression[object.name='process'][computed=true][property.value='env']" +
    ')',
  message: `Reading process.env directly is forbidden outside ${CONFIG_MODULE} — call loadConfigFromEnv() or bootConfig() instead (SPEC F-03 criterion 2).`,
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
      'no-useless-catch': 'error',
      'no-restricted-syntax': [
        'error',
        FETCH_BAN,
        CONSTRUCT_BUILTIN_ERROR_BAN,
        EXTENDS_BUILTIN_ERROR_BAN,
        PROCESS_ENV_BAN,
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
    // throw only AppError subclasses, must not grow its own ad hoc Error subclass, and must
    // still get its settings (timeouts, rate limits) from the Config object rather than
    // reading process.env itself — so this redefines the rule with only FETCH_BAN dropped
    // rather than turning it off wholesale.
    files: [NET_WRAPPER],
    rules: {
      'no-restricted-syntax': [
        'error',
        CONSTRUCT_BUILTIN_ERROR_BAN,
        EXTENDS_BUILTIN_ERROR_BAN,
        PROCESS_ENV_BAN,
      ],
    },
  },
  {
    files: [LLM_WRAPPER],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // AppError itself must extend the built-in Error, and the taxonomy module is the one
    // place constructing a bare `new Error(...)` (for `AppError`'s own `super()` call, in
    // effect) is legitimate — so this redefines the rule with FETCH_BAN and PROCESS_ENV_BAN
    // kept, mirroring the NET_WRAPPER override above rather than turning the whole rule off.
    // Turning it off entirely (fix round 1's bug) silently also dropped FETCH_BAN, regressing
    // F-01 criterion 4 for this file — the same mistake would silently exempt this file from
    // PROCESS_ENV_BAN too if the rule were ever switched off instead of redefined.
    files: [ERRORS_MODULE],
    rules: {
      'no-restricted-syntax': ['error', FETCH_BAN, PROCESS_ENV_BAN],
    },
  },
  {
    // lib/config.ts is the sole module SPEC F-03 criterion 2 allows to read process.env —
    // this drops PROCESS_ENV_BAN only, the same redefine-not-disable idiom as every override
    // above, so the file stays bound by the fetch ban and the error-taxonomy bans.
    files: [CONFIG_MODULE],
    rules: {
      'no-restricted-syntax': [
        'error',
        FETCH_BAN,
        CONSTRUCT_BUILTIN_ERROR_BAN,
        EXTENDS_BUILTIN_ERROR_BAN,
      ],
    },
  },
  {
    // Composer decision (F-06 fix round 1): tests legitimately need to construct a foreign
    // plain `Error` to prove AppError's `cause` option preserves it (tests/errors.test.ts) —
    // that is a real, intentional exercise of the taxonomy's escape hatch, not a bypass of
    // it. Only CONSTRUCT_BUILTIN_ERROR_BAN is dropped; FETCH_BAN, EXTENDS_BUILTIN_ERROR_BAN,
    // and PROCESS_ENV_BAN still apply (tests build a Config from a literal object per F-03
    // resolution 2, or stub process.env via vitest's `vi.stubEnv`, never by writing
    // `process.env` in source), and this file has no bearing on `no-useless-catch` (a
    // separate rule, enabled unconditionally above) — the bare-rethrow ban has no exemption
    // anywhere, tests included.
    files: [TESTS_GLOB],
    rules: {
      'no-restricted-syntax': ['error', FETCH_BAN, EXTENDS_BUILTIN_ERROR_BAN, PROCESS_ENV_BAN],
    },
  },
  prettierConfig,
);
