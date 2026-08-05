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
//  - I-01 criterion 3 ("the registry is the only way to obtain an adapter"): two rules close
//    the two ways to reach `sources/{hackernews,appstore,reddit}/*` from outside
//    sources/registry.ts. `no-restricted-imports` (`ADAPTER_DEEP_IMPORT_BAN`) bans the static
//    `import ... from '...'` / `export ... from '...'` forms; `no-restricted-syntax`
//    (`ADAPTER_DEEP_IMPORT_EXPRESSION_BAN`) separately bans the dynamic `import(...)` form,
//    which `no-restricted-imports` does not see at all (fix round 1, Finding 2 — verified
//    empirically: a dynamic import of a banned path produced zero messages against only the
//    first rule). Two exemptions exist, both redefining rather than disabling: sources/
//    registry.ts (the door itself) and tests/sources/{hackernews,appstore,reddit}/** (fix
//    round 1, Finding 1 — I-02/I-03/I-04 need to unit-test their own adapter module
//    directly, the same way every other adapter test in this repo imports the module under
//    test).
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
// ALLOW_DEFAULT_PROJECT_CANDIDATES below lists the small, fixed set of exact virtual paths
// tests/eslint-rules.test.ts reuses across many `lintText` calls.
//
// The second of those three restrictions is what turned R-02 into an outage: an entry stops
// being a virtual fixture the moment some later task creates a real file at that path (F-04
// did this for lib/net.ts, F-05 for lib/llm.ts), and typescript-eslint then hard-errors on
// *every* file — "was included by allowDefaultProject but also was found in the project
// service" — because the entry now collides with the real project covering that same path.
// A fixed array made this a manual invariant that three tasks in a row tripped over, since
// nothing forced whoever added lib/net.ts to remember an unrelated line in this config file.
// So `allowDefaultProject` below is *derived*, not the candidate list itself: it filters the
// candidates down to whichever ones `existsSync` still finds absent from disk, at the moment
// eslint.config.js is loaded (i.e. on every `eslint` invocation, not just when this file is
// edited). A candidate is a virtual fixture exactly while its file doesn't exist yet, and the
// instant a task creates that file, this filter drops the now-stale entry on its own — no
// future task can trip this again, and the resolved-real-file case (already proven by the
// lib/net.ts and lib/llm.ts lintText cases below) is exercised on every candidate the moment
// it graduates rather than only after someone remembers to edit this list.
// Candidates are resolved against `import.meta.dirname`, consistent with `tsconfigRootDir`
// below — a bare relative path would resolve against the process cwd instead, which is not
// guaranteed to be this file's directory. The candidate list stays an explicit, readable
// array rather than something computed or hidden, since the point is to remove the
// maintenance burden of deleting stale entries, not to obscure which paths are virtual;
// filtering only ever shrinks it, so the 8-distinct-matched-file cap mentioned above still
// holds trivially. A prohibition test added by a later task needs either one of the
// still-virtual candidates below, or a real on-disk path (which needs no entry here at all —
// see how the lib/errors.ts and tests/errors.test.ts override tests below reuse real paths),
// or its own new candidate entry.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

const NET_WRAPPER = 'lib/net.ts';
const LLM_WRAPPER = 'lib/llm.ts';
const ERRORS_MODULE = 'lib/errors.ts';
const CONFIG_MODULE = 'lib/config.ts';
const REGISTRY_MODULE = 'sources/registry.ts';
const TESTS_GLOB = 'tests/**';

const ALLOW_DEFAULT_PROJECT_CANDIDATES = [
  NET_WRAPPER,
  LLM_WRAPPER,
  'sources/example.ts',
  'sources/hackernews/example.ts',
  'sources/reddit/example.ts',
  // Fix round 1, Finding 1: virtual fixtures proving the tests/sources/<platform>/**
  // override (below) actually lifts the adapter-deep-import ban there — I-02/I-03/I-04
  // haven't landed yet, so no real file exists at either path (these stay virtual, like
  // the sources/hackernews/example.ts and sources/reddit/example.ts entries above, until a
  // real adapter test file appears at one of these exact paths).
  'tests/sources/hackernews/example.test.ts',
  'tests/sources/appstore/example.test.ts',
];

const allowDefaultProject = ALLOW_DEFAULT_PROJECT_CANDIDATES.filter(
  (candidate) => !existsSync(join(import.meta.dirname, candidate)),
);

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

// SPEC I-01 criterion 3 / composer resolution 4: adapters are never imported directly by
// ingest (or any other) code — only sources/registry.ts may reach into a platform adapter's
// internals. `no-restricted-imports`'s `group` option (gitignore-style globs) only matches
// what a relative specifier literally spells out, which varies with the importing file's
// own depth (`./hackernews/x.js` from a sources/ sibling vs `../../sources/hackernews/x.js`
// from ingest/) — there is no fixed set of glob shapes that covers every caller location.
// `regex` instead matches the specifier text directly regardless of the importer's path,
// the same location-independent approach FETCH_BAN and PROCESS_ENV_BAN above already take
// for their own bans. The pattern requires a `/` or string boundary on both sides of the
// directory name so it matches only that path *segment* — `./hackernews/adapter.js` and a
// bare `./hackernews` (no trailing file) both match, but a same-named file that merely
// starts with one of these words (`./hackernews-utils.js`) does not.
const ADAPTER_DEEP_IMPORT_BAN = {
  regex: '(^|/)(hackernews|appstore|reddit)(/|$)',
  message: `Importing a platform adapter's internals directly is forbidden outside ${REGISTRY_MODULE} — obtain an adapter through the registry instead (SPEC I-01 criterion 3).`,
};

