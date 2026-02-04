/**
 * Fair Queue 우선순위 계산기.
 *
 * 이 클래스는 단위 테스트에서 우선순위 공식을 검증하기 위한 용도이다.
 * 실제 운영에서의 우선순위 계산은 Lua 스크립트(enqueue.lua, dequeue.lua)가 수행한다.
 * 공식을 변경할 경우 Lua 스크립트를 먼저 수정하고, 이 클래스도 동일하게 반영해야 한다.
 */
export class PriorityCalculator {
  constructor(private readonly alpha: number) {}

  calculate(params: {
    nowMs: number;
    basePriority: number;
    totalJobs: number;
    doneJobs: number;
  }): number {
    const { nowMs, basePriority, totalJobs, doneJobs } = params;
    const remaining = Math.max(1, totalJobs - doneJobs);
    const sjfBoost = this.alpha * (-1 + totalJobs / remaining);

    return -1 * nowMs + basePriority + sjfBoost;
  }
}
