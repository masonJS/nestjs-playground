import { SendEmailCommandOutput } from '@aws-sdk/client-ses';
import { HttpStatus } from '@nestjs/common';

export class SESResponse {
  private readonly _statusCode: number;
  private readonly _messageId: string;
  private readonly _requestId: string;

  constructor(response: SendEmailCommandOutput) {
    this._statusCode = response.$metadata?.httpStatusCode || 0;
    this._messageId = response.MessageId || '';
    this._requestId = response.$metadata?.requestId || '';
  }

  get message(): string {
    return JSON.stringify({
      statusCode: this._statusCode,
      messageId: this._messageId,
      requestId: this._requestId,
    });
  }

  isNotOK(): boolean {
    return this._statusCode !== HttpStatus.OK;
  }
}
