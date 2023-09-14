import { SendEmailCommandInput } from '@aws-sdk/client-ses';

export class SendEmailDto {
  private readonly _from: string;
  private readonly _to: string;
  private readonly _subject: string;
  private readonly _content: string;
  private readonly _cc: string[];

  constructor(
    from: string,
    to: string,
    subject: string,
    content: string,
    cc?: string[],
  ) {
    this._from = from;
    this._to = to;
    this._subject = subject;
    this._content = content;
    this._cc = cc || [];
  }

  get commandInput(): SendEmailCommandInput {
    return {
      Source: this._from,
      Destination: {
        ToAddresses: [this._to],
        CcAddresses: this._cc,
      },
      Message: {
        Subject: {
          Data: this._subject,
          Charset: 'UTF-8',
        },
        Body: {
          Html: {
            Data: this._content,
            Charset: 'UTF-8',
          },
        },
      },
    };
  }
}
