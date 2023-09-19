import { Test } from '@nestjs/testing';
import { TimeoutInterceptor } from '../../src/interceptor/TimeoutInterceptor';
import { delay, of } from 'rxjs';
import { RequestTimeoutException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mock, mockReset } from 'jest-mock-extended';

describe('TimeoutInterceptor', () => {
  let timeoutInterceptor: TimeoutInterceptor;
  const reflector = mock<Reflector>();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TimeoutInterceptor,
        {
          provide: Reflector,
          useValue: reflector,
        },
      ],
    }).compile();

    timeoutInterceptor = module.get<TimeoutInterceptor>(TimeoutInterceptor);
  });

  beforeEach(() => {
    mockReset(reflector);
  });

  it('처리 시간의 이하 시간이 소요될시 정상 처리 되어진다.', (done: any) => {
    reflector.getAllAndOverride.mockReturnValue(500);

    callHandler.handle.mockReturnValue(of([]).pipe(delay(500)));

    timeoutInterceptor.intercept(executionContext, callHandler).subscribe({
      next(value) {
        expect(value).toStrictEqual([]);
      },
      complete() {
        done();
      },
    });
  });

  it(`처리 시간의 초과 시간이 소요될시 timeout exception이 발생한다.`, (done: any) => {
    reflector.getAllAndOverride.mockReturnValue(500);

    callHandler.handle.mockReturnValue(of([]).pipe(delay(501)));

    timeoutInterceptor.intercept(executionContext, callHandler).subscribe({
      error(err) {
        expect(err).toBeInstanceOf(RequestTimeoutException);
        done();
      },
    });
  });

  const executionContext = {
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;

  const callHandler = {
    handle: jest.fn(),
  };
});
