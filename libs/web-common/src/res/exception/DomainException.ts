import { HttpStatus } from '@nestjs/common';

interface DomainExceptionArg {
  message: string;
  responseMessage?: string;
  parameter?: object;
}

export class DomainException extends Error {
  private readonly _statusCode: HttpStatus;
  private readonly _responseMessage?: string;
  private readonly _parameter?: object;

  constructor(status: HttpStatus, arg: DomainExceptionArg) {
    super(arg.message);
    this._statusCode = status;
    this._responseMessage = arg.responseMessage;
    this._parameter = arg.parameter;
  }

  static BadRequest(arg: DomainExceptionArg) {
    return new DomainException(HttpStatus.BAD_REQUEST, arg);
  }

  static Unauthorized(arg: DomainExceptionArg) {
    return new DomainException(HttpStatus.UNAUTHORIZED, arg);
  }

  static NotFound(arg: DomainExceptionArg) {
    return new DomainException(HttpStatus.NOT_FOUND, arg);
  }

  static Conflict(arg: DomainExceptionArg) {
    return new DomainException(HttpStatus.CONFLICT, arg);
  }

  static BusinessError(arg: DomainExceptionArg) {
    return new DomainException(HttpStatus.INTERNAL_SERVER_ERROR, arg);
  }

  static TooManyRequests(arg: DomainExceptionArg) {
    return new DomainException(HttpStatus.TOO_MANY_REQUESTS, arg);
  }

  get statusCode(): HttpStatus {
    return this._statusCode;
  }

  get responseMessage(): string {
    return this._responseMessage ?? this.message;
  }

  get parameter(): object | undefined {
    return this._parameter;
  }
}
