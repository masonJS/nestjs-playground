import { applyDecorators } from '@nestjs/common';
import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { OnEvent } from '@nestjs/event-emitter';
import { LoggingDecorator } from '@app/logger/LoggingDecorator';

export const OnEventLogging = (
  event: string | symbol | Array<string | symbol>,
  options?: OnEventOptions | undefined,
) =>
  // applyDecorators()의 가변 인자들은 뒤에서 부터 앞으로 순서대로 적용된다.
  applyDecorators(LoggingDecorator, OnEvent(event, options));
