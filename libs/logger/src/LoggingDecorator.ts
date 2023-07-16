import { SetMetadata } from '@nestjs/common';

export const LOGGING_DECORATOR = Symbol('LOGGING_DECORATOR');

export const LoggingDecorator = SetMetadata(LOGGING_DECORATOR, 'logging');
