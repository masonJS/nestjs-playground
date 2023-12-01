import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import {
  catchError,
  delay,
  Observable,
  retryWhen,
  take,
  throwError,
} from 'rxjs';

@Injectable()
export class RetryInterceptor implements NestInterceptor {
  private readonly RETRY_COUNT = 2;
  private readonly RETRY_DELAY = 1000;

  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((error) => throwError(() => error)),
      retryWhen((errors) =>
        errors.pipe(delay(this.RETRY_DELAY), take(this.RETRY_COUNT)),
      ),
    );
  }
}
