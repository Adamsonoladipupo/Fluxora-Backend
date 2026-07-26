# Fluxora TypeScript Client SDK

Typed TypeScript client SDK for the Fluxora HTTP API generated directly from `openapi.yaml`.

## Features
- **Zero External Dependencies**: Uses standard Web Fetch API (`fetch`).
- **Cursor Pagination**: Native support for cursor pagination via `StreamPaginator` (`autoPaginate()`).
- **Idempotency Header & Payload Hashing**: Canonical JSON SHA-256 body hashing matching `src/middleware/idempotency.ts`.
- **Complete Endpoint Coverage**: Includes streams, webhooks, auth, health probes, and admin endpoints.
- **Full Type Safety**: Complete TypeScript interfaces for all request payloads and response envelopes.

## Quickstart

```typescript
import { FluxoraClient, StreamPaginator, generateIdempotencyKey } from '@fluxora/sdk';

// Initialize client
const client = new FluxoraClient({ baseUrl: 'http://localhost:3000' });

// 1. Health probe
const health = await client.getHealth();
console.log('Status:', health.status);

// 2. Create stream with Idempotency Key
const idempotencyKey = generateIdempotencyKey();
const stream = await client.createStream(
  {
    sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
    recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    amount: '100.5000000',
    asset: 'XLM',
  },
  idempotencyKey,
);
console.log('Created Stream:', stream.id);

// 3. Paginate streams
const paginator = client.listStreams({ limit: 20, status: 'active' });
for await (const streamItem of paginator.autoPaginate()) {
  console.log('Stream:', streamItem.id, streamItem.status);
}
```

## Handling Idempotency Conflicts

```typescript
import { IdempotencyConflictError } from '@fluxora/sdk';

try {
  await client.createStream(payload, 'reused-key');
} catch (err) {
  if (err instanceof IdempotencyConflictError) {
    console.error('Idempotency collision!', err.storedHash, err.incomingHash);
  }
}
```

## License
MIT
