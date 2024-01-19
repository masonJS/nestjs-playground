import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Logger } from '@app/logger/Logger';
import { Request, Response } from 'express';
import { instanceToPlain } from 'class-transformer';
import { DomainException } from '../res/exception/DomainException';
import { isDefined } from '../util/isDefined';
import { ResponseEntity } from '../res/ResponseEntity';
import { ResponseStatus } from '../res/ResponseStatus';

@Catch(DomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: DomainException, host: ArgumentsHost): any {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getRequest<Response>();

    this.logger.info(this.getErrorLogMessage(request, exception), exception);

    response
      .status(exception.statusCode)
      .json(
        instanceToPlain(
          ResponseEntity.ERROR_WITH(
            exception.responseMessage,
            HttpStatus[exception.statusCode] as ResponseStatus,
          ),
        ),
      );
  }

  private getErrorLogMessage(request: Request, exception: DomainException) {
    return [
      `DomainException: message = ${exception.message} path=${request.url}`,
      exception.parameter
        ? `parameter = ${JSON.stringify(exception.parameter)}`
        : null,
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
