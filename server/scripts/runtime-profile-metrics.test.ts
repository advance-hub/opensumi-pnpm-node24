import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareRuntimeLatencies,
  compareRuntimeProfiles,
  percentile,
  summarizeRuntimeProfile,
} from './runtime-profile-metrics';

import type { ProcessTreeMemorySnapshot } from './process-tree';

function sample(totalRssBytes: number, watcherRssBytes: number, agentRssBytes = 0): ProcessTreeMemorySnapshot {
  return {
    timestamp: new Date(0).toISOString(),
    rootPid: 10,
    processCount: agentRssBytes > 0 ? 3 : 2,
    totalRssBytes,
    byRole: {
      server: { count: 1, rssBytes: totalRssBytes - watcherRssBytes - agentRssBytes },
      ...(watcherRssBytes > 0 ? { 'watcher-host': { count: 1, rssBytes: watcherRssBytes } } : {}),
      ...(agentRssBytes > 0 ? { 'workspace-agent': { count: 1, rssBytes: agentRssBytes } } : {}),
    },
    processes: [],
  };
}

describe('runtime profile metrics', () => {
  it('uses the nearest-rank definition for stable operational percentiles', () => {
    assert.equal(percentile([50, 10, 40, 20, 30], 0.5), 30);
    assert.equal(percentile([50, 10, 40, 20, 30], 0.95), 50);
    assert.throws(() => percentile([], 0.95), /without samples/);
  });

  it('summarizes whole-tree and missing-role RSS without dropping zeroes', () => {
    const metrics = summarizeRuntimeProfile([sample(100, 30), sample(120, 40), sample(110, 0, 10)]);

    assert.equal(metrics.p50TreeRssBytes, 110);
    assert.equal(metrics.p95TreeRssBytes, 120);
    assert.equal(metrics.p50RoleRssBytes['watcher-host'], 30);
    assert.equal(metrics.p95RoleRssBytes['workspace-agent'], 10);
  });

  it('compares medians across equal repeated runs and applies the 25 percent gate', () => {
    const nodeRuns = [300, 320, 310].map((rss) => summarizeRuntimeProfile([sample(rss, 100)]));
    const agentRuns = [210, 230, 220].map((rss) => summarizeRuntimeProfile([sample(rss, 0, 20)]));
    const comparison = compareRuntimeProfiles(nodeRuns, agentRuns);

    assert.equal(comparison.node.runCount, 3);
    assert.equal(comparison.node.medianP95TreeRssBytes, 310);
    assert.equal(comparison.agent.medianP95TreeRssBytes, 220);
    assert.equal(comparison.meetsTwentyFivePercentMemoryGate, true);
    assert.throws(() => compareRuntimeProfiles(nodeRuns, agentRuns.slice(1)), /run counts differ/);
  });

  it('compares median search P95 and applies the ten percent regression gate', () => {
    const passing = compareRuntimeLatencies([1_012, 1_074, 1_043], [1_093, 863, 895]);
    assert.equal(passing.nodeMedianP95Ms, 1_043);
    assert.equal(passing.agentMedianP95Ms, 895);
    assert.equal(passing.meetsLatencyGate, true);

    const failing = compareRuntimeLatencies([100, 110, 105], [120, 125, 130]);
    assert.equal(failing.meetsLatencyGate, false);
    assert.ok(failing.regressionRatio > 0.1);
    assert.throws(() => compareRuntimeLatencies([100], []), /at least one run/);
    assert.throws(() => compareRuntimeLatencies([100, 110], [100]), /run counts differ/);
  });
});
