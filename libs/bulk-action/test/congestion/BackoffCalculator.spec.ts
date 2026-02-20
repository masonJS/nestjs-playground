import { BackoffCalculator } from '@app/bulk-action/congestion/BackoffCalculator';
import { CongestionLevel } from '@app/bulk-action/congestion/dto/BackoffDto';

describe('BackoffCalculator', () => {
  describe('calculate', () => {
    it('첫 번째 작업은 base backoff를 반환한다', () => {
      // given
      const params = {
        nonReadyCount: 1,
        rateLimitSpeed: 10,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.backoffMs).toBe(1000);
      expect(result.congestionLevel).toBe(CongestionLevel.NONE);
    });

    it('non-ready 수에 비례하여 backoff가 증가한다', () => {
      // given - nonReadyCount=20, rateLimitSpeed=10
      // backoff = 1000 + floor(20/10) * 1000 = 3000ms
      const params = {
        nonReadyCount: 20,
        rateLimitSpeed: 10,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.backoffMs).toBe(3000);
    });

    it('maxBackoffMs로 클램핑된다', () => {
      // given - 매우 큰 nonReadyCount
      const params = {
        nonReadyCount: 10000,
        rateLimitSpeed: 1,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.backoffMs).toBe(120000);
    });

    it('rateLimitSpeed가 0이면 1로 보정된다', () => {
      // given
      const params = {
        nonReadyCount: 5,
        rateLimitSpeed: 0,
        baseBackoffMs: 1000,
        maxBackoffMs: 120000,
      };

      // when
      const result = BackoffCalculator.calculate(params);

      // then
      expect(result.rateLimitSpeed).toBe(1);
      expect(result.backoffMs).toBe(6000);
    });
  });

  describe('classify', () => {
    it.each([
      { backoffMs: 1000, baseBackoffMs: 1000, expected: CongestionLevel.NONE },
      { backoffMs: 2000, baseBackoffMs: 1000, expected: CongestionLevel.LOW },
      {
        backoffMs: 2999,
        baseBackoffMs: 1000,
        expected: CongestionLevel.LOW,
      },
      {
        backoffMs: 3000,
        baseBackoffMs: 1000,
        expected: CongestionLevel.MODERATE,
      },
      {
        backoffMs: 9999,
        baseBackoffMs: 1000,
        expected: CongestionLevel.MODERATE,
      },
      {
        backoffMs: 10000,
        baseBackoffMs: 1000,
        expected: CongestionLevel.HIGH,
      },
      {
        backoffMs: 29999,
        baseBackoffMs: 1000,
        expected: CongestionLevel.HIGH,
      },
      {
        backoffMs: 30000,
        baseBackoffMs: 1000,
        expected: CongestionLevel.CRITICAL,
      },
      {
        backoffMs: 120000,
        baseBackoffMs: 1000,
        expected: CongestionLevel.CRITICAL,
      },
    ])(
      'backoff=$backoffMs, base=$baseBackoffMs → $expected',
      ({ backoffMs, baseBackoffMs, expected }) => {
        // when
        const result = BackoffCalculator.classify(backoffMs, baseBackoffMs);

        // then
        expect(result).toBe(expected);
      },
    );

    it('baseBackoffMs가 0이면 NONE을 반환한다', () => {
      // when
      const result = BackoffCalculator.classify(5000, 0);

      // then
      expect(result).toBe(CongestionLevel.NONE);
    });
  });

  describe('estimateCompletionTime', () => {
    it('대기 중인 작업 수와 처리 속도로 완료 시간을 추정한다', () => {
      // given - 100개 대기, 속도 10/s
      // when
      const result = BackoffCalculator.estimateCompletionTime(100, 10);

      // then
      expect(result).toBe(10000);
    });

    it('rateLimitSpeed가 0이면 1로 보정된다', () => {
      // when
      const result = BackoffCalculator.estimateCompletionTime(5, 0);

      // then
      expect(result).toBe(5000);
    });

    it('나누어 떨어지지 않으면 올림한다', () => {
      // given - 15개 대기, 속도 10/s → ceil(15/10) * 1000 = 2000
      // when
      const result = BackoffCalculator.estimateCompletionTime(15, 10);

      // then
      expect(result).toBe(2000);
    });
  });
});
