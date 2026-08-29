import type { ProcessRole, ProcessTreeMemorySnapshot } from './process-tree';

export interface RuntimeProfileMetrics {
  sampleCount: number;
  p50TreeRssBytes: number;
  p95TreeRssBytes: number;
  peakTreeRssBytes: number;
  p50ProcessCount: number;
  p95ProcessCount: number;
  peakProcessCount: number;
  p50RoleRssBytes: Partial<Record<ProcessRole, number>>;
  p95RoleRssBytes: Partial<Record<ProcessRole, number>>;
  peakRoleRssBytes: Partial<Record<ProcessRole, number>>;
  p95CgroupCurrentBytes?: number;
  peakCgroupCurrentBytes?: number;
}

export interface RuntimeProfileComparisonSide {
  runCount: number;
  medianP95TreeRssBytes: number;
  medianPeakTreeRssBytes: number;
  medianP95RoleRssBytes: Partial<Record<ProcessRole, number>>;
  medianPeakRoleRssBytes: Partial<Record<ProcessRole, number>>;
}

export interface RuntimeProfileComparison {
  node: RuntimeProfileComparisonSide;
  agent: RuntimeProfileComparisonSide;
  p95TreeRssReductionRatio: number;
  peakTreeRssReductionRatio: number;
  meetsTwentyFivePercentMemoryGate: boolean;
}

export interface RuntimeLatencyComparison {
  nodeMedianP95Ms: number;
  agentMedianP95Ms: number;
  regressionRatio: number;
  maximumRegressionRatio: number;
  meetsLatencyGate: boolean;
}

export function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    throw new Error('Cannot calculate a percentile without samples');
  }
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error('quantile must be between 0 and 1');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[rank];
}

function summarizeRole(samples: ProcessTreeMemorySnapshot[], quantile: number): Partial<Record<ProcessRole, number>> {
  const roles = new Set<ProcessRole>();
  samples.forEach((sample) => {
    (Object.keys(sample.byRole) as ProcessRole[]).forEach((role) => roles.add(role));
  });
  return Object.fromEntries(
    Array.from(roles, (role) => [
      role,
      percentile(
        samples.map((sample) => sample.byRole[role]?.rssBytes || 0),
        quantile,
      ),
    ]),
  );
}

export function summarizeRuntimeProfile(samples: ProcessTreeMemorySnapshot[]): RuntimeProfileMetrics {
  if (samples.length === 0) {
    throw new Error('Runtime profile contains no samples');
  }
  const treeRss = samples.map((sample) => sample.totalRssBytes);
  const processCounts = samples.map((sample) => sample.processCount);
  const cgroupCurrent = samples.flatMap((sample) =>
    sample.linuxCgroup?.currentBytes === undefined ? [] : [sample.linuxCgroup.currentBytes],
  );
  return {
    sampleCount: samples.length,
    p50TreeRssBytes: percentile(treeRss, 0.5),
    p95TreeRssBytes: percentile(treeRss, 0.95),
    peakTreeRssBytes: Math.max(...treeRss),
    p50ProcessCount: percentile(processCounts, 0.5),
    p95ProcessCount: percentile(processCounts, 0.95),
    peakProcessCount: Math.max(...processCounts),
    p50RoleRssBytes: summarizeRole(samples, 0.5),
    p95RoleRssBytes: summarizeRole(samples, 0.95),
    peakRoleRssBytes: summarizeRole(samples, 1),
    p95CgroupCurrentBytes: cgroupCurrent.length > 0 ? percentile(cgroupCurrent, 0.95) : undefined,
    peakCgroupCurrentBytes: cgroupCurrent.length > 0 ? Math.max(...cgroupCurrent) : undefined,
  };
}

function medianRoleMetric(
  runs: RuntimeProfileMetrics[],
  metric: 'p95RoleRssBytes' | 'peakRoleRssBytes',
): Partial<Record<ProcessRole, number>> {
  const roles = new Set<ProcessRole>();
  runs.forEach((run) => {
    (Object.keys(run[metric]) as ProcessRole[]).forEach((role) => roles.add(role));
  });
  return Object.fromEntries(
    Array.from(roles, (role) => [
      role,
      percentile(
        runs.map((run) => run[metric][role] || 0),
        0.5,
      ),
    ]),
  );
}

function summarizeComparisonSide(runs: RuntimeProfileMetrics[]): RuntimeProfileComparisonSide {
  if (runs.length === 0) {
    throw new Error('Runtime profile comparison side contains no runs');
  }
  return {
    runCount: runs.length,
    medianP95TreeRssBytes: percentile(
      runs.map((run) => run.p95TreeRssBytes),
      0.5,
    ),
    medianPeakTreeRssBytes: percentile(
      runs.map((run) => run.peakTreeRssBytes),
      0.5,
    ),
    medianP95RoleRssBytes: medianRoleMetric(runs, 'p95RoleRssBytes'),
    medianPeakRoleRssBytes: medianRoleMetric(runs, 'peakRoleRssBytes'),
  };
}

function reductionRatio(baseline: number, candidate: number): number {
  if (baseline <= 0) {
    throw new Error('Node baseline must be greater than zero');
  }
  return (baseline - candidate) / baseline;
}

export function compareRuntimeProfiles(
  nodeRuns: RuntimeProfileMetrics[],
  agentRuns: RuntimeProfileMetrics[],
): RuntimeProfileComparison {
  if (nodeRuns.length !== agentRuns.length) {
    throw new Error(`Node and Agent run counts differ (${nodeRuns.length} versus ${agentRuns.length})`);
  }
  const node = summarizeComparisonSide(nodeRuns);
  const agent = summarizeComparisonSide(agentRuns);
  const p95TreeRssReductionRatio = reductionRatio(node.medianP95TreeRssBytes, agent.medianP95TreeRssBytes);
  const peakTreeRssReductionRatio = reductionRatio(node.medianPeakTreeRssBytes, agent.medianPeakTreeRssBytes);
  return {
    node,
    agent,
    p95TreeRssReductionRatio,
    peakTreeRssReductionRatio,
    meetsTwentyFivePercentMemoryGate: p95TreeRssReductionRatio >= 0.25 || peakTreeRssReductionRatio >= 0.25,
  };
}

export function compareRuntimeLatencies(
  nodeP95LatenciesMs: number[],
  agentP95LatenciesMs: number[],
  maximumRegressionRatio = 0.1,
): RuntimeLatencyComparison {
  if (nodeP95LatenciesMs.length === 0 || agentP95LatenciesMs.length === 0) {
    throw new Error('Runtime latency comparison requires at least one run per variant');
  }
  if (nodeP95LatenciesMs.length !== agentP95LatenciesMs.length) {
    throw new Error(
      `Node and Agent latency run counts differ (${nodeP95LatenciesMs.length} versus ${agentP95LatenciesMs.length})`,
    );
  }
  if (!Number.isFinite(maximumRegressionRatio) || maximumRegressionRatio < 0) {
    throw new Error('maximumRegressionRatio must be a non-negative number');
  }
  const nodeMedianP95Ms = percentile(nodeP95LatenciesMs, 0.5);
  const agentMedianP95Ms = percentile(agentP95LatenciesMs, 0.5);
  if (nodeMedianP95Ms <= 0) {
    throw new Error('Node latency baseline must be greater than zero');
  }
  const regressionRatio = (agentMedianP95Ms - nodeMedianP95Ms) / nodeMedianP95Ms;
  return {
    nodeMedianP95Ms,
    agentMedianP95Ms,
    regressionRatio,
    maximumRegressionRatio,
    meetsLatencyGate: regressionRatio <= maximumRegressionRatio,
  };
}
