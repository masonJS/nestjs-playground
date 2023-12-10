export class AlimtalkRecipient {
  private readonly _recipientNo: string;
  private readonly _templateParameter: Record<string, unknown>;

  constructor(recipientNo: string, templateParameter: Record<string, unknown>) {
    this._recipientNo = recipientNo;
    this._templateParameter = templateParameter;
  }

  get toRequestBody() {
    return {
      recipientNo: this._recipientNo,
      templateParameter: this._templateParameter,
    };
  }
}
