import { RetryExecutor } from '@app/web-client/retry/RetryExecutor';
import { RetryPolicy } from '@app/web-client/retry/RetryPolicy';

describe('RetryExecutor', () => {
  it('첫 시도에 성공하면 바로 결과를 반환한다', async () => {
    // given
    const policy = RetryPolicy.withDefaults();
    const action = vi.fn().mockResolvedValue('success');

    // when
    const result = await RetryExecutor.execute(action, policy);

    // then
    expect(result).toBe('success');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('n번 실패 후 성공하면 결과를 반환한다', async () => {
    // given
    const policy = RetryPolicy.builder().maxRetries(3).delay(1).build();
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    // when
    const result = await RetryExecutor.execute(action, policy);

    // then
    expect(result).toBe('success');
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('모든 재시도가 소진되면 마지막 에러를 throw한다', async () => {
    // given
    const policy = RetryPolicy.builder().maxRetries(2).delay(1).build();
    const action = vi.fn().mockRejectedValue(new Error('always fail'));

    // when & then
    await expect(RetryExecutor.execute(action, policy)).rejects.toThrow(
      'always fail',
    );
    expect(action).toHaveBeenCalledTimes(3); // 초기 1회 + 재시도 2회
  });

  describe('calculateDelay', () => {
    it('multiplier가 0이면 fixed delay를 반환한다', () => {
      // given
      const policy = RetryPolicy.builder().delay(100).multiplier(0).build();

      // when & then
      expect(RetryExecutor.calculateDelay(0, policy)).toBe(100);
      expect(RetryExecutor.calculateDelay(1, policy)).toBe(100);
      expect(RetryExecutor.calculateDelay(2, policy)).toBe(100);
    });

    it('multiplier가 설정되면 exponential backoff로 증가한다', () => {
      // given
      const policy = RetryPolicy.builder().delay(100).multiplier(2).build();

      // when & then
      expect(RetryExecutor.calculateDelay(0, policy)).toBe(100); // 100 * 2^0
      expect(RetryExecutor.calculateDelay(1, policy)).toBe(200); // 100 * 2^1
      expect(RetryExecutor.calculateDelay(2, policy)).toBe(400); // 100 * 2^2
      expect(RetryExecutor.calculateDelay(3, policy)).toBe(800); // 100 * 2^3
    });

    it('maxDelay를 초과하지 않는다', () => {
      // given
      const policy = RetryPolicy.builder()
        .delay(100)
        .multiplier(2)
        .maxDelay(300)
        .build();

      // when & then
      expect(RetryExecutor.calculateDelay(0, policy)).toBe(100); // 100
      expect(RetryExecutor.calculateDelay(1, policy)).toBe(200); // 200
      expect(RetryExecutor.calculateDelay(2, policy)).toBe(300); // min(400, 300)
      expect(RetryExecutor.calculateDelay(3, policy)).toBe(300); // min(800, 300)
    });

    it('jitter가 설정되면 delay에 0~jitter 범위의 값이 추가된다', () => {
      // given
      const policy = RetryPolicy.builder().delay(100).jitter(50).build();

      // when
      const delays = Array.from({ length: 100 }, () =>
        RetryExecutor.calculateDelay(0, policy),
      );

      // then
      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(100);
        expect(delay).toBeLessThan(150);
      });
    });
  });
});
