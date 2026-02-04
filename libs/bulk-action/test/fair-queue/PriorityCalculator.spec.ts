import { PriorityCalculator } from '@app/bulk-action/fair-queue/PriorityCalculator';

describe('PriorityCalculator', () => {
  const calculator = new PriorityCalculator(10000);

  it('최근 요청이 더 낮은 score를 가진다 (nowMs가 클수록 score 감소)', () => {
    const older = calculator.calculate({
      nowMs: 1706000000000,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });
    const newer = calculator.calculate({
      nowMs: 1706001000000,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });

    // -1 * nowMs이므로 nowMs가 클수록 score가 작다 (= 높은 우선순위)
    // Sorted Set에서 score가 작은 것이 먼저 dequeue되므로,
    // 같은 조건에서는 최근 등록(enqueue 시 갱신)된 그룹이 우선한다.
    expect(newer).toBeLessThan(older);
  });

  it('basePriority가 낮은 그룹이 우선 처리된다', () => {
    const now = Date.now();
    const premium = calculator.calculate({
      nowMs: now,
      basePriority: -1000000,
      totalJobs: 100,
      doneJobs: 0,
    });
    const normal = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });

    expect(premium).toBeLessThan(normal);
  });

  it('ALPHA 양수일 때 진행률이 높은 그룹의 score가 더 크다 (공정 분배)', () => {
    const now = Date.now();
    const almostDone = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 95,
    });
    const justStarted = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 5,
    });

    expect(almostDone).toBeGreaterThan(justStarted);
  });

  it('ALPHA 음수일 때 진행률이 높은 그룹의 score가 더 작다 (SJF)', () => {
    const sjfCalculator = new PriorityCalculator(-10000);
    const now = Date.now();
    const almostDone = sjfCalculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 95,
    });
    const justStarted = sjfCalculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 5,
    });

    expect(almostDone).toBeLessThan(justStarted);
  });
});
