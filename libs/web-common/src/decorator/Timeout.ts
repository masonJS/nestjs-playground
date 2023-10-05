import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { TimeoutInterceptor } from '../interceptor/TimeoutInterceptor';

const setTimeout = (timeout: number) => SetMetadata('request-timeout', timeout);

export function Timeout(timeout: number) {
  return applyDecorators(
    setTimeout(timeout),
    UseInterceptors(TimeoutInterceptor),
  );
}
