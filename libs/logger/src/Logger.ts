export abstract class Logger {
  abstract error(message: string, error?: Error): void;

  abstract warn(message: string, error?: Error): void;

  abstract info(message: string, error?: Error): void;

  abstract debug(message: string, error?: Error): void;
}
