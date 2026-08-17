export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: LogValue;
}

export function formatLogRecord(level: LogLevel, event: string, fields: Record<string, LogValue> = {}, now = new Date()): string {
  const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return JSON.stringify({ timestamp: now.toISOString(), level, event, ...cleanFields } satisfies LogRecord);
}

export function log(level: LogLevel, event: string, fields: Record<string, LogValue> = {}): void {
  const line = `${formatLogRecord(level, event, fields)}\n`;
  if (level === 'error') process.stderr.write(line); else process.stdout.write(line);
}

export function errorFields(error: unknown): Record<string, LogValue> {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorMessage: typeof error === 'string' ? error : 'Unknown error' };
}
