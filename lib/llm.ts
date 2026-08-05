// The single model-access path (CLAUDE.md: "All model calls go through lib/llm.ts... No
// bare Anthropic SDK calls"). eslint.config.js's `no-restricted-imports` override makes this
// file the sole place `@anthropic-ai/sdk` may be imported anywhere in the repo.
//
// Every type this module needs from the SDK is redeclared locally as a minimal structural
// interface (`LlmClient` and friends below) instead of imported from `@anthropic-ai/sdk`.
// This is not just style: the same import ban applies to `tests/**` (no override drops it
// there — see eslint.config.js's TESTS_GLOB block, which only re-adds FETCH_BAN,
// EXTENDS_BUILTIN_ERROR_BAN, and PROCESS_ENV_BAN, not the SDK import allowance), so a test
// file cannot import a single SDK type even for a fake. Defining the client shape here and
// exporting it is what makes offline, dependency-injected testing possible at all (SPEC F-05
// composer resolution #8).
import Anthropic from '@anthropic-ai/sdk';
import { eq, gt, sql } from 'drizzle-orm';
import type { Config } from './config.js';
import { ConfigError } from './errors.js';
import { log } from './log.js';
import { assertBudget } from './budget.js';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';

// ---------------------------------------------------------------------------------------
// Model routing — the Opus ban is a whitelist, not a blocklist (composer resolution #1).
// Rejecting anything that is not exactly one of these two strings is what makes a future
// Opus release (or any other model) unreachable by construction, rather than trusting a
// list of banned IDs to stay exhaustive as new models ship.
// ---------------------------------------------------------------------------------------

export const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5'] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/**
 * Throws a typed error naming the rejected model when `model` is not exactly one of
 * `ALLOWED_MODELS`. Called defensively at the top of both `extract()` and `synthesize()`
 * even though each hardcodes its own model as a literal — the assertion is what SPEC F-05
 * criterion 2 ("attempting to throws") actually tests, and it is what keeps this a runtime
 * guarantee rather than only a compile-time one if either function is ever refactored to
 * take a model parameter.
 *
 * Uses `ConfigError` rather than a new error class: lib/errors.ts is out of this task's file
 * scope (composer-owned per CLAUDE.md ยง2), and calling a disallowed model is a routing
 * *configuration* mistake, not a network failure, a timeout, a rate limit, or a budget
 * breach — the four other existing subclasses all describe runtime API outcomes, not a
 * request that should never have been built.
 */
export function assertAllowedModel(model: string): asserts model is AllowedModel {
  if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
    throw new ConfigError(
      `Model "${model}" is not on the allowed-model whitelist (${ALLOWED_MODELS.join(', ')}). Opus (and any model not explicitly allowed) must never be reachable from application code (CLAUDE.md cost envelope).`,
      { context: { rejectedModel: model } },
    );
  }
}

// ---------------------------------------------------------------------------------------
// Pricing — one exported table, one source, one date, so the next person updating prices
// has exactly one place to look (composer resolution #3).
//
// Source: llm-facts.md, checked 2026-08-04 (against the `claude-api` skill's cached model
// table, itself cached 2026-06-24). Sonnet 5 uses the standard $3.00/$15.00 rate, not the
// $2.00/$10.00 introductory rate that expires 2026-08-31 — projecting against a rate that is
// about to expire understates spend, which is exactly the class of error CLAUDE.md rule 6
// ("cost is a correctness property") exists to prevent. Haiku 4.5 extraction is always
// dispatched via the Message Batches API (CLAUDE.md: "Extraction is Haiku 4.5, batch API,
// always"), which halves standard token pricing on all token usage, so the input/output
// rates below are already the batch-discounted ($0.50/$2.50) figures, not the standard
// ($1.00/$5.00) ones.
// ---------------------------------------------------------------------------------------

