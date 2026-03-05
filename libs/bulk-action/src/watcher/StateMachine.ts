import { GroupStatus } from '../model/job-group/type/GroupStatus';

export interface TransitionRule {
  from: GroupStatus;
  to: GroupStatus;
  requiresLock: boolean;
}

const TRANSITION_RULES: TransitionRule[] = [
  {
    from: GroupStatus.CREATED,
    to: GroupStatus.DISPATCHED,
    requiresLock: false,
  },
  {
    from: GroupStatus.DISPATCHED,
    to: GroupStatus.RUNNING,
    requiresLock: false,
  },
  {
    from: GroupStatus.RUNNING,
    to: GroupStatus.AGGREGATING,
    requiresLock: true,
  },
  {
    from: GroupStatus.AGGREGATING,
    to: GroupStatus.COMPLETED,
    requiresLock: true,
  },
  {
    from: GroupStatus.CREATED,
    to: GroupStatus.FAILED,
    requiresLock: false,
  },
  {
    from: GroupStatus.DISPATCHED,
    to: GroupStatus.FAILED,
    requiresLock: false,
  },
  {
    from: GroupStatus.RUNNING,
    to: GroupStatus.FAILED,
    requiresLock: false,
  },
  {
    from: GroupStatus.AGGREGATING,
    to: GroupStatus.FAILED,
    requiresLock: true,
  },
];

const TERMINAL_STATES = new Set<GroupStatus>([
  GroupStatus.COMPLETED,
  GroupStatus.FAILED,
]);

export class StateMachine {
  isValidTransition(from: GroupStatus, to: GroupStatus): boolean {
    return TRANSITION_RULES.some(
      (rule) => rule.from === from && rule.to === to,
    );
  }

  requiresLock(from: GroupStatus, to: GroupStatus): boolean {
    const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);

    return rule?.requiresLock ?? false;
  }

  getNextStates(from: GroupStatus): GroupStatus[] {
    return TRANSITION_RULES.filter((rule) => rule.from === from).map(
      (rule) => rule.to,
    );
  }

  isTerminal(status: GroupStatus): boolean {
    return TERMINAL_STATES.has(status);
  }
}
