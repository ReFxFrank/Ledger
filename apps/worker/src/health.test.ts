import { describe, expect, it } from 'vitest';
import { FixedClock } from '@ledger/core';

import { HealthState, buildHealthReport, statusCodeFor } from './health';
import { DEFAULT_HEALTH_PORT, readBoundedInt } from './config';

describe('the health endpoint', () => {
  it('is only 200 while the process is actually accepting work', () => {
    expect(statusCodeFor('ready')).toBe(200);
    // A draining worker still has jobs in flight, but must leave rotation — otherwise an
    // orchestrator keeps sending it work it has already stopped fetching.
    expect(statusCodeFor('draining')).toBe(503);
    expect(statusCodeFor('starting')).toBe(503);
    expect(statusCodeFor('stopped')).toBe(503);
  });

  it('reports uptime from the clock rather than from process time', () => {
    const started = new Date('2026-07-25T12:00:00Z');
    const report = buildHealthReport('ready', started, new FixedClock('2026-07-25T12:01:30Z'));
    expect(report).toMatchObject({ status: 'ok', phase: 'ready', uptimeSeconds: 90 });
  });

  it('moves through its phases', () => {
    const state = new HealthState(new Date('2026-07-25T12:00:00Z'));
    expect(state.current()).toBe('starting');
    state.set('ready');
    expect(state.report(new FixedClock('2026-07-25T12:00:05Z')).status).toBe('ok');
    state.set('draining');
    expect(state.report(new FixedClock('2026-07-25T12:00:06Z')).status).toBe('unavailable');
  });
});

describe('configuration knobs', () => {
  it('falls back rather than refusing to boot over a typo', () => {
    const bounds = { min: 1, max: 65_535, fallback: DEFAULT_HEALTH_PORT };
    expect(readBoundedInt(undefined, bounds)).toBe(DEFAULT_HEALTH_PORT);
    expect(readBoundedInt('', bounds)).toBe(DEFAULT_HEALTH_PORT);
    expect(readBoundedInt('four', bounds)).toBe(DEFAULT_HEALTH_PORT);
  });

  it('clamps instead of accepting a value that would stop the worker', () => {
    // Concurrency 0 is a worker that never picks anything up. Clamped, not honoured.
    expect(readBoundedInt('0', { min: 1, max: 32, fallback: 4 })).toBe(1);
    expect(readBoundedInt('9999', { min: 1, max: 32, fallback: 4 })).toBe(32);
  });

  it('reads a good value', () => {
    expect(readBoundedInt(' 8080 ', { min: 1, max: 65_535, fallback: 3001 })).toBe(8080);
  });
});