// Fix round 1, Finding 2: `no-restricted-imports` only inspects `ImportDeclaration` /
// `ExportNamedDeclaration` / `ExportAllDeclaration` nodes — it never sees an `ImportExpression`
// (`import('./hackernews/adapter.js')`), so ADAPTER_DEEP_IMPORT_BAN alone leaves the dynamic
// form of the exact same bypass wide open. This is the same class of gap FETCH_BAN and
// PROCESS_ENV_BAN close for their own targets (a single AST node shape, matched everywhere via
// `no-restricted-syntax` rather than trusting every caller to remember a second rule), so it
// gets the same treatment rather than a bespoke fix. Same regex as ADAPTER_DEEP_IMPORT_BAN,
// re-expressed as an esquery regex literal (`/pattern/`, forward slashes escaped) since
// `no-restricted-syntax` selectors match via esquery, not the `ignore`/`regex`-string option
// `no-restricted-imports` accepts — verified against a standalone ESLint run before wiring
// this in, matching `import('./hackernews/adapter.js')` and not `import('./types.js')`.
const ADAPTER_DEEP_IMPORT_EXPRESSION_BAN = {
  selector: 'ImportExpression[source.value=/(^|\\/)(hackernews|appstore|reddit)(\\/|$)/]',
  message: `Importing a platform adapter's internals directly is forbidden outside ${REGISTRY_MODULE} — obtain an adapter through the registry instead (SPEC I-01 criterion 3). This bans the dynamic import() form specifically; ADAPTER_DEEP_IMPORT_BAN bans the static form.`,
};

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.next/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject,
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
        ADAPTER_DEEP_IMPORT_EXPRESSION_BAN,
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
          patterns: [ADAPTER_DEEP_IMPORT_BAN],
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
        ADAPTER_DEEP_IMPORT_EXPRESSION_BAN,
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
      'no-restricted-syntax': [
        'error',
        FETCH_BAN,
        PROCESS_ENV_BAN,
        ADAPTER_DEEP_IMPORT_EXPRESSION_BAN,
      ],
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
        ADAPTER_DEEP_IMPORT_EXPRESSION_BAN,
      ],
    },
  },
  {
    // sources/registry.ts is the sole permitted door into a platform adapter's internals
    // (SPEC I-01 criterion 3; composer resolution 4) — this drops ADAPTER_DEEP_IMPORT_BAN
    // (static form) and ADAPTER_DEEP_IMPORT_EXPRESSION_BAN (dynamic form) only, the same
    // redefine-not-disable idiom as every override above. The file stays bound by the
    // @anthropic-ai/sdk ban and every other no-restricted-syntax ban — fix round 1 added
    // the `no-restricted-syntax` entry below (this block previously didn't need one, since
    // ADAPTER_DEEP_IMPORT_EXPRESSION_BAN didn't exist yet); it restates FETCH_BAN,
    // CONSTRUCT_BUILTIN_ERROR_BAN, EXTENDS_BUILTIN_ERROR_BAN, and PROCESS_ENV_BAN rather than
    // omitting them, since a later block's `rules` entry replaces an earlier match's for that
    // rule key instead of merging with it — the same reason every other override in this file
    // restates the bans it isn't dropping.
    files: [REGISTRY_MODULE],
    rules: {
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
      'no-restricted-syntax': [
        'error',
        FETCH_BAN,
        CONSTRUCT_BUILTIN_ERROR_BAN,
        EXTENDS_BUILTIN_ERROR_BAN,
        PROCESS_ENV_BAN,
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
      'no-restricted-syntax': [
        'error',
        FETCH_BAN,
        EXTENDS_BUILTIN_ERROR_BAN,
        PROCESS_ENV_BAN,
        ADAPTER_DEEP_IMPORT_EXPRESSION_BAN,
      ],
    },
  },
  {
    // Fix round 1, Finding 1 (CRITICAL): the TESTS_GLOB override above never touched
    // `no-restricted-imports`, so tests/** inherited the base ADAPTER_DEEP_IMPORT_BAN
    // unmodified — meaning I-02/I-03/I-04 had no directory in which to unit-test their own
    // adapter module directly, since sources/hackernews/, sources/appstore/, and
    // sources/reddit/ are pinned by stub files already on disk and every plausible test path
    // under tests/sources/<platform>/ matches the same ban. Routing every adapter test
    // through the shared `registry` singleton instead was the only alternative, which would
    // mean every adapter's tests sharing one netClient's rate-limit state and transport —
    // the opposite of createNetClient's own "tests build one per case so state never leaks
    // between them" pattern (lib/net.ts's doc comment).
    //
    // This block is deliberately scoped to exactly the three adapter test directories, not
    // all of tests/**, and — like the sources/registry.ts override above — drops both
    // ADAPTER_DEEP_IMPORT_BAN (static import) and ADAPTER_DEEP_IMPORT_EXPRESSION_BAN
    // (dynamic import) so a test isn't arbitrarily allowed one form and not the other. It
    // restates FETCH_BAN, EXTENDS_BUILTIN_ERROR_BAN, and PROCESS_ENV_BAN — the TESTS_GLOB
    // block's own restrictions minus CONSTRUCT_BUILTIN_ERROR_BAN, exactly matching what
    // TESTS_GLOB already carries — rather than omitting them, for the same "a later block's
    // `rules` entry replaces rather than merges" reason as every override in this file. This
    // block is placed after TESTS_GLOB in the array specifically so its narrower `files`
    // glob wins for the files both match.
    files: ['tests/sources/hackernews/**', 'tests/sources/appstore/**', 'tests/sources/reddit/**'],
    rules: {
      'no-restricted-syntax': ['error', FETCH_BAN, EXTENDS_BUILTIN_ERROR_BAN, PROCESS_ENV_BAN],
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
  prettierConfig,
);
