import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';
import { PageRequest } from '../../src/req/PageRequest';

describe('PageRequest', () => {
  describe('pageNumber', () => {
    it('1 이상 양의 정수값을 반환된다', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageNumber: 1,
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageNumberErrors = validationErrors.filter(
        (error) => error.property === 'pageNumber',
      );

      //then
      expect(pageRequest.pageNumber).toBe(1);
      expect(pageNumberErrors).toHaveLength(0);
    });

    it('0 이하 값을 넣으면, 에러가 발생한다.', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageNumber: 0,
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageNumberErrors = validationErrors.filter(
        (error) => error.property === 'pageNumber',
      );

      //then
      expect(pageRequest.pageNumber).toBe(0);
      expect(pageNumberErrors).toHaveLength(1);
      expect(pageNumberErrors[0].constraints).toStrictEqual({
        min: 'pageNumber must not be less than 1',
      });
    });

    it('"123"에 문자열을 넣으면 123 숫자가 반환된다.', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageNumber: '123',
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageNumberErrors = validationErrors.filter(
        (error) => error.property === 'pageNumber',
      );

      //then
      expect(pageRequest.pageNumber).toBe(123);
      expect(pageNumberErrors).toHaveLength(0);
    });

    it('"1asd12ads"에 문자열을 넣으면  에러가 발생한다..', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageNumber: '1asd12ads',
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageNumberErrors = validationErrors.filter(
        (error) => error.property === 'pageNumber',
      );

      //then
      expect(pageRequest.pageNumber).toBeNaN();
      expect(pageNumberErrors).toHaveLength(1);
      expect(pageNumberErrors[0].constraints).toMatchInlineSnapshot(`
      {
        "isInt": "pageNumber must be an integer number",
        "max": "pageNumber must not be greater than 9007199254740991",
        "min": "pageNumber must not be less than 1",
      }
    `);
    });
  });

  describe('pageSize', () => {
    it('1 이상 양의 정수값을 반환된다', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageSize: 1,
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageSizeErrors = validationErrors.filter(
        (error) => error.property === 'pageSize',
      );

      //then
      expect(pageRequest.pageSize).toBe(1);
      expect(pageSizeErrors).toHaveLength(0);
    });

    it('0 이하 값을 넣으면, 에러가 발생한다.', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageSize: 0,
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageSizeErrors = validationErrors.filter(
        (error) => error.property === 'pageSize',
      );

      //then
      expect(pageSizeErrors[0].constraints).toStrictEqual({
        min: 'pageSize must not be less than 1',
      });
    });

    it('"123"에 문자열을 넣으면 123 숫자가 반환된다.', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageSize: '123',
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageSizeErrors = validationErrors.filter(
        (error) => error.property === 'pageSize',
      );

      //then
      expect(pageRequest.pageSize).toBe(123);
      expect(pageSizeErrors).toHaveLength(0);
    });

    it('"1asd12ads"에 문자열을 넣으면 밸리데이션 에러가 발생한다.', async () => {
      //given
      const pageRequest = plainToClass(TestPageRequest, {
        pageSize: '1asd12ads',
      });

      //when
      const validationErrors = await validate(pageRequest);
      const pageSizeErrors = validationErrors.filter(
        (error) => error.property === 'pageSize',
      );

      //then
      expect(pageRequest.pageSize).toBeNaN();
      expect(pageSizeErrors).toHaveLength(1);
      expect(pageSizeErrors[0].constraints).toMatchInlineSnapshot(`
      {
        "isInt": "pageSize must be an integer number",
        "max": "pageSize must not be greater than 9007199254740991",
        "min": "pageSize must not be less than 1",
      }
    `);
    });
  });
});

class TestPageRequest extends PageRequest {
  constructor() {
    super();
  }
}
