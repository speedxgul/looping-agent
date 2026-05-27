const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
} as const;

type LogLevel = keyof typeof LEVELS;

export function createLogger(level = 'info') {
  const threshold = LEVELS[level as LogLevel] ?? LEVELS.info;

  function write(messageLevel: LogLevel, message: string, details?: unknown) {
    if ((LEVELS[messageLevel] ?? LEVELS.info) < threshold) {
      return;
    }

    const line = {
      time: new Date().toISOString(),
      level: messageLevel,
      message,
      ...(details === undefined ? {} : { details })
    };

    const output = JSON.stringify(line);
    if (messageLevel === 'error') {
      console.error(output);
    } else {
      console.log(output);
    }
  }

  return {
    debug: (message: string, details?: unknown) => write('debug', message, details),
    info: (message: string, details?: unknown) => write('info', message, details),
    warn: (message: string, details?: unknown) => write('warn', message, details),
    error: (message: string, details?: unknown) => write('error', message, details)
  };
}
