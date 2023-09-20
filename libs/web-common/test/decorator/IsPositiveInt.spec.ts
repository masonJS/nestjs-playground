import 'reflect-metadata';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import { IsPositiveInt } from '../../src/decorator/IsPositiveInt';

describe('IsPositiveInt', () => {
  it('양의 정수(1 ~ Number.MAX_SAFE_INTEGER) 타입인지 유효성 체크를 한다.', async () => {
    // given
    class Test {
      @IsPositiveInt()
      value: number;
    }

    const dto = plainToClass(Test, { value: '1' });

    // when
    const errors = await validate(dto);

    // then
    const validationErrors = errors.filter((e) => e.property === 'value');
    expect(validationErrors).toHaveLength(1);
  });

  it('정수형 타입이어야 한다.', async () => {
    // given
    class Test {
      @IsPositiveInt()
      value: number;
    }

    const dto = plainToClass(Test, { value: '1' });

    // when
    const errors = await validate(dto);

    // then
    const validationErrors = errors.filter((e) => e.property === 'value');
    expect(validationErrors).toHaveLength(1);
  });

  it('소수점 타입이 아니여야 한다.', async () => {
    // given
    class Test {
      @IsPositiveInt()
      value: number;
    }

    const dto = plainToClass(Test, { value: 1.5 });

    // when
    const errors = await validate(dto);

    // then
    const validationErrors = errors.filter((e) => e.property === 'value');
    expect(validationErrors).toHaveLength(1);
  });

  it('최소값은 1인 양의 정수이어야한다.', async () => {
    // given
    class Test {
      @IsPositiveInt()
      value: number;
    }

    const dto = plainToClass(Test, { value: 0 });

    // when
    const errors = await validate(dto);

    // then
    const validationErrors = errors.filter((e) => e.property === 'value');
    expect(validationErrors).toHaveLength(1);
  });

  it('최대값이 Number.MAX_SAFE_INTEGER 이어야한다.', async () => {
    // given
    class Test {
      @IsPositiveInt()
      value: number;
    }

    const dto = plainToClass(Test, { value: Number.MAX_SAFE_INTEGER + 1 });

    // when
    const errors = await validate(dto);

    // then
    const validationErrors = errors.filter((e) => e.property === 'value');
    expect(validationErrors).toHaveLength(1);
  });
});
