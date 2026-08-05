// The error taxonomy every thrown error in the repo must belong to (CLAUDE.md: "Throw
// typed errors from lib/errors.ts. Never swallow."). eslint.config.js mechanically bans
// throwing a built-in error constructor and declaring a class that `extends Error`
// directly anywhere outside this file, so AppError and its subclasses are the only route
// to a throwable error object elsewhere in the repo.
//
// Composer resolution (task-F-06-brief.md #2): exactly the five subclasses below exist.
// Later tasks add their own as they need them — do not pre-create speculative ones here.
// The base class is named AppError, not FetchError, per resolution #1: CLAUDE.md forbids
// the project name as a code identifier.

export interface AppErrorOptions {
  /** Structured data useful for debugging/logging. Never put secrets in here. */
  context?: Record<string, unknown>;
  /** The error this one was raised in response to; preserved via the native `Error.cause`. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    // Assigning `name` from the concrete constructor (rather than leaving the inherited
    // "Error") is what makes `err.name` and JSON serialization identify the subclass.
    this.name = new.target.name;
    this.code = code;
    this.context = options.context;
    // Native `class X extends Error` already keeps `instanceof` correct under this
    // project's ES2023 target; restoring the prototype explicitly guards against that
    // silently breaking if the compile target is ever lowered.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('CONFIG_ERROR', message, options);
  }
}

export class NetworkError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('NETWORK_ERROR', message, options);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('TIMEOUT_ERROR', message, options);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('RATE_LIMIT_ERROR', message, options);
  }
}

// Name mandated by the F-05 spec text (composer resolution #2) — lib/budget.ts's guard
// throws this exact class when projected spend would exceed the configured ceiling.
export class BudgetExceededError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('BUDGET_EXCEEDED', message, options);
  }
}