export interface ModelRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export const RATES: Record<AllowedModel, ModelRate> = {
  'claude-haiku-4-5': { inputPerMillionUsd: 0.5, outputPerMillionUsd: 2.5 },
  'claude-sonnet-5': { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
};

// Cache pricing multipliers, applied to the base input rate above. Both are approximate
// per llm-facts.md ("Cache reads bill at ~0.1x; cache writes at ~1.25x (5-minute TTL) or
// ~2x (1-hour TTL)") — encoded explicitly here, per composer resolution #2, rather than
// left implicit, since a cost model that silently ignores caching undercounts the moment
// either route enables `cache_control`. Neither `extract()` nor `synthesize()` sets
// `cache_control` today (that is a caller/prompt decision — X-03/S-01, out of this task's
// scope), so these multipliers are currently inert, but `computeCostUsd` applies them
// unconditionally so cost stays correct the moment a caller does start caching.
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute (default/"ephemeral") TTL

/** The subset of `response.usage` this module's cost math needs. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Computes cost in full floating-point precision from all three input token fields —
 * `input_tokens` alone is only the *uncached* remainder (composer resolution #2). Callers
 * must not round this return value; `costUsd` is `numeric(10,4)` in `runs`, so rounding
 * per call and summing loses real money at 50k documents/month (composer resolution #4).
 * Round exactly once, at the point of persistence — see `RunsRepo.recordUsage` below.
 */
export function computeCostUsd(model: AllowedModel, usage: UsageLike): number {
  const rate = RATES[model];
  const uncachedInputTokens = usage.input_tokens;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const inputCostUsd =
    (uncachedInputTokens * rate.inputPerMillionUsd) / 1_000_000 +
    (cacheCreationTokens * rate.inputPerMillionUsd * CACHE_WRITE_MULTIPLIER) / 1_000_000 +
    (cacheReadTokens * rate.inputPerMillionUsd * CACHE_READ_MULTIPLIER) / 1_000_000;
  const outputCostUsd = (usage.output_tokens * rate.outputPerMillionUsd) / 1_000_000;
  return inputCostUsd + outputCostUsd;
}

/** Total prompt size — the sum of all three input fields, per composer resolution #2. */
export function totalInputTokens(usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

// ---------------------------------------------------------------------------------------
// The client shape this module depends on — a minimal structural subset of the real
// Anthropic SDK client, redeclared locally (see the file-header comment for why). The real
// SDK client structurally satisfies this interface, so `createAnthropicClient` below can
// hand one back with no adapter code; a test can implement the same interface with a plain
// object and inject it with no SDK dependency at all.
// ---------------------------------------------------------------------------------------

export interface MessageParamLike {
  role: 'user' | 'assistant';
  content: string;
}

export interface ThinkingConfigLike {
  type: 'adaptive' | 'disabled';
}

export interface OutputConfigLike {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface CreateMessageParams {
  model: AllowedModel;
  max_tokens: number;
  system?: string;
  messages: MessageParamLike[];
  thinking?: ThinkingConfigLike;
  output_config?: OutputConfigLike;
}

export interface ContentBlockLike {
  type: string;
  text?: string;
}

export interface MessageResult {
  id: string;
  model: string;
  content: ContentBlockLike[];
  usage: UsageLike;
  stop_reason: string | null;
}

export interface CountTokensParams {
  model: AllowedModel;
  system?: string;
  messages: MessageParamLike[];
}

export interface CountTokensResult {
  input_tokens: number;
}

export interface BatchRequestParam {
  custom_id: string;
  params: CreateMessageParams;
}

export interface BatchCreateResult {
  id: string;
  processing_status: string;
}

export interface BatchRetrieveResult {
  id: string;
  processing_status: 'in_progress' | 'canceling' | 'ended';
}

/** A single error's category and human-readable message — the inner payload of the
 *  envelope the SDK wraps every non-2xx error in (see `AnthropicErrorEnvelope`). */
export interface AnthropicErrorDetail {
  type: string;
  message: string;
}

/** The SDK's standard error envelope: `{type: "error", error: {type, message}, request_id}`
 *  — matched exactly (rather than flattened) so `createAnthropicClient` needs no adapter
 *  code between the real SDK's `MessageBatchErroredResult.error` and this type. */
export interface AnthropicErrorEnvelope {
  type: 'error';
  error: AnthropicErrorDetail;
  request_id: string | null;
}

export type BatchResult =
  | { type: 'succeeded'; message: MessageResult }
  | { type: 'errored'; error: AnthropicErrorEnvelope }
  | { type: 'canceled' }
  | { type: 'expired' };

export interface BatchResultEntry {
  custom_id: string;
  result: BatchResult;
}

export interface LlmClient {
  messages: {
    create(params: CreateMessageParams): Promise<MessageResult>;
    countTokens(params: CountTokensParams): Promise<CountTokensResult>;
    batches: {
      create(params: { requests: BatchRequestParam[] }): Promise<BatchCreateResult>;
      retrieve(batchId: string): Promise<BatchRetrieveResult>;
      // The real SDK resolves to a lazily-decoded async-iterable (a JSONL stream reader),
      // not a bare AsyncIterable — matching that shape here (rather than flattening it) is
      // what lets `createAnthropicClient` hand back the real client with no adapter code.
      results(batchId: string): Promise<AsyncIterable<BatchResultEntry>>;
    };
  };
}

/**
 * The one call site in the repo that constructs the real Anthropic SDK client. Returns the
 * minimal `LlmClient` shape above rather than the SDK's own richer type, so every other
 * function in this module (and every caller) depends only on the structural interface —
 * that is what keeps `extract`/`synthesize` testable with a plain object standing in for
 * the client (composer resolution #8).
 */
export function createAnthropicClient(apiKey: string): LlmClient {
  return new Anthropic({ apiKey });
}

// ---------------------------------------------------------------------------------------
// Persistence — token accounting for `runs` (SPEC F-05 criterion 3). `runs` carries
// accumulated totals per run (composer resolution #5: "a run row carries the accumulated
// totals for that run, not one row per call"), so persisting usage is an increment against
// the existing row, not an insert. `RunsRepo` is a narrow interface rather than the full
// Drizzle `Db` so tests can inject a plain in-memory fake instead of standing up Postgres —
// `createDrizzleRunsRepo` below is the one real implementation, used outside tests.
// ---------------------------------------------------------------------------------------

export interface RunUsageIncrement {
  model: AllowedModel;
  inputTokens: number;
  outputTokens: number;
  /** Full-precision cost for this call; rounded only inside `recordUsage` at persistence. */
  costUsd: number;
}

export interface RunsRepo {
  /** `SUM(cost_usd)` over `runs` rows whose `started_at` falls within the trailing window
   *  ending at `now` (composer resolution #6). Returns 0 when no rows fall in the window. */
  getTrailingSpendUsd(windowDays: number, now: Date): Promise<number>;
  /** Adds `increment`'s tokens and cost to run `runId`'s running totals and persists them. */
  recordUsage(runId: string, increment: RunUsageIncrement): Promise<void>;
}

export function createDrizzleRunsRepo(db: Db): RunsRepo {
  return {
    async getTrailingSpendUsd(windowDays, now) {
      const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const [row] = await db
        .select({ total: sql<string | null>`sum(${runs.costUsd})` })
        .from(runs)
        .where(gt(runs.startedAt, cutoff));
      const total = row?.total;
      return total === null || total === undefined ? 0 : Number(total);
    },
    async recordUsage(runId, increment) {
      // Round exactly once, here, at the point of persistence (composer resolution #4) —
      // `costUsd` is numeric(10,4); a single cheap Haiku call can otherwise round to
      // 0.0000 if rounded per call upstream and only summed afterward.
      const roundedCostUsd = Math.round(increment.costUsd * 10_000) / 10_000;
      await db
        .update(runs)
        .set({
          model: increment.model,
          inputTokens: sql`coalesce(${runs.inputTokens}, 0) + ${increment.inputTokens}`,
          outputTokens: sql`coalesce(${runs.outputTokens}, 0) + ${increment.outputTokens}`,
          costUsd: sql`coalesce(${runs.costUsd}, 0) + ${roundedCostUsd}`,
        })
        .where(eq(runs.id, runId));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Shared dispatch helpers
// ---------------------------------------------------------------------------------------

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface BudgetDeps {
  client: LlmClient;
  runsRepo: RunsRepo;
  config: Config;
  now?: () => Date;
}

/**
 * Runs the budget guard *before* dispatch (SPEC F-05 criterion 4 — "before dispatching a
 * call that would push..."). Estimates the pending call's cost conservatively: input from
 * the SDK's token-counting endpoint, output bounded by the request's own `max_tokens`
 * (composer resolution #6) — the true output is almost always less than `max_tokens`, so
 * this over-estimates rather than under-estimates, which is the safe direction to be wrong
 * in for a budget guard.
 */
async function guardBudget(
  deps: BudgetDeps,
  model: AllowedModel,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): Promise<void> {
  const pendingEstimateUsd = computeCostUsd(model, {
    input_tokens: estimatedInputTokens,
    output_tokens: maxOutputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  const now = (deps.now ?? (() => new Date()))();
  const trailingSpendUsd = await deps.runsRepo.getTrailingSpendUsd(30, now);
  assertBudget({
    trailingSpendUsd,
    pendingEstimateUsd,
    ceilingUsd: deps.config.budgetCeilingUsd,
  });
}

// ---------------------------------------------------------------------------------------
// extract() — Haiku 4.5, batch API, always (CLAUDE.md). Takes already-prepared requests;
// does not build prompts, run the prefilter, or decide what to submit (composer resolution
// #10 — those are X-03/X-02/X-04's jobs, not this one's).
// ---------------------------------------------------------------------------------------

const EXTRACT_MODEL: AllowedModel = 'claude-haiku-4-5';

export interface ExtractRequest {
  customId: string;
  maxTokens: number;
  system?: string;
  messages: MessageParamLike[];
}

export interface ExtractParams {
  runId: string;
  requests: ExtractRequest[];
}

export interface ExtractDeps {
  client: LlmClient;
  runsRepo: RunsRepo;
  config: Config;
  /** Injectable clock, defaults to `() => new Date()`. Tests pin this for determinism. */
  now?: () => Date;
  /** Injectable delay between poll attempts, defaults to 5000ms. */
  pollIntervalMs?: number;
  /** Injectable sleep implementation so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ExtractResultEntry {
  customId: string;
  status: 'succeeded' | 'errored' | 'canceled' | 'expired';
  content?: ContentBlockLike[];
  usage?: UsageLike;
  error?: { type: string; message: string };
}

async function pollBatchUntilEnded(
  client: LlmClient,
  batchId: string,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (;;) {
    const status = await client.messages.batches.retrieve(batchId);
    if (status.processing_status === 'ended') {
      return;
    }
    log.debug('batch poll', { batchId, processingStatus: status.processing_status });
    await sleep(pollIntervalMs);
  }
}

export async function extract(params: ExtractParams, deps: ExtractDeps): Promise<ExtractResultEntry[]> {
  assertAllowedModel(EXTRACT_MODEL);

  if (params.requests.length === 0) {
    return [];
  }

  const batchRequests: BatchRequestParam[] = params.requests.map((request) => ({
    custom_id: request.customId,
    params: {
      model: EXTRACT_MODEL,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
      // Haiku 4.5 is an older-generation model: `output_config.effort` errors on it, and
      // for extraction we want neither effort nor thinking — omit both (llm-facts.md).
    },
  }));

  // Budget guard runs before dispatch (composer resolution #6) — estimate every request's
  // input via the token-counting endpoint and sum, bound total output by the sum of each
  // request's own `max_tokens`.
  const countResults = await Promise.all(
    batchRequests.map((r) =>
      deps.client.messages.countTokens({ model: r.params.model, system: r.params.system, messages: r.params.messages }),
    ),
  );
  const estimatedInputTokens = countResults.reduce((sum, r) => sum + r.input_tokens, 0);
  const maxOutputTokens = params.requests.reduce((sum, r) => sum + r.maxTokens, 0);
  await guardBudget(deps, EXTRACT_MODEL, estimatedInputTokens, maxOutputTokens);

  const batch = await deps.client.messages.batches.create({ requests: batchRequests });
  await pollBatchUntilEnded(deps.client, batch.id, deps.pollIntervalMs ?? 5000, deps.sleep ?? defaultSleep);

  // Batch results arrive in arbitrary order — key by custom_id, never by position (composer
  // resolution #9). Buffering into a Map first is what makes the correlation below immune
  // to whatever order `results()` streams them in.
  const resultsByCustomId = new Map<string, BatchResultEntry>();
  for await (const entry of await deps.client.messages.batches.results(batch.id)) {
    resultsByCustomId.set(entry.custom_id, entry);
  }

  let totalInputTokensSum = 0;
  let totalOutputTokensSum = 0;
  let totalCostUsd = 0;
  const output: ExtractResultEntry[] = [];

  for (const request of params.requests) {
    const entry = resultsByCustomId.get(request.customId);
    if (entry === undefined) {
      output.push({
        customId: request.customId,
        status: 'expired',
        error: { type: 'missing_result', message: 'Batch ended with no result for this custom_id' },
      });
      continue;
    }

    const { result } = entry;
    if (result.type === 'succeeded') {
      const { usage } = result.message;
      totalInputTokensSum += totalInputTokens(usage);
      totalOutputTokensSum += usage.output_tokens;
      totalCostUsd += computeCostUsd(EXTRACT_MODEL, usage);
      output.push({ customId: request.customId, status: 'succeeded', content: result.message.content, usage });
    } else if (result.type === 'errored') {
      // Unwrap the SDK's standard error envelope down to {type, message} — the shape
      // `ExtractResultEntry.error` promises callers, per llm-facts.md's description of
      // `result.error.type` (`"invalid_request"` means fix-and-retry; anything else is a
      // server error safe to retry as-is).
      output.push({ customId: request.customId, status: 'errored', error: result.error.error });
    } else {
      output.push({ customId: request.customId, status: result.type });
    }
  }

  if (totalInputTokensSum > 0 || totalOutputTokensSum > 0) {
    await deps.runsRepo.recordUsage(params.runId, {
      model: EXTRACT_MODEL,
      inputTokens: totalInputTokensSum,
      outputTokens: totalOutputTokensSum,
      costUsd: totalCostUsd,
    });
  }

  return output;
}

// ---------------------------------------------------------------------------------------
// synthesize() — Sonnet 5, standard (non-batch) API, only on clusters clearing the score
// threshold (CLAUDE.md) — the threshold check itself is the caller's job (C-05/S-02), not
// this function's.
// ---------------------------------------------------------------------------------------

const SYNTHESIZE_MODEL: AllowedModel = 'claude-sonnet-5';

export interface SynthesizeParams {
  runId: string;
  maxTokens: number;
  system?: string;
  messages: MessageParamLike[];
  /** Defaults to omitted (API default `"high"`) when not set. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface SynthesizeDeps {
  client: LlmClient;
  runsRepo: RunsRepo;
  config: Config;
  now?: () => Date;
}

export interface SynthesizeResult {
  content: ContentBlockLike[];
  usage: UsageLike;
  stopReason: string | null;
}

export async function synthesize(params: SynthesizeParams, deps: SynthesizeDeps): Promise<SynthesizeResult> {
  assertAllowedModel(SYNTHESIZE_MODEL);

  const createParams: CreateMessageParams = {
    model: SYNTHESIZE_MODEL,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
    // Sonnet 5 runs adaptive thinking by default when `thinking` is omitted, and
    // `max_tokens` caps thinking *plus* response text together — omitting it is both a
    // silent cost increase and a truncation risk, so set it explicitly (composer resolution
    // #11). Sonnet 5 rejects non-default temperature/top_p/top_k with a 400 — never set them.
    thinking: { type: 'adaptive' },
    output_config: params.effort === undefined ? undefined : { effort: params.effort },
  };

  // Budget guard runs before dispatch (composer resolution #6).
  const countResult = await deps.client.messages.countTokens({
    model: SYNTHESIZE_MODEL,
    system: params.system,
    messages: params.messages,
  });
  await guardBudget(deps, SYNTHESIZE_MODEL, countResult.input_tokens, params.maxTokens);

  const message = await deps.client.messages.create(createParams);

  const { usage } = message;
  const costUsd = computeCostUsd(SYNTHESIZE_MODEL, usage);
  await deps.runsRepo.recordUsage(params.runId, {
    model: SYNTHESIZE_MODEL,
    inputTokens: totalInputTokens(usage),
    outputTokens: usage.output_tokens,
    costUsd,
  });

  return { content: message.content, usage, stopReason: message.stop_reason };
}
