/**
 * The health endpoint.
 *
 * Small on purpose: a worker has no HTTP surface, and adding a framework to answer one GET would
 * be a dependency this process only carries so a container can ask whether it is alive.
 *
 * The one non-obvious behaviour is `draining`. During a graceful shutdown the worker is still
 * finishing in-flight jobs and must not be reported healthy, or an orchestrator will keep it in
 * rotation and a load balancer will keep the container alive past the point where it is doing
 * anything useful. So draining answers 503 with a body that says why, and only `ready` is 200.
 */

import { type Server, createServer } from 'node:http';
import type { Clock } from '@ledger/core';
import { childLogger } from '@ledger/logger';

const log = childLogger('worker.health');

export type HealthPhase = 'starting' | 'ready' | 'draining' | 'stopped';

export interface HealthReport {
  readonly status: 'ok' | 'unavailable';
  readonly phase: HealthPhase;
  readonly uptimeSeconds: number;
  readonly at: string;
}

/** 200 only when the process is actually accepting work. Everything else is 503. */
export function statusCodeFor(phase: HealthPhase): 200 | 503 {
  return phase === 'ready' ? 200 : 503;
}

export function buildHealthReport(phase: HealthPhase, startedAt: Date, clock: Clock): HealthReport {
  const now = clock.now();
  return {
    status: phase === 'ready' ? 'ok' : 'unavailable',
    phase,
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
    at: now.toISOString(),
  };
}

/** The mutable bit of the endpoint. The entrypoint owns one and moves it through the phases. */
export class HealthState {
  private phase: HealthPhase = 'starting';

  constructor(private readonly startedAt: Date) {}

  set(phase: HealthPhase): void {
    this.phase = phase;
  }

  current(): HealthPhase {
    return this.phase;
  }

  report(clock: Clock): HealthReport {
    return buildHealthReport(this.phase, this.startedAt, clock);
  }
}

export interface HealthServerOptions {
  readonly port: number;
  readonly host: string;
  readonly state: HealthState;
  readonly clock: Clock;
}

export interface HealthServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

const HEALTH_PATHS = new Set(['/health', '/healthz', '/']);

export function createHealthServer(options: HealthServerOptions): HealthServer {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (!HEALTH_PATHS.has(path)) {
      response.writeHead(404).end();
      return;
    }

    const report = options.state.report(options.clock);
    const body = JSON.stringify(report);
    response.writeHead(statusCodeFor(report.phase), {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      // Nothing about this response is worth a second's staleness to a healthcheck.
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });

  return {
    listen: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(options.port, options.host, () => {
          server.off('error', onError);
          log.info({ port: options.port, host: options.host }, 'health endpoint listening');
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        // `closeAllConnections` so a healthcheck holding keep-alive open cannot pin the process
        // past the shutdown deadline.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
