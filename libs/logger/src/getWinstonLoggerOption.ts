import { format, transports } from 'winston';

export function getWinstonLoggerOption(nodeEnv = process.env.NODE_ENV) {
  const isLocalEnv = nodeEnv === 'local';
  const level = isLocalEnv ? 'debug' : 'info';

  return {
    silent: nodeEnv === 'test',
    transports: [
      new transports.Console({
        level,
        format: isLocalEnv ? getLocalFormat() : getProductionFormat(),
      }),
    ],
  };
}

function getLocalFormat() {
  return format.combine(
    format.printf(({ message, stack }) =>
      [message, stack].filter(Boolean).join('\n'),
    ),
  );
}

function getProductionFormat() {
  return format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    format.ms(),
    format.json(),
    format.printf((info) =>
      JSON.stringify({
        ...info,
      }),
    ),
  );
}
