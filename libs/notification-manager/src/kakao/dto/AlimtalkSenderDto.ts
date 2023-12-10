import { AlimtalkRecipient } from '@app/notification-manager/kakao/dto/AlimtalkRecipient';

export class AlimtalkSenderDto {
  static ALIMTALK_MAX_RECIPIENTS = 1000;

  private readonly _templateCode: string;
  private readonly _recipients: AlimtalkRecipient[];

  private constructor(templateCode: string, recipients: AlimtalkRecipient[]) {
    this._templateCode = templateCode;
    this._recipients = recipients;
  }

  static of(templateCode: string, recipients: AlimtalkRecipient[]) {
    return new AlimtalkSenderDto(templateCode, recipients);
  }

  private chunkArray<T>(
    array: T[],
    size = AlimtalkSenderDto.ALIMTALK_MAX_RECIPIENTS,
  ): T[][] {
    if (array.length <= size) {
      return [array];
    }

    return [array.slice(0, size), ...this.chunkArray(array.slice(size), size)];
  }

  get toRequestBody() {
    if (this._recipients.length === 0) {
      return [];
    }

    return this.chunkArray(this._recipients).map((recipients) => ({
      templateCode: this._templateCode,
      recipientList: recipients.map((recipient) => recipient.toRequestBody),
    }));
  }
}
