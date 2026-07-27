import { Histogram } from 'prom-client';

/**
 * Histogram tracking the age of the oldest event in a batch when flushed.
 * Buckets are tuned specifically for sub-second to low-second micro-batching windows.
 */
export const wsBroadcastBatchFlushLatencySeconds = new Histogram({
  name: 'fluxora_ws_broadcast_batch_flush_seconds',
  help: 'Latency (in seconds) from the oldest event enqueued to the moment the batch is flushed to WebSockets.',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
});

/**
 * Helper to record batch flush latency in seconds.
 *
 * @param durationSeconds Latency in seconds.
 */
export function recordWsBroadcastBatchFlushLatency(durationSeconds: number): void {
  if (durationSeconds >= 0) {
    wsBroadcastBatchFlushLatencySeconds.observe(durationSeconds);
  }
}
