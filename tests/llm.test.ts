// Proves lib/llm.ts's four testable surfaces (SPEC F-05 criterion 5): routing, batch
// submit/poll/retrieve, token accounting math, and budget refusal. Every test in this file
// injects a fake `LlmClient` and a fake `RunsRepo` — composer resolution #8 requires every
// test to run offline and deterministically, including with `ANTHROPIC_API_KEY` unset, and
// resolution #8 also requires a test proving no network call occurs at all. `LlmClient` and
// every other type used below is imported from lib/llm.ts itself, never from
// '@anthropic-ai/sdk' — eslint's `no-restricted-imports` bans that import in this file too
// (the TESTS_GLOB override in eslint.config.js does not lift it), which is exactly what
// forces every fake here to be a plain object rather than a partially-real SDK client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, ConfigError } from '../lib/errors.js';
import { loadConfig, type Config } from '../lib/config.js';
import {
  ALLOWED_MODELS,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  RATES,
  assertAllowedModel,
  computeCostUsd,
  createAnthropicClient,
  extract,
  synthesize,
  totalInputTokens,
  type AllowedModel,
  type BatchResultEntry,
  type BatchRequestParam,
  type CountTokensParams,
  type CreateMessageParams,
  type ExtractRequest,
  type LlmClient,
  type MessageResult,
  type RunUsageIncrement,
  type RunsRepo,
  type UsageLike,
} from '../lib/llm.js';

const FIXTURE_CONFIG_ENV = {
  DATABASE_URL: 'postgresql://fixture:fixture@localhost:5432/fixture',
  ANTHROPIC_API_KEY: 'sk-ant-fixture-not-a-real-key',
  BUDGET_CEILING_USD: '70',
};

function fixtureConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...FIXTURE_CONFIG_ENV, ...overrides });
}

function makeUsage(overrides: Partial<UsageLike> = {}): UsageLike {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...overrides,
  };
}

function makeMessageResult(overrides: Partial<MessageResult> = {}): MessageResult {
  return {
    id: 'msg_fixture',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'fixture response' }],
    usage: makeUsage({ input_tokens: 10, output_tokens: 5 }),
    stop_reason: 'end_turn',
    ...overrides,
  };
}

interface FakeClientCalls {
  create: CreateMessageParams[];
  countTokens: CountTokensParams[];
  batchesCreate: { requests: BatchRequestParam[] }[];
  batchesRetrieve: string[];
  batchesResults: string[];
}

interface FakeClientOptions {
  createResult?: MessageResult;
  countTokensInputTokens?: number;
  /** One `processing_status` value per successive `retrieve()` call; the last value repeats
   *  if `retrieve()` is called more times than this array has entries. */
  batchStatuses?: ('in_progress' | 'canceling' | 'ended')[];
  batchResults?: BatchResultEntry[];
}

function makeFakeClient(options: FakeClientOptions = {}): { client: LlmClient; calls: FakeClientCalls } {
  const calls: FakeClientCalls = {
    create: [],
    countTokens: [],
    batchesCreate: [],
    batchesRetrieve: [],
    batchesResults: [],
  };
  const statuses = options.batchStatuses ?? ['ended'];
  let retrieveCallIndex = 0;

  const client: LlmClient = {
    messages: {
      create: (params) => {
        calls.create.push(params);
        return Promise.resolve(options.createResult ?? makeMessageResult({ model: params.model }));
      },
      countTokens: (params) => {
        calls.countTokens.push(params);
        return Promise.resolve({ input_tokens: options.countTokensInputTokens ?? 10 });
      },
      batches: {
        create: (params) => {
          calls.batchesCreate.push(params);
          return Promise.resolve({ id: 'batch_fixture_1', processing_status: 'in_progress' });
        },
        retrieve: (batchId) => {
          calls.batchesRetrieve.push(batchId);
          const status = statuses[Math.min(retrieveCallIndex, statuses.length - 1)] ?? 'ended';
          retrieveCallIndex += 1;
          return Promise.resolve({ id: batchId, processing_status: status });
        },
        results: (batchId) => {
          calls.batchesResults.push(batchId);
          const entries = options.batchResults ?? [];
          async function* generate(): AsyncGenerator<BatchResultEntry> {
            for (const entry of entries) {
              yield entry;
            }
          }
          return Promise.resolve(generate());
        },
      },
    },
  };

  return { client, calls };
}

