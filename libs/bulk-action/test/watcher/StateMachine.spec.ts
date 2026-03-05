import { StateMachine } from '@app/bulk-action/watcher/StateMachine';
import { GroupStatus } from '@app/bulk-action/model/job-group/type/GroupStatus';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    sm = new StateMachine();
  });

  describe('isValidTransition', () => {
    it('유효한 전이를 허용한다', () => {
      // given / when / then
      expect(
        sm.isValidTransition(GroupStatus.CREATED, GroupStatus.DISPATCHED),
      ).toBe(true);
      expect(
        sm.isValidTransition(GroupStatus.DISPATCHED, GroupStatus.RUNNING),
      ).toBe(true);
      expect(
        sm.isValidTransition(GroupStatus.RUNNING, GroupStatus.AGGREGATING),
      ).toBe(true);
      expect(
        sm.isValidTransition(GroupStatus.AGGREGATING, GroupStatus.COMPLETED),
      ).toBe(true);
    });

    it('유효하지 않은 전이를 거부한다', () => {
      // given / when / then
      expect(
        sm.isValidTransition(GroupStatus.CREATED, GroupStatus.RUNNING),
      ).toBe(false);
      expect(
        sm.isValidTransition(GroupStatus.CREATED, GroupStatus.AGGREGATING),
      ).toBe(false);
      expect(
        sm.isValidTransition(GroupStatus.CREATED, GroupStatus.COMPLETED),
      ).toBe(false);
      expect(
        sm.isValidTransition(GroupStatus.DISPATCHED, GroupStatus.AGGREGATING),
      ).toBe(false);
      expect(
        sm.isValidTransition(GroupStatus.COMPLETED, GroupStatus.FAILED),
      ).toBe(false);
    });

    it('FAILED 전이가 가능한 상태를 확인한다', () => {
      // given / when / then
      expect(
        sm.isValidTransition(GroupStatus.CREATED, GroupStatus.FAILED),
      ).toBe(true);
      expect(
        sm.isValidTransition(GroupStatus.DISPATCHED, GroupStatus.FAILED),
      ).toBe(true);
      expect(
        sm.isValidTransition(GroupStatus.RUNNING, GroupStatus.FAILED),
      ).toBe(true);
      expect(
        sm.isValidTransition(GroupStatus.AGGREGATING, GroupStatus.FAILED),
      ).toBe(true);
    });
  });

  describe('isTerminal', () => {
    it('터미널 상태를 판정한다', () => {
      // given / when / then
      expect(sm.isTerminal(GroupStatus.COMPLETED)).toBe(true);
      expect(sm.isTerminal(GroupStatus.FAILED)).toBe(true);
    });

    it('비터미널 상태를 판정한다', () => {
      // given / when / then
      expect(sm.isTerminal(GroupStatus.CREATED)).toBe(false);
      expect(sm.isTerminal(GroupStatus.DISPATCHED)).toBe(false);
      expect(sm.isTerminal(GroupStatus.RUNNING)).toBe(false);
      expect(sm.isTerminal(GroupStatus.AGGREGATING)).toBe(false);
    });
  });

  describe('requiresLock', () => {
    it('분산락이 필요한 전이를 확인한다', () => {
      // given / when / then
      expect(
        sm.requiresLock(GroupStatus.RUNNING, GroupStatus.AGGREGATING),
      ).toBe(true);
      expect(
        sm.requiresLock(GroupStatus.AGGREGATING, GroupStatus.COMPLETED),
      ).toBe(true);
    });

    it('AGGREGATING→FAILED 전이에 분산락이 필요하다', () => {
      // given / when / then
      expect(sm.requiresLock(GroupStatus.AGGREGATING, GroupStatus.FAILED)).toBe(
        true,
      );
    });

    it('분산락이 불필요한 전이를 확인한다', () => {
      // given / when / then
      expect(sm.requiresLock(GroupStatus.CREATED, GroupStatus.DISPATCHED)).toBe(
        false,
      );
      expect(sm.requiresLock(GroupStatus.DISPATCHED, GroupStatus.RUNNING)).toBe(
        false,
      );
      expect(sm.requiresLock(GroupStatus.CREATED, GroupStatus.FAILED)).toBe(
        false,
      );
    });
  });

  describe('getNextStates', () => {
    it('가능한 다음 상태 목록을 반환한다', () => {
      // given / when
      const nextFromCreated = sm.getNextStates(GroupStatus.CREATED);
      const nextFromRunning = sm.getNextStates(GroupStatus.RUNNING);
      const nextFromAggregating = sm.getNextStates(GroupStatus.AGGREGATING);
      const nextFromCompleted = sm.getNextStates(GroupStatus.COMPLETED);

      // then
      expect(nextFromCreated).toEqual(
        expect.arrayContaining([GroupStatus.DISPATCHED, GroupStatus.FAILED]),
      );
      expect(nextFromRunning).toEqual(
        expect.arrayContaining([GroupStatus.AGGREGATING, GroupStatus.FAILED]),
      );
      expect(nextFromAggregating).toEqual(
        expect.arrayContaining([GroupStatus.COMPLETED, GroupStatus.FAILED]),
      );
      expect(nextFromCompleted).toEqual([]);
    });
  });
});
