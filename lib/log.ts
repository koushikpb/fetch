// Structured JSON logging: one line per call to stdout, always carrying `run_id` when
// called from inside a pipeline run (lib/run-context.ts). This is the only logging path —
// nothing else in the repo should write log-shaped output directly to stdout/stderr.
import { AppError } from './errors.js';
import { getRunId } from './run-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

// The built-in Error's `message` and `stack` are non-enumerable own properties, so a bare
// JSON.stringify(err) silently produces `{}` for them. This makes the fields the "AppError
// logged at error level" criterion requires (name, code, context) — plus message and
// stack, which are useless to drop — explicit instead of relying on default serialization.
function serializeError(err: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  if (err instanceof AppError) {
    serialized.code = err.code;
    serialized.context = err.context;
  }
  if (err.cause !== undefined) {
    serialized.cause = err.cause instanceof Error ? serializeError(err.cause) : err.cause;
  }
  return serialized;
}

function toJSONSafe(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

function write(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    record[key] = toJSONSafe(value);
  }
  // Reserved keys are assigned after spreading `fields` so a field named e.g. `run_id` or
  // `level` can never shadow the real value — the log record's own integrity outranks
  // whatever a caller passes in.
  record.ts = new Date().toISOString();
  record.level = level;
  record.msg = msg;
  const runId = getRunId();
  if (runId !== undefined) {
    record.run_id = runId;
  }
  // JSON.stringify escapes embedded newlines as `\n` (two characters) rather than emitting
  // a literal line break, which is what keeps this single-line regardless of what callers
  // put in `msg` or a field value.
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export const log = {
  debug: (msg: string, fields?: LogFields): void => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields): void => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields): void => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields): void => write('error', msg, fields),
};
