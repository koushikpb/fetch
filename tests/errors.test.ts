import { describe, expect, it } from 'vitest';
import {
  AppError,
  BudgetExceededError,
  ConfigError,
  NetworkError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
} from '../lib/errors.js';

const SUBCLASSES = [
  { Ctor: ConfigError, name: 'ConfigError', code: 'CONFIG_ERROR' },
  { Ctor: NetworkError, name: 'NetworkError', code: 'NETWORK_ERROR' },
  { Ctor: TimeoutError, name: 'TimeoutError', code: 'TIMEOUT_ERROR' },
  { Ctor: RateLimitError, name: 'RateLimitError', code: 'RATE_LIMIT_ERROR' },
  { Ctor: UpstreamError, name: 'UpstreamError', code: 'UPSTREAM_ERROR' },
  { Ctor: BudgetExceededError, name: 'BudgetExceededError', code: 'BUDGET_EXCEEDED' },
] as const;

describe('AppError', () => {
  it('carries a machine-readable code, a message, and optional context', () => {
    const err = new AppError('CUSTOM', 'something broke', { context: { id: 42 } });
    expect(err.code).toBe('CUSTOM');
    expect(err.message).toBe('something broke');
    expect(err.context).toEqual({ id: 42 });
    expect(err.name).toBe('AppError');
  });

  it('leaves context undefined when none is provided', () => {
    const err = new AppError('CUSTOM', 'no context here');
    expect(err.context).toBeUndefined();
  });

  it('is an instance of the built-in Error', () => {
    const err = new AppError('CUSTOM', 'boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports the standard `cause` option, so catching and rethrowing as a typed error never swallows the original', () => {
    const original = new Error('low-level failure');
    let wrapped: unknown;
    try {
      try {
        throw original;
      } catch (caught) {
        throw new ConfigError('failed to load config', { cause: caught });
      }
    } catch (err) {
      wrapped = err;
    }
    expect(wrapped).toBeInstanceOf(ConfigError);
    expect((wrapped as Error).cause).toBe(original);
  });
});

describe.each(SUBCLASSES)('$name', ({ Ctor, name, code }) => {
  it('is an instance of itself, AppError, and Error, with the expected name and code', () => {
    const err = new Ctor('boom');
    expect(err).toBeInstanceOf(Ctor);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(name);
    expect(err.code).toBe(code);
    expect(err.message).toBe('boom');
  });

  it('keeps instanceof intact across a throw/catch round trip', () => {
    function raise(): never {
      throw new Ctor('boom');
    }
    expect(raise).toThrow(Ctor);
    expect(raise).toThrow(AppError);
  });

  it('accepts structured context', () => {
    const err = new Ctor('boom', { context: { attempt: 3 } });
    expect(err.context).toEqual({ attempt: 3 });
  });
});
