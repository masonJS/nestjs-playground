import { ResponseDto } from '../../../src/decorator/ResponseDto';
import { Expose, instanceToPlain } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { DECORATORS } from '@nestjs/swagger/dist/constants';

describe('ResponseDto decorator', () => {
  it('get 메소드에 @Expose 데코레이터를 선언다.', () => {
    // given
    @ResponseDto()
    class Sample {
      private readonly _field: string;

      constructor(field: string) {
        this._field = field;
      }

      get getField() {
        return this._field;
      }
    }

    const sample = new Sample('test');

    // when
    const result = instanceToPlain(sample);

    // then
    expect(result).toStrictEqual({ getField: 'test' });
  });

  it('expose 데코레이터를 가진 get메소드는 우선시 한다.', () => {
    // given
    @ResponseDto()
    class Sample {
      _field: string;

      constructor(field: string) {
        this._field = field;
      }

      @Expose({ name: 'exchangeField' })
      get getField() {
        return this._field;
      }
    }

    const sample = new Sample('test');

    // when
    const result = instanceToPlain(sample);

    // then
    expect(result).toStrictEqual({ exchangeField: 'test' });
  });

  it('get 메소드에 @ApiProperty 데코레이터를 선언한다.', () => {
    // given
    @ResponseDto()
    class Sample {
      _field: string;

      constructor(field: string) {
        this._field = field;
      }

      get getField() {
        return this._field;
      }
    }

    // when
    const result = Reflect.hasMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      Sample.prototype,
      'getField',
    );

    // then
    expect(result).toBe(true);
  });

  it('@ApiProperty 데코레이터를 가진 get 메소드는 우선시 한다.', () => {
    // given
    @ResponseDto()
    class Sample {
      _field: string;

      constructor(field: string) {
        this._field = field;
      }

      @ApiProperty({ deprecated: true })
      get getField() {
        return this._field;
      }
    }

    // when
    const result = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      Sample.prototype,
      'getField',
    );

    // then
    expect(result.deprecated).toBe(true);
  });
});
