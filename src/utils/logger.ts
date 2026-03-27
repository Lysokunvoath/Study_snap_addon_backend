type LogMeta = Record<string, unknown>;

function write(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: LogMeta): void {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };

  console.log(JSON.stringify(payload));
}

export const logger = {
  info: (message: string, meta?: LogMeta) => write('INFO', message, meta),
  warn: (message: string, meta?: LogMeta) => write('WARN', message, meta),
  error: (message: string, meta?: LogMeta) => write('ERROR', message, meta),
};
