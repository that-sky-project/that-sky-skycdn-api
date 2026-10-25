const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', scope = 'cdnapi') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (name, args) => {
    if (LEVELS[name] < threshold) return;
    const payload = {
      ts: new Date().toISOString(),
      level: name,
      scope,
      message: args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
    };
    const line = JSON.stringify(payload);
    if (name === 'error' || name === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

module.exports = { createLogger };
