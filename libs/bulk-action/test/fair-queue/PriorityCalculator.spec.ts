import { PriorityCalculator } from '@app/bulk-action/fair-queue/PriorityCalculator';

describe('PriorityCalculator', () => {
  const calculator = new PriorityCalculator(10000);

  it('최근 요청이 더 낮은 score를 가진다 (에이징: 오래 대기할수록 상대적 score 상승)', () => {
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

    // -1 * nowMs이므로 nowMs가 클수록 score가 작다.
    // 오래 대기한 그룹은 상대적으로 score가 높아져 먼저 dequeue된다 (에이징).
    expect(newer).toBeLessThan(older);
  });

  it('basePriority가 높은 그룹이 우선 처리된다', () => {
    const now = Date.now();
    const premium = calculator.calculate({
      nowMs: now,
      basePriority: 1000000,
      totalJobs: 100,
      doneJobs: 0,
    });
    const normal = calculator.calculate({
      nowMs: now,
      basePriority: 0,
      totalJobs: 100,
      doneJobs: 0,
    });

    expect(premium).toBeGreaterThan(normal);
  });

  it('ALPHA 양수일 때 진행률이 높은 그룹의 score가 더 크다 (SJF)', () => {
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

  it('ALPHA 음수일 때 진행률이 높은 그룹의 score가 더 낮다 (공정 분배)', () => {
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
