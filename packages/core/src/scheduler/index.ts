export {
  plan,
  chunkTask,
  checkPlanInvariants,
  compareTasks,
  isHardDeadlineAtRisk,
  rankKey,
  PlanInvariantError,
} from './plan';
export { describeExplanation, type ExplainContext } from './explain';
export {
  disruptionScore,
  gatePlan,
  HYBRID_THRESHOLDS,
  type GateDecision,
  type GateInput,
  type SchedulingMode,
} from './gate';
export { diffPlans, summarizeChanges, describeTrigger, describeMoment } from './diff';
export {
  buildAvailability,
  buildEnergyMap,
  energyAt,
  energySatisfies,
  expandLabeledRoutines,
  expandProtectedTimes,
  type Availability,
  type AvailabilityInput,
  type EnergyMap,
  type LabeledInterval,
} from './availability';
export {
  projectFlow,
  totalDrift,
  type FlowItem,
  type FlowOptions,
  type ProjectedItem,
} from './flow';
export {
  computeCapacity,
  verdictFor,
  type Capacity,
  type CapacityInput,
  type LoadVerdict,
} from './capacity';
export {
  alignUp,
  contains,
  durationMinutes,
  intersectIntervals,
  mergeIntervals,
  overlaps,
  sortIntervals,
  subtractIntervals,
  totalMinutes,
} from './intervals';
export type * from './types';
