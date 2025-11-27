import { format, createLogger, transports } from 'winston';
import { DateTime } from 'luxon';
const { timestamp, combine, printf, colorize } = format;
const SERVICE_NAME = process.env.SERVICE_NAME || 'assistant-api';

function buildDevLogger(logLevel?: string) {
    const localLogFormat = printf(({ level, message, timestamp, stack }: any) => {
        return `${timestamp} ${level} ${stack || message}`;
    })

    return createLogger({
        level: logLevel,
        format: combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), format.errors({ stack: true }), localLogFormat),
        defaultMeta: SERVICE_NAME,
        transports: [new transports.Console()]
    });
}


function buildProdLogger(logLevel?: string) {
    return createLogger({
        level: logLevel,
        format: combine(timestamp(), format.errors({ stack: true }), format.json()),
        defaultMeta: { service: SERVICE_NAME },
        transports: [
            new transports.Console(),
            new transports.File({ filename: `logs/log_${DateTime.now().toFormat('dd_MMM_yyyy')}.log` })
        ]
    });
}
function logger() {
    if (process.env.NODE_ENV === 'development') {
        return buildDevLogger(process.env.LOG_LEVEL);
    }else{
        return buildProdLogger(process.env.LOG_LEVEL);
    }
}

export default logger();
