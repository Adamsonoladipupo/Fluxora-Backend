/**
 * Idempotency Header and Payload Hashing Utilities.
 * Matching src/middleware/idempotency.ts and src/validation/idempotency.ts semantics.
 */

/**
 * Generate a UUID v4 idempotency key string.
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Simple UUID v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Recursively canonicalize a JSON object by sorting object keys.
 */
export function canonicalizeBody(body: unknown): string {
  if (body === null || body === undefined) return 'null';
  if (typeof body !== 'object') return JSON.stringify(body);

  if (Array.isArray(body)) {
    const items = body.map((item) => canonicalizeBody(item));
    return `[${items.join(',')}]`;
  }

  const keys = Object.keys(body as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `"${k}":${canonicalizeBody((body as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Calculate SHA-256 hex digest of a canonicalized JSON payload.
 */
export async function hashBody(body: unknown): Promise<string> {
  const canonical = canonicalizeBody(body);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Node.js crypto fallback
  try {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    throw new Error('Crypto API unavailable for hash calculation');
  }
}