function makeFakeRunsRepo(trailingSpendUsd = 0): {
  repo: RunsRepo;
  recorded: { runId: string; increment: RunUsageIncrement }[];
  createdRuns: string[];
} {
  const recorded: { runId: string; increment: RunUsageIncrement }[] = [];
  // R-03 fix round (Finding 2): RunsRepo grew a `createRun` method, so every fake built by
  // this helper needs one too — the interface is now the enforced precondition, not just
  // `recordUsage` in isolation.
  const createdRuns: string[] = [];
  let nextFakeRunId = 0;
  const repo: RunsRepo = {
    getTrailingSpendUsd: () => Promise.resolve(trailingSpendUsd),
    // `stage` intentionally unused — this fake never persists anything, only hands back a
    // fresh id, so recording `stage` would be tracking state no test in this file asserts on.
    createRun: () => {
      nextFakeRunId += 1;
      const id = `fake-run-${nextFakeRunId}`;
      createdRuns.push(id);
      return Promise.resolve(id);
    },
    recordUsage: (runId, increment) => {
      recorded.push({ runId, increment });
      return Promise.resolve();
    },
  };
  return { repo, recorded, createdRuns };
}

const noopSleep = (): Promise<void> => Promise.resolve();

describe('assertAllowedModel — the Opus ban is a whitelist (SPEC F-05 criterion 2)', () => {
  it.each(ALLOWED_MODELS)('accepts %s without throwing', (model) => {
    expect(() => assertAllowedModel(model)).not.toThrow();
  });

  it.each([
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-opus-4-0',
    'claude-fable-5',
    'claude-mythos-5',
  ])('rejects the Opus/Opus-tier model id %s', (model) => {
    expect(() => assertAllowedModel(model)).toThrow(ConfigError);
    expect(() => assertAllowedModel(model)).toThrow(new RegExp(model));
  });

  it('rejects a model id that merely looks close to an allowed one', () => {
    // Proves the check is exact-match against the whitelist, not a prefix/substring test —
    // a blocklist-shaped implementation would be the kind of thing this misses.
    expect(() => assertAllowedModel('claude-haiku-4-5-20251001')).toThrow(ConfigError);
    expect(() => assertAllowedModel('claude-sonnet-5-preview')).toThrow(ConfigError);
  });

  it('rejects an empty string and arbitrary garbage', () => {
    expect(() => assertAllowedModel('')).toThrow(ConfigError);
    expect(() => assertAllowedModel('not-a-model-at-all')).toThrow(ConfigError);
  });
});

