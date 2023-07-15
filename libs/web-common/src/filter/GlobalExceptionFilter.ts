import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Logger } from '@app/logger/Logger';
import { isDefined } from '../util/isDefined';
import { ResponseEntity } from '../res/ResponseEntity';
import { instanceToPlain } from 'class-transformer';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): any {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    this.logger.error(this.getErrorLogMessage(request), exception as Error);

    response.status(500).json(instanceToPlain(ResponseEntity.ERROR()));
  }

  private getErrorLogMessage(request: Request): string {
    return [
      `GlobalException: path = ${request.url}`,
      Object.keys(request.body).length > 0
        ? `body = ${JSON.stringify(request.body)}`
        : null,
      Object.keys(request.query).length > 0
        ? `query = ${JSON.stringify(request.query)}`
        : null,
    ]
      .filter(isDefined)
      .join(' ');
  }
}
