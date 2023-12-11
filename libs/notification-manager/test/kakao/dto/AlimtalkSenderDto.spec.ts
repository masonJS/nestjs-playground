import { AlimtalkSenderDto } from '@app/notification-manager/kakao/dto/AlimtalkSenderDto';
import { AlimtalkRecipient } from '@app/notification-manager/kakao/dto/AlimtalkRecipient';

describe('AlimtalkSenderDto', () => {
  it('수신자가 0명이면 빈배열을 반환한다.', () => {
    // given
    const dto = AlimtalkSenderDto.of('code', []);

    // when
    const result = dto.toRequestBodies;

    // then
    expect(result).toBeEmpty();
  });

  it('수신자가 1000명이면 한개의 배열을 반환한다.', () => {
    // given
    const dto = AlimtalkSenderDto.of(
      'code',
      Array.from(
        { length: 1000 },
        () => new AlimtalkRecipient('phoneNumber', {}),
      ),
    );

    // when
    const result = dto.toRequestBodies;

    // then
    expect(result).toHaveLength(1);
    expect(result[0].recipientList).toHaveLength(1000);
  });

  it('수신자가 1999명이면 한개의 배열을 반환한다.', () => {
    // given
    const dto = AlimtalkSenderDto.of(
      'code',
      Array.from(
        { length: 1999 },
        () => new AlimtalkRecipient('phoneNumber', {}),
      ),
    );

    // when
    const result = dto.toRequestBodies;

    // then
    expect(result).toHaveLength(2);
    expect(result[0].recipientList).toHaveLength(1000);
    expect(result[1].recipientList).toHaveLength(999);
  });
});