describe('routing — extract() always uses Haiku 4.5, synthesize() always uses Sonnet 5', () => {
  it('extract() submits every batch request with model claude-haiku-4-5', async () => {
    const { client, calls } = makeFakeClient({
      batchResults: [{ custom_id: 'doc-1', result: { type: 'succeeded', message: makeMessageResult() } }],
    });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();
    const requests: ExtractRequest[] = [
      { customId: 'doc-1', maxTokens: 512, messages: [{ role: 'user', content: 'extract this' }] },
    ];

    await extract({ runId: 'run-1', requests }, { client, runsRepo: repo, config, sleep: noopSleep });

    expect(calls.batchesCreate).toHaveLength(1);
    const submitted = calls.batchesCreate[0];
    expect(submitted?.requests.every((r) => r.params.model === 'claude-haiku-4-5')).toBe(true);
  });

  it('synthesize() calls messages.create with model claude-sonnet-5', async () => {
    const { client, calls } = makeFakeClient({ createResult: makeMessageResult({ model: 'claude-sonnet-5' }) });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await synthesize(
      { runId: 'run-1', maxTokens: 1024, messages: [{ role: 'user', content: 'synthesize this' }] },
      { client, runsRepo: repo, config },
    );

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.model).toBe('claude-sonnet-5');
  });

  it('synthesize() sets thinking explicitly, never sets temperature/top_p/top_k (composer resolution #11)', async () => {
    const { client, calls } = makeFakeClient();
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await synthesize(
      { runId: 'run-1', maxTokens: 1024, messages: [{ role: 'user', content: 'x' }] },
      { client, runsRepo: repo, config },
    );

    const params = calls.create[0];
    expect(params?.thinking).toEqual({ type: 'adaptive' });
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('extract() never sets thinking or output_config.effort (Haiku 4.5 errors on effort)', async () => {
    const { client, calls } = makeFakeClient({
      batchResults: [{ custom_id: 'doc-1', result: { type: 'succeeded', message: makeMessageResult() } }],
    });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await extract(
      { runId: 'run-1', requests: [{ customId: 'doc-1', maxTokens: 256, messages: [{ role: 'user', content: 'x' }] }] },
      { client, runsRepo: repo, config, sleep: noopSleep },
    );

    const submittedParams = calls.batchesCreate[0]?.requests[0]?.params;
    expect(submittedParams?.thinking).toBeUndefined();
    expect(submittedParams?.output_config).toBeUndefined();
  });
});

describe('batch submit/poll/retrieve', () => {
  it('creates the batch, polls retrieve() until ended, then reads results() exactly once', async () => {
    const { client, calls } = makeFakeClient({
      batchStatuses: ['in_progress', 'in_progress', 'ended'],
      batchResults: [{ custom_id: 'doc-1', result: { type: 'succeeded', message: makeMessageResult() } }],
    });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();
    const sleepCalls: number[] = [];

    await extract(
      { runId: 'run-1', requests: [{ customId: 'doc-1', maxTokens: 256, messages: [{ role: 'user', content: 'x' }] }] },
      {
        client,
        runsRepo: repo,
        config,
        pollIntervalMs: 1234,
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      },
    );

    expect(calls.batchesCreate).toHaveLength(1);
    expect(calls.batchesRetrieve).toHaveLength(3);
    expect(calls.batchesRetrieve.every((id) => id === 'batch_fixture_1')).toBe(true);
    expect(calls.batchesResults).toEqual(['batch_fixture_1']);
    // Slept once per non-terminal poll (two `in_progress` responses), using the injected
    // interval — proves polling never busy-loops or ignores `pollIntervalMs`.
    expect(sleepCalls).toEqual([1234, 1234]);
  });

  it('polls exactly once when the batch is already ended on first retrieve', async () => {
    const { client, calls } = makeFakeClient({
      batchStatuses: ['ended'],
      batchResults: [{ custom_id: 'doc-1', result: { type: 'succeeded', message: makeMessageResult() } }],
    });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await extract(
      { runId: 'run-1', requests: [{ customId: 'doc-1', maxTokens: 256, messages: [{ role: 'user', content: 'x' }] }] },
      { client, runsRepo: repo, config, sleep: noopSleep },
    );

    expect(calls.batchesRetrieve).toHaveLength(1);
  });

  it('returns an empty array and never dispatches when there are no requests', async () => {
    const { client, calls } = makeFakeClient();
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    const result = await extract({ runId: 'run-1', requests: [] }, { client, runsRepo: repo, config, sleep: noopSleep });

    expect(result).toEqual([]);
    expect(calls.batchesCreate).toHaveLength(0);
    expect(calls.countTokens).toHaveLength(0);
  });
});

describe('batch results are correlated by custom_id, not by position (composer resolution #9)', () => {
  it('maps each result to its own request even when results() yields them out of order', async () => {
    const requests: ExtractRequest[] = [
      { customId: 'doc-a', maxTokens: 100, messages: [{ role: 'user', content: 'a' }] },
      { customId: 'doc-b', maxTokens: 100, messages: [{ role: 'user', content: 'b' }] },
      { customId: 'doc-c', maxTokens: 100, messages: [{ role: 'user', content: 'c' }] },
    ];
    // Deliberately scrambled: c, then a, then b — the reverse-ish of request order.
    const scrambledResults: BatchResultEntry[] = [
      { custom_id: 'doc-c', result: { type: 'succeeded', message: makeMessageResult({ content: [{ type: 'text', text: 'C' }] }) } },
      { custom_id: 'doc-a', result: { type: 'succeeded', message: makeMessageResult({ content: [{ type: 'text', text: 'A' }] }) } },
      { custom_id: 'doc-b', result: { type: 'succeeded', message: makeMessageResult({ content: [{ type: 'text', text: 'B' }] }) } },
    ];
    const { client } = makeFakeClient({ batchResults: scrambledResults });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    const output = await extract({ runId: 'run-1', requests }, { client, runsRepo: repo, config, sleep: noopSleep });

    const byCustomId = new Map(output.map((entry) => [entry.customId, entry]));
    expect(byCustomId.get('doc-a')?.content?.[0]?.text).toBe('A');
    expect(byCustomId.get('doc-b')?.content?.[0]?.text).toBe('B');
    expect(byCustomId.get('doc-c')?.content?.[0]?.text).toBe('C');
    // Output order still follows request order, independent of result stream order.
    expect(output.map((e) => e.customId)).toEqual(['doc-a', 'doc-b', 'doc-c']);
  });

  it('surfaces errored, canceled, and expired results distinctly', async () => {
    const requests: ExtractRequest[] = [
      { customId: 'doc-ok', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { customId: 'doc-err', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { customId: 'doc-canceled', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { customId: 'doc-expired', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
    ];
    const batchResults: BatchResultEntry[] = [
      { custom_id: 'doc-ok', result: { type: 'succeeded', message: makeMessageResult() } },
      {
        custom_id: 'doc-err',
        result: {
          type: 'errored',
          error: { type: 'error', request_id: 'req_1', error: { type: 'invalid_request_error', message: 'bad prompt' } },
        },
      },
      { custom_id: 'doc-canceled', result: { type: 'canceled' } },
      { custom_id: 'doc-expired', result: { type: 'expired' } },
    ];
    const { client } = makeFakeClient({ batchResults });
    const { repo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    const output = await extract({ runId: 'run-1', requests }, { client, runsRepo: repo, config, sleep: noopSleep });
    const byCustomId = new Map(output.map((entry) => [entry.customId, entry]));

    expect(byCustomId.get('doc-ok')?.status).toBe('succeeded');
    expect(byCustomId.get('doc-err')?.status).toBe('errored');
    expect(byCustomId.get('doc-err')?.error).toEqual({ type: 'invalid_request_error', message: 'bad prompt' });
    expect(byCustomId.get('doc-canceled')?.status).toBe('canceled');
    expect(byCustomId.get('doc-expired')?.status).toBe('expired');
  });
});

describe('token accounting math (SPEC F-05 criterion 3)', () => {
  it('computeCostUsd uses input_tokens alone correctly when there is no caching', () => {
    const cost = computeCostUsd('claude-haiku-4-5', makeUsage({ input_tokens: 1_000_000, output_tokens: 0 }));
    expect(cost).toBeCloseTo(0.5, 10);
  });

  it('computeCostUsd prices output tokens at the output rate', () => {
    const cost = computeCostUsd('claude-haiku-4-5', makeUsage({ input_tokens: 0, output_tokens: 1_000_000 }));
    expect(cost).toBeCloseTo(2.5, 10);
  });

  it('computeCostUsd counts cache_read_input_tokens even when input_tokens is zero (composer resolution #2)', () => {
    // This is the exact undercount the brief warns about: if cost were computed from
    // input_tokens alone, this would be $0 — it must not be.
    const cost = computeCostUsd(
      'claude-haiku-4-5',
      makeUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(0.5 * CACHE_READ_MULTIPLIER, 10);
    expect(cost).toBeGreaterThan(0);
  });

  it('computeCostUsd counts cache_creation_input_tokens at the write multiplier', () => {
    const cost = computeCostUsd(
      'claude-haiku-4-5',
      makeUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(0.5 * CACHE_WRITE_MULTIPLIER, 10);
  });

  it('computeCostUsd sums all three input fields plus output for a mixed-usage call', () => {
    const usage = makeUsage({
      input_tokens: 200_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 500_000,
      output_tokens: 50_000,
    });
    const expected =
      (200_000 * RATES['claude-sonnet-5'].inputPerMillionUsd) / 1_000_000 +
      (100_000 * RATES['claude-sonnet-5'].inputPerMillionUsd * CACHE_WRITE_MULTIPLIER) / 1_000_000 +
      (500_000 * RATES['claude-sonnet-5'].inputPerMillionUsd * CACHE_READ_MULTIPLIER) / 1_000_000 +
      (50_000 * RATES['claude-sonnet-5'].outputPerMillionUsd) / 1_000_000;
    expect(computeCostUsd('claude-sonnet-5', usage)).toBeCloseTo(expected, 10);
  });

  it('computeCostUsd retains full floating-point precision for a tiny call (no premature rounding)', () => {
    // 3 tokens at $0.50/1M is $0.0000015 — far below numeric(10,4)'s 4-decimal resolution.
    // A per-call-rounded accumulator would collapse this to 0; the raw return value must not.
    const cost = computeCostUsd('claude-haiku-4-5', makeUsage({ input_tokens: 3, output_tokens: 0 }));
    expect(cost).toBeCloseTo(0.0000015, 12);
    expect(cost).toBeGreaterThan(0);
  });

  it('totalInputTokens sums all three input fields', () => {
    expect(
      totalInputTokens(makeUsage({ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 })),
    ).toBe(60);
  });

  it('totalInputTokens treats missing cache fields as zero', () => {
    expect(totalInputTokens({ input_tokens: 10, output_tokens: 5 })).toBe(10);
  });

  it('extract() aggregates usage across every succeeded result into one recorded increment', async () => {
    const requests: ExtractRequest[] = [
      { customId: 'doc-1', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { customId: 'doc-2', maxTokens: 100, messages: [{ role: 'user', content: 'y' }] },
    ];
    const batchResults: BatchResultEntry[] = [
      {
        custom_id: 'doc-1',
        result: { type: 'succeeded', message: makeMessageResult({ usage: makeUsage({ input_tokens: 100, output_tokens: 40 }) }) },
      },
      {
        custom_id: 'doc-2',
        result: { type: 'succeeded', message: makeMessageResult({ usage: makeUsage({ input_tokens: 200, output_tokens: 60 }) }) },
      },
    ];
    const { client } = makeFakeClient({ batchResults });
    const { repo, recorded } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await extract({ runId: 'run-42', requests }, { client, runsRepo: repo, config, sleep: noopSleep });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    expect(entry?.runId).toBe('run-42');
    expect(entry?.increment.model).toBe('claude-haiku-4-5');
    expect(entry?.increment.inputTokens).toBe(300);
    expect(entry?.increment.outputTokens).toBe(100);
    const expectedCost = computeCostUsd('claude-haiku-4-5', makeUsage({ input_tokens: 100, output_tokens: 40 }))
      + computeCostUsd('claude-haiku-4-5', makeUsage({ input_tokens: 200, output_tokens: 60 }));
    expect(entry?.increment.costUsd).toBeCloseTo(expectedCost, 12);
  });

  it('synthesize() records model, input tokens (including cache fields), output tokens, and cost', async () => {
    const usage = makeUsage({ input_tokens: 500, cache_read_input_tokens: 200, output_tokens: 150 });
    const { client } = makeFakeClient({ createResult: makeMessageResult({ model: 'claude-sonnet-5', usage }) });
    const { repo, recorded } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await synthesize(
      { runId: 'run-99', maxTokens: 2048, messages: [{ role: 'user', content: 'x' }] },
      { client, runsRepo: repo, config },
    );

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    expect(entry?.runId).toBe('run-99');
    expect(entry?.increment.model).toBe('claude-sonnet-5');
    expect(entry?.increment.inputTokens).toBe(700); // 500 + 200 cache read, per composer resolution #2
    expect(entry?.increment.outputTokens).toBe(150);
    expect(entry?.increment.costUsd).toBeCloseTo(computeCostUsd('claude-sonnet-5', usage), 12);
  });

  it('extract() does not call recordUsage at all when the batch produced no succeeded results', async () => {
    const { client } = makeFakeClient({ batchResults: [{ custom_id: 'doc-1', result: { type: 'canceled' } }] });
    const { repo, recorded } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await extract(
      { runId: 'run-1', requests: [{ customId: 'doc-1', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] }] },
      { client, runsRepo: repo, config, sleep: noopSleep },
    );

    expect(recorded).toHaveLength(0);
  });
});

describe('budget refusal (SPEC F-05 criterion 4)', () => {
  it('extract() throws BudgetExceededError and never calls batches.create when the projection exceeds the ceiling', async () => {
    const { client, calls } = makeFakeClient({ countTokensInputTokens: 1_000_000 });
    // Trailing spend already at the ceiling — any nonzero pending estimate pushes it over.
    const { repo } = makeFakeRunsRepo(70);
    const config = fixtureConfig({ BUDGET_CEILING_USD: '70' });

    await expect(
      extract(
        { runId: 'run-1', requests: [{ customId: 'doc-1', maxTokens: 1000, messages: [{ role: 'user', content: 'x' }] }] },
        { client, runsRepo: repo, config, sleep: noopSleep },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    // The guard ran before dispatch — the batch was never created.
    expect(calls.batchesCreate).toHaveLength(0);
  });

  it('synthesize() throws BudgetExceededError and never calls messages.create when the projection exceeds the ceiling', async () => {
    const { client, calls } = makeFakeClient({ countTokensInputTokens: 5_000_000 });
    const { repo } = makeFakeRunsRepo(69.99);
    const config = fixtureConfig({ BUDGET_CEILING_USD: '70' });

    await expect(
      synthesize(
        { runId: 'run-1', maxTokens: 4096, messages: [{ role: 'user', content: 'x' }] },
        { client, runsRepo: repo, config },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(calls.create).toHaveLength(0);
  });

  it('synthesize() dispatches normally when comfortably within budget', async () => {
    const { client, calls } = makeFakeClient({ countTokensInputTokens: 100 });
    const { repo } = makeFakeRunsRepo(0);
    const config = fixtureConfig({ BUDGET_CEILING_USD: '70' });

    await synthesize(
      { runId: 'run-1', maxTokens: 1024, messages: [{ role: 'user', content: 'x' }] },
      { client, runsRepo: repo, config },
    );

    expect(calls.create).toHaveLength(1);
  });

  it('bounds the pending output estimate by max_tokens, not by what the call would actually return', async () => {
    // A huge max_tokens on a call whose trailing spend is already near the ceiling should
    // refuse even though a real response would likely use far fewer output tokens — the
    // guard has to be conservative before it has any usage data to go on.
    const { client, calls } = makeFakeClient({ countTokensInputTokens: 1 });
    const { repo } = makeFakeRunsRepo(0);
    const config = fixtureConfig({ BUDGET_CEILING_USD: '1' });

    await expect(
      synthesize(
        { runId: 'run-1', maxTokens: 1_000_000, messages: [{ role: 'user', content: 'x' }] },
        { client, runsRepo: repo, config },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls.create).toHaveLength(0);
  });
});

describe('offline guarantee — no real network call ever occurs (composer resolution #8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('extract() and synthesize() never touch the global fetch, with or without ANTHROPIC_API_KEY set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { client: extractClient } = makeFakeClient({
      batchResults: [{ custom_id: 'doc-1', result: { type: 'succeeded', message: makeMessageResult() } }],
    });
    const { repo: extractRepo } = makeFakeRunsRepo();
    const config = fixtureConfig();

    await extract(
      { runId: 'run-1', requests: [{ customId: 'doc-1', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] }] },
      { client: extractClient, runsRepo: extractRepo, config, sleep: noopSleep },
    );

    const { client: synthesizeClient } = makeFakeClient();
    const { repo: synthesizeRepo } = makeFakeRunsRepo();
    await synthesize(
      { runId: 'run-2', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { client: synthesizeClient, runsRepo: synthesizeRepo, config },
    );

    // Also cover the refused path — a would-be caller might expect a refusal to at least
    // count tokens over the wire; it must not either.
    const { client: refusedClient } = makeFakeClient();
    const { repo: refusedRepo } = makeFakeRunsRepo(1000);
    await expect(
      synthesize(
        { runId: 'run-3', maxTokens: 100, messages: [{ role: 'user', content: 'x' }] },
        { client: refusedClient, runsRepo: refusedRepo, config },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createAnthropicClient constructs a client with no network call (construction is pure)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const client = createAnthropicClient('sk-ant-fixture-not-a-real-key');

    expect(client.messages).toBeDefined();
    expect(typeof client.messages.create).toBe('function');
    expect(typeof client.messages.countTokens).toBe('function');
    expect(typeof client.messages.batches.create).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createAnthropicClient — the whitelist guard also applies at the client boundary (fix round 1, Important)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // `CreateMessageParams.model` (and the batch request's `params.model`) is typed as
  // `AllowedModel`, so TypeScript would reject an Opus id at the call site below outright.
  // That compile-time rejection is exactly the "convenience defeated by a single type
  // assertion" the finding calls out — so this cast is the deliberate bypass under test,
  // not a shortcut around it. `unknown` as the intermediate step (rather than a direct
  // `as AllowedModel`) matches how an untyped JS caller or a runtime-constructed value
  // would actually reach this function: with no compile-time signal at all.
  function unsafeModel(id: string): AllowedModel {
    return id as unknown as AllowedModel;
  }

  it('client.messages.create rejects an Opus model id with ConfigError, never reaching the SDK', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = createAnthropicClient('sk-ant-fixture-not-a-real-key');

    await expect(
      client.messages.create({
        model: unsafeModel('claude-opus-5'),
        max_tokens: 100,
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    // The guard threw before the SDK ever built a request — proves this isn't a case
    // where the real API itself happened to reject an unrecognized model.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('client.messages.batches.create rejects a batch containing an Opus model id with ConfigError, never reaching the SDK', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = createAnthropicClient('sk-ant-fixture-not-a-real-key');
    const requests: BatchRequestParam[] = [
      {
        custom_id: 'doc-1',
        params: { model: unsafeModel('claude-opus-5'), max_tokens: 100, messages: [{ role: 'user', content: 'x' }] },
      },
    ];

    await expect(client.messages.batches.create({ requests })).rejects.toBeInstanceOf(ConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('client.messages.countTokens rejects an Opus model id with ConfigError, never reaching the SDK (R-03 Finding 1)', async () => {
    // Fix round 1 guarded `create` and `batches.create` at this same boundary but left
    // `countTokens` as a bare pass-through — this is the regression test for that gap.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = createAnthropicClient('sk-ant-fixture-not-a-real-key');

    await expect(
      client.messages.countTokens({
        model: unsafeModel('claude-opus-5'),
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('client.messages.batches.create checks every request in the batch, not just the first', async () => {
    const client = createAnthropicClient('sk-ant-fixture-not-a-real-key');
    const requests: BatchRequestParam[] = [
      { custom_id: 'doc-1', params: { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] } },
      { custom_id: 'doc-2', params: { model: unsafeModel('claude-opus-4-8'), max_tokens: 100, messages: [{ role: 'user', content: 'y' }] } },
    ];

    await expect(client.messages.batches.create({ requests })).rejects.toBeInstanceOf(ConfigError);
  });

  it('the guard lets both allowed models through — rejection past that point comes from the network, not ConfigError', async () => {
    // This suite must stay offline (composer resolution #8), so the stubbed fetch rejects
    // immediately rather than completing a real round trip. The assertion that matters is
    // *what* rejects the call: not ConfigError, proving the guard itself did not block it.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network disabled in this test'));
    vi.stubGlobal('fetch', fetchSpy);
    const client = createAnthropicClient('sk-ant-fixture-not-a-real-key');

    for (const model of ALLOWED_MODELS) {
      let thrown: unknown;
      try {
        await client.messages.create({ model, max_tokens: 100, messages: [{ role: 'user', content: 'x' }] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(ConfigError);
    }
    // Confirms the pass-through path really did reach the SDK's own request machinery
    // (not vacuously true because create() stopped short for some unrelated reason), and
    // that reach stayed entirely inside the stub — no real network I/O occurred.
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('ALLOWED_MODELS / RATES shape', () => {
  it('exposes exactly the two documented model ids', () => {
    expect([...ALLOWED_MODELS].sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it('RATES has an entry for every allowed model and nothing else', () => {
    expect(Object.keys(RATES).sort()).toEqual([...ALLOWED_MODELS].sort());
  });

  it('rates match the documented batch/standard figures (llm-facts.md, checked 2026-08-04)', () => {
    const haiku: AllowedModel = 'claude-haiku-4-5';
    const sonnet: AllowedModel = 'claude-sonnet-5';
    expect(RATES[haiku]).toEqual({ inputPerMillionUsd: 0.5, outputPerMillionUsd: 2.5 });
    expect(RATES[sonnet]).toEqual({ inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 });
  });
});
