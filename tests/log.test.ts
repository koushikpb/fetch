import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/run-context.js';

// process.stdout.write is the logger's only output path, so capturing it (rather than
// parsing captured console output) is what lets these tests assert on the exact bytes
// written, including the single trailing newline the "single-line" criterion depends on.
function captureStdoutWrites(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { lines: () => chunks, restore: () => spy.mockRestore() };
}

describe('structured logger', () => {
  let capture: ReturnType<typeof captureStdoutWrites>;

  beforeEach(() => {
    capture = captureStdoutWrites();
  });

  afterEach(() => {
    capture.restore();
  });

  it('writes exactly one chunk per call, terminated by a single trailing newline', () => {
    log.info('hello');
    const writes = capture.lines();
    expect(writes).toHaveLength(1);
    const [line] = writes;
    expect(line).toBeDefined();
    expect(line?.indexOf('\n')).toBe((line?.length ?? 0) - 1);
  });

  it('is valid JSON containing ts, level, and msg at minimum', () => {
    log.info('hello world');
    const record = JSON.parse(capture.lines()[0] ?? '') as Record<string, unknown>;
    expect(record.msg).toBe('hello world');
    expect(record.level).toBe('info');
    expect(record.ts).toEqual(expect.any(String));
  });

  it('ts is ISO 8601 UTC (ends in Z)', () => {
    log.info('hello');
    const record = JSON.parse(capture.lines()[0] ?? '') as { ts: string };
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() => new Date(record.ts).toISOString()).not.toThrow();
    expect(new Date(record.ts).toISOString()).toBe(record.ts);
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('records level "%s" correctly', (level) => {
    log[level]('msg');
    const record = JSON.parse(capture.lines()[0] ?? '') as { level: string };
    expect(record.level).toBe(level);
  });

  it('omits run_id when called outside a run', () => {
    log.info('no run here');
    const record = JSON.parse(capture.lines()[0] ?? '') as Record<string, unknown>;
    expect('run_id' in record).toBe(false);
  });

  it('includes run_id when called inside withRun', () => {
    withRun('run-123', () => {
      log.info('inside a run');
    });
    const record = JSON.parse(capture.lines()[0] ?? '') as Record<string, unknown>;
    expect(record.run_id).toBe('run-123');
  });

  it('threads run_id through awaited async work started inside the run', async () => {
    await withRun('run-async', async () => {
      await Promise.resolve();
      log.info('after an await');
    });
    const record = JSON.parse(capture.lines()[0] ?? '') as Record<string, unknown>;
    expect(record.run_id).toBe('run-async');
  });

  it('a caller-supplied field cannot shadow the real run_id', () => {
    withRun('real-run-id', () => {
      log.info('trying to spoof run_id', { run_id: 'spoofed' });
    });
    const record = JSON.parse(capture.lines()[0] ?? '') as Record<string, unknown>;
    expect(record.run_id).toBe('real-run-id');
  });

  it('stays single-line when msg contains an embedded newline', () => {
    log.info('line one\nline two');
    const writes = capture.lines();
    expect(writes).toHaveLength(1);
    const [line] = writes;
    expect(line?.indexOf('\n')).toBe((line?.length ?? 0) - 1);
    const record = JSON.parse(line ?? '') as { msg: string };
    expect(record.msg).toBe('line one\nline two');
  });

  it('stays single-line when a context field contains an embedded newline', () => {
    log.info('multi-field', { detail: 'first\nsecond' });
    const [line] = capture.lines();
    expect(line?.indexOf('\n')).toBe((line?.length ?? 0) - 1);
    const record = JSON.parse(line ?? '') as { detail: string };
    expect(record.detail).toBe('first\nsecond');
  });

  it('serializes an AppError logged at error level with name, code, and context', () => {
    const err = new ConfigError('missing FOO', { context: { key: 'FOO' } });
    log.error('config load failed', { err });
    const record = JSON.parse(capture.lines()[0] ?? '') as {
      err: { name: string; code: string; context: unknown; message: string };
    };
    expect(record.err.name).toBe('ConfigError');
    expect(record.err.code).toBe('CONFIG_ERROR');
    expect(record.err.context).toEqual({ key: 'FOO' });
    expect(record.err.message).toBe('missing FOO');
  });

  it('arbitrary structured fields are merged into the record', () => {
    log.info('ingest finished', { count: 12, source: 'hackernews' });
    const record = JSON.parse(capture.lines()[0] ?? '') as Record<string, unknown>;
    expect(record.count).toBe(12);
    expect(record.source).toBe('hackernews');
  });
});
