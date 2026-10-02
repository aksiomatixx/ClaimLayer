let logger;

try {
  const winston = require('winston');
  logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        format: process.env.NODE_ENV === 'development'
          ? winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ timestamp, level, msg, ...rest }) => {
                const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
                return `${timestamp} ${level}: ${msg}${extra}`;
              })
            )
          : winston.format.json(),
      }),
    ],
  });
} catch {
  const formatMsg = (level, obj) => {
    const payload = typeof obj === 'string' ? { msg: obj } : { ...obj };
    return JSON.stringify({ timestamp: new Date().toISOString(), level, ...payload });
  };
  logger = {
    info: (obj) => console.log(formatMsg('info', obj)),
    warn: (obj) => console.warn(formatMsg('warn', obj)),
    error: (obj) => console.error(formatMsg('error', obj)),
    debug: (obj) => console.debug(formatMsg('debug', obj)),
  };
}

module.exports = logger;
