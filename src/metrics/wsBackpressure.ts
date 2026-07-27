import { Counter, Gauge, Histogram, register } from 'prom-client';

/**
 * Register a metric safely, reusing an existing registration if one exists.
 * This is necessary because tests that use `vi.resetModules()` may re-import
 * this module multiple times, which would otherwise throw "already registered".
 */
function metric<T>(name: string, factory: () => T): T {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as unknown as T;
  return factory();
}

/**
 * Histogram tracking the age of the oldest event in a batch when flushed.
 * Buckets are tuned specifically for sub-second to low-second micro-batching windows.
 */
export const wsBroadcastBatchFlushLatencySeconds = metric(
  'fluxora_ws_broadcast_batch_flush_seconds',
  () =>
    new Histogram({
      name: 'fluxora_ws_broadcast_batch_flush_seconds',
      help: 'Latency (in seconds) from the oldest event enqueued to the moment the batch is flushed to WebSockets.',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
    }),
);

/**
 * Helper to record batch flush latency in seconds.
 */
export function recordWsBroadcastBatchFlushLatency(durationSeconds: number): void {
  if (durationSeconds >= 0) {
    wsBroadcastBatchFlushLatencySeconds.observe(durationSeconds);
  }
}

// ── Per-client backpressure gauge ─────────────────────────────────────────

export const wsClientBufferedBytes = metric(
  'fluxora_ws_backpressure_buffered_bytes',
  () =>
    new Gauge({
      name: 'fluxora_ws_backpressure_buffered_bytes',
      help: 'Current bufferedAmount per WebSocket connection.',
      labelNames: ['connection_id'],
    }),
);

export const wsMaxBufferedBytes = metric(
  'fluxora_ws_max_buffered_bytes',
  () =>
    new Gauge({
      name: 'fluxora_ws_max_buffered_bytes',
      help: 'Maximum bufferedAmount across all connected WebSocket clients.',
    }),
);

export const wsSlowClients = metric(
  'fluxora_ws_slow_clients',
  () =>
    new Gauge({
      name: 'fluxora_ws_slow_clients',
      help: 'Number of WebSocket clients whose bufferedAmount exceeds the slow threshold.',
    }),
);

// ── Subscription cardinality gauge ────────────────────────────────────────

export const wsStreamSubscriberCount = metric(
  'fluxora_ws_stream_subscriber_count',
  () =>
    new Gauge({
      name: 'fluxora_ws_stream_subscriber_count',
      help: 'Number of subscribers per stream (top-N capped).',
      labelNames: ['stream_id'],
    }),
);

// ── Batch flush counters ──────────────────────────────────────────────────

export const wsBatchFlushTotal = metric(
  'fluxora_ws_batch_flush_total',
  () =>
    new Counter({
      name: 'fluxora_ws_batch_flush_total',
      help: 'Total number of batch flushes (one frame emitted per flush).',
    }),
);

export const wsBatchEventsCoalescedTotal = metric(
  'fluxora_ws_batch_events_coalesced_total',
  () =>
    new Counter({
      name: 'fluxora_ws_batch_events_coalesced_total',
      help: 'Total number of individual events coalesced across all batch flushes.',
    }),
);

export const wsBatchSizeExceededTotal = metric(
  'fluxora_ws_batch_size_exceeded_total',
  () =>
    new Counter({
      name: 'fluxora_ws_batch_size_exceeded_total',
      help: 'Number of batch flushes triggered early by hitting the max-size cap.',
    }),
);

// ── Constants ─────────────────────────────────────────────────────────────

export const DEFAULT_WS_BACKPRESSURE_INTERVAL_MS = 5_000;
export const DEFAULT_WS_SLOW_CLIENT_BYTES = 1 * 1024 * 1024;
export const DEFAULT_WS_STREAM_CARDINALITY_TOP_N = 20;

// ── Collection ────────────────────────────────────────────────────────────

export function collectWsBackpressureMetrics(
  hub: {
    _getClients?: () => IterableIterator<[unknown, { id: string }]>;
    _getStreamSubscriptions?: () => ReadonlyMap<string, Set<unknown>>;
  },
  slowThresholdBytes: number = DEFAULT_WS_SLOW_CLIENT_BYTES,
  topN: number = DEFAULT_WS_STREAM_CARDINALITY_TOP_N,
): void {
  const clientIterator = hub._getClients?.();
  if (clientIterator) {
    let max = 0;
    let slowCount = 0;

    for (const [ws, state] of clientIterator) {
      const socket = ws as { readyState?: number; bufferedAmount?: number };
      if (socket.readyState !== 1) continue;

      const ba = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
      wsClientBufferedBytes.set({ connection_id: state.id }, ba);

      if (ba > max) max = ba;
      if (ba > slowThresholdBytes) slowCount++;
    }

    wsMaxBufferedBytes.set(max);
    wsSlowClients.set(slowCount);
  }

  const streamSubs = hub._getStreamSubscriptions?.();
  if (streamSubs) {
    const sorted = Array.from(streamSubs.entries())
      .map(([id, set]) => [id, set.size] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN);

    wsStreamSubscriberCount.reset();
    for (const [id, count] of sorted) {
      wsStreamSubscriberCount.set({ stream_id: id }, count);
    }
  }
}

export function removeWsClientBackpressureGauge(connectionId: string): void {
  wsClientBufferedBytes.remove({ connection_id: connectionId });
}

export function resetWsBackpressureMetrics(): void {
  wsClientBufferedBytes.reset();
  wsMaxBufferedBytes.reset();
  wsSlowClients.reset();
  wsStreamSubscriberCount.reset();
}
