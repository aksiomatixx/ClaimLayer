'use strict';

const winston = require('winston');

const logger = winston.createLogger({
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

module.exports = logger;
