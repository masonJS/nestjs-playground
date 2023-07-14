import { ResponseStatus } from './ResponseStatus';
import { ResponseDto } from './ResponseDto';

@ResponseDto()
export class ResponseEntity<T> {
  private readonly _statusCode: string;
  private readonly _message: string;
  private readonly _data: T;

  constructor(status: ResponseStatus, message: string, data: T) {
    this._statusCode = ResponseStatus[status];
    this._message = message;
    this._data = data;
  }

  get statusCode(): string {
    return this._statusCode;
  }

  get message(): string {
    return this._message;
  }

  get data(): T {
    return this._data;
  }

  static OK(): ResponseEntity<string> {
    return new ResponseEntity<string>(ResponseStatus.OK, '', '');
  }

  static OK_WITH<T>(data: T): ResponseEntity<T> {
    return new ResponseEntity<T>(ResponseStatus.OK, '', data);
  }

  static ERROR(): ResponseEntity<string> {
    return new ResponseEntity<string>(
      ResponseStatus.SERVER_ERROR,
      '서버 에러가 발생했습니다.',
      '',
    );
  }

  static ERROR_WITH(
    message: string,
    code: ResponseStatus = ResponseStatus.SERVER_ERROR,
  ): ResponseEntity<string> {
    return new ResponseEntity<string>(code, message, '');
  }
}
