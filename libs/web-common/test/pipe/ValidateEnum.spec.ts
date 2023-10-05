import { ValidateEnum } from '../../src/pipe/ValidateEnum';

describe('ValidateEnum', () => {
  it('유효한 enum이 아닐 경우 에러가 발생한다.', async () => {
    const parameter = 'invalid' as any;

    const result = () =>
      new ValidateEnum(TestEnum).transform(parameter, {
        type: 'param',
        data: 'parameter',
      });

    expect(result).toThrowError(
      `유효하지 않은 값입니다. [param] parameter=${parameter}`,
    );
  });

  it('유효한 enum인경우 통과한다.', async () => {
    const parameter = TestEnum.TEST as any;

    new ValidateEnum(TestEnum).transform(parameter, {
      type: 'param',
      data: 'parameter',
    });
  });
});

enum TestEnum {
  TEST = 'TEST',
}
