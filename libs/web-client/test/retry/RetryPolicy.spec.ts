import { RetryPolicy } from '@app/web-client/retry/RetryPolicy';

describe('RetryPolicy', () => {
  describe('withDefaults', () => {
    it('기본값으로 생성된다', () => {
      // when
      const policy = RetryPolicy.withDefaults();

      // then
      expect(policy.maxRetries).toBe(3);
      expect(policy.delay).toBe(1000);
      expect(policy.jitter).toBe(0);
      expect(policy.multiplier).toBe(0);
      expect(policy.maxDelay).toBe(0);
    });
  });

  describe('withMaxRetries', () => {
    it('maxRetries만 변경하고 나머지는 기본값을 사용한다', () => {
      // when
      const policy = RetryPolicy.withMaxRetries(5);

      // then
      expect(policy.maxRetries).toBe(5);
      expect(policy.delay).toBe(1000);
      expect(policy.jitter).toBe(0);
      expect(policy.multiplier).toBe(0);
      expect(policy.maxDelay).toBe(0);
    });
  });

  describe('builder', () => {
    it('모든 필드를 설정할 수 있다', () => {
      // when
      const policy = RetryPolicy.builder()
        .maxRetries(4)
        .delay(100)
        .jitter(10)
        .multiplier(2)
        .maxDelay(5000)
        .build();

      // then
      expect(policy.maxRetries).toBe(4);
      expect(policy.delay).toBe(100);
      expect(policy.jitter).toBe(10);
      expect(policy.multiplier).toBe(2);
      expect(policy.maxDelay).toBe(5000);
    });

    it.each([
      ['maxRetries', -1],
      ['delay', -1],
      ['jitter', -1],
      ['multiplier', -1],
      ['maxDelay', -1],
    ])('%s에 음수를 설정하면 에러가 발생한다', (field, value) => {
      // when & then
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      expect(() => RetryPolicy.builder()[field](value).build()).toThrow(
        `${field} must be >= 0`,
      );
    });
  });
});
