// Structured logs: one JSON object per line on stdout, so a container runtime or a log shipper can
// index them without parsing prose.

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

const stdoutSink: LogSink = line => {
  process.stdout.write(line + "\n");
};

/** An Error becomes its name and message; a stack is logged only at debug level. */
function serialise(value: unknown, withStack: boolean): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(withStack && value.stack ? { stack: value.stack } : {}) };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function createLogger(level: LogLevel = "info", base: LogFields = {}, sink: LogSink = stdoutSink): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    const record: LogFields = { ts: new Date().toISOString(), level: lvl, msg, ...base };
    for (const [k, v] of Object.entries(fields ?? {})) record[k] = serialise(v, level === "debug");
    sink(JSON.stringify(record));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: fields => createLogger(level, { ...base, ...fields }, sink),
  };
}

/** Discards everything; for tests. */
export const silentLogger: Logger = createLogger("error", {}, () => {});
