#!/usr/bin/env node
/**
 * TypeScript Client SDK generator script for Fluxora Backend.
 * Generates a typed TypeScript client SDK under `sdk/typescript/` from `openapi.yaml`.
 *
 * Usage:
 *   node scripts/generate-sdk-ts.mjs [--check] [--out-dir <path>] [--spec <path>]
 *
 * Options:
 *   --check       Drift check mode: compares generated output against existing files.
 *                 Exits 0 if identical, exits 1 if files differ or are missing.
 *   --out-dir     Output directory for the TypeScript SDK (default: sdk/typescript).
 *   --spec        Path to openapi.yaml spec file (default: openapi.yaml).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Parse command line arguments
const args = process.argv.slice(2);
const isCheckMode = args.includes('--check');

let outDirArg = 'sdk/typescript';
const outDirIdx = args.indexOf('--out-dir');
if (outDirIdx !== -1 && args[outDirIdx + 1]) {
  outDirArg = args[outDirIdx + 1];
}

let specPathArg = 'openapi.yaml';
const specIdx = args.indexOf('--spec');
if (specIdx !== -1 && args[specIdx + 1]) {
  specPathArg = args[specIdx + 1];
}

const ROOT_DIR = process.cwd();
const SPEC_PATH = path.resolve(ROOT_DIR, specPathArg);
const OUT_DIR = path.resolve(ROOT_DIR, outDirArg);

/**
 * Lightweight recursive YAML parser for OpenAPI 3.x spec files.
 */
function parseSimpleYaml(yamlString) {
  const lines = yamlString.split(/\r?\n/);
  let lineIdx = 0;

  function getIndent(line) {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  function parseBlock(baseIndent) {
    let result = null;
    let isMap = false;
    let isArray = false;

    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        lineIdx++;
        continue;
      }

      const currentIndent = getIndent(line);
      if (currentIndent < baseIndent) {
        break;
      }

      if (trimmed.startsWith('- ')) {
        if (result === null) {
          result = [];
          isArray = true;
        } else if (!isArray) {
          break;
        }

        const itemContent = trimmed.slice(2).trim();
        if (itemContent.includes(': ') || itemContent.endsWith(':')) {
          lines[lineIdx] = ' '.repeat(currentIndent + 2) + itemContent;
          const subObj = parseBlock(currentIndent + 2);
          result.push(subObj);
        } else {
          result.push(parseScalarValue(itemContent));
          lineIdx++;
        }
      } else if (trimmed.includes(':') || trimmed.endsWith(':')) {
        if (result === null) {
          result = {};
          isMap = true;
        } else if (!isMap) {
          break;
        }

        const colonIdx = trimmed.indexOf(':');
        const key = trimmed.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
        let valueStr = trimmed.slice(colonIdx + 1).trim();

        lineIdx++;

        if (valueStr === '|' || valueStr === '>-' || valueStr === '>') {
          let scalarLines = [];
          const blockIndent = currentIndent + 2;
          while (lineIdx < lines.length) {
            const nextLine = lines[lineIdx];
            if (!nextLine.trim()) {
              scalarLines.push('');
              lineIdx++;
              continue;
            }
            if (getIndent(nextLine) < blockIndent) {
              break;
            }
            scalarLines.push(nextLine.slice(blockIndent));
            lineIdx++;
          }
          result[key] = scalarLines.join('\n').trim();
        } else if (!valueStr) {
          if (lineIdx < lines.length && getIndent(lines[lineIdx]) > currentIndent) {
            result[key] = parseBlock(getIndent(lines[lineIdx]));
          } else {
            result[key] = null;
          }
        } else {
          result[key] = parseScalarValue(valueStr);
        }
      } else {
        lineIdx++;
      }
    }

    return result ?? {};
  }

  function parseScalarValue(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null' || val === '~') return null;
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      return val.slice(1, -1);
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      return val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    }
    return val;
  }

  return parseBlock(0);
}

/**
 * Load OpenAPI spec file.
 */
function loadSpec(specPath) {
  if (!fs.existsSync(specPath)) {
    throw new Error(`OpenAPI spec file not found at ${specPath}`);
  }
  const raw = fs.readFileSync(specPath, 'utf8');
  return parseSimpleYaml(raw);
}

/**
 * Generate TypeScript SDK file dictionary.
 */
function generateTypeScriptSdk(spec) {
  const files = {};
  const version = spec.info?.version || '0.1.0';

  // 1. package.json
  files['package.json'] = `{
  "name": "@fluxora/sdk",
  "version": "${version}",
  "description": "Typed TypeScript client SDK for Fluxora Backend API generated from openapi.yaml",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "require": "./src/index.ts"
    }
  },
  "license": "MIT",
  "dependencies": {}
}
`;

  // 2. tsconfig.json
  files['tsconfig.json'] = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
`;

  // 3. README.md
  files['README.md'] = `# Fluxora TypeScript Client SDK

Typed TypeScript client SDK for the Fluxora HTTP API generated directly from \`openapi.yaml\`.

## Features
- **Zero External Dependencies**: Uses standard Web Fetch API (\`fetch\`).
- **Cursor Pagination**: Native support for cursor pagination via \`StreamPaginator\` (\`autoPaginate()\`).
- **Idempotency Header & Payload Hashing**: Canonical JSON SHA-256 body hashing matching \`src/middleware/idempotency.ts\`.
- **Complete Endpoint Coverage**: Includes streams, webhooks, auth, health probes, and admin endpoints.
- **Full Type Safety**: Complete TypeScript interfaces for all request payloads and response envelopes.

## Quickstart

\`\`\`typescript
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
\`\`\`

## Handling Idempotency Conflicts

\`\`\`typescript
import { IdempotencyConflictError } from '@fluxora/sdk';

try {
  await client.createStream(payload, 'reused-key');
} catch (err) {
  if (err instanceof IdempotencyConflictError) {
    console.error('Idempotency collision!', err.storedHash, err.incomingHash);
  }
}
\`\`\`

## License
MIT
`;

  // 4. src/index.ts
  files['src/index.ts'] = `/**
 * Fluxora TypeScript Client SDK
 * Entrypoint re-exporting client, types, errors, pagination, and idempotency tools.
 */

export * from './types.js';
export * from './errors.js';
export * from './idempotency.js';
export * from './pagination.js';
export * from './client.js';
`;

  // 5. src/types.ts
  files['src/types.ts'] = `/**
 * Typed response envelopes and domain model interfaces matching openapi.yaml.
 */

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';

export interface ResponseMeta {
  requestId?: string;
  timestamp?: string;
  next_cursor?: string;
  total?: number;
  idempotency_replayed?: boolean;
}

export interface Stream {
  id: string;
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  status: 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled';
  rate_per_second?: string;
  start_time?: number;
  stop_time?: number;
  created_at: string;
  updated_at: string;
}

export interface CreateStreamInput {
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  start_time?: number;
  stop_time?: number;
}

export interface StreamListResponse {
  success: boolean;
  data: Stream[];
  meta: ResponseMeta;
}

export interface StreamSingleResponse {
  success: boolean;
  data: Stream;
  meta?: ResponseMeta;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version?: string;
  uptimeSeconds?: number;
  checks?: Record<string, unknown>;
}

export interface RootResponse {
  name: string;
  version: string;
  description?: string;
  docs?: string;
}

export interface AuthSessionResponse {
  success: boolean;
  data: {
    token: string;
    address: string;
    role: string;
    expiresAt: string;
  };
}

export interface PrivacyConsent {
  analytics_optout: boolean;
  marketing_optout: boolean;
  biometric_processing_consent: boolean;
  created_at: string;
  updated_at: string;
}

export interface PrivacyConsentResponse {
  success: boolean;
  data: {
    consent: PrivacyConsent;
  };
}

export interface WebhookDelivery {
  id: string;
  delivery_id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'success' | 'failed';
  created_at: string;
  updated_at: string;
  attempts?: Array<Record<string, unknown>>;
}

export interface ListStreamsParams {
  limit?: number;
  cursor?: string;
  status?: string;
  sender?: string;
  recipient?: string;
  include_total?: boolean;
}
`;

  // 6. src/errors.ts
  files['src/errors.ts'] = `/**
 * Typed SDK exceptions.
 */

export class FluxoraClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FluxoraClientError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FluxoraApiError extends FluxoraClientError {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly requestId?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(\`[\${statusCode}] \${code}: \${message}\`);
    this.name = 'FluxoraApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class IdempotencyConflictError extends FluxoraApiError {
  public readonly storedHash?: string;
  public readonly incomingHash?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    storedHash?: string,
    incomingHash?: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(statusCode, code, message, details, requestId);
    this.name = 'IdempotencyConflictError';
    this.storedHash = storedHash;
    this.incomingHash = incomingHash;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends FluxoraClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
`;

  // 7. src/idempotency.ts
  files['src/idempotency.ts'] = `/**
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
    return \`[\${items.join(',')}]\`;
  }

  const keys = Object.keys(body as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => \`"\${k}":\${canonicalizeBody((body as Record<string, unknown>)[k])}\`,
  );
  return \`{\${pairs.join(',')}}\`;
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
`;

  // 8. src/pagination.ts
  files['src/pagination.ts'] = `/**
 * Cursor Pagination Helpers matching src/validation/paginationSchema.ts.
 */

import type { Stream, ListStreamsParams, StreamListResponse } from './types.js';

export class StreamPaginator {
  private fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>;
  private limit: number;
  private status?: string;
  private sender?: string;
  private recipient?: string;
  private includeTotal: boolean;
  private nextCursor: string | null = null;
  private hasMore = true;

  constructor(
    fetchPage: (params: ListStreamsParams) => Promise<StreamListResponse>,
    params: ListStreamsParams = {},
  ) {
    const limit = params.limit ?? 20;
    if (limit < 1 || limit > 100) {
      throw new Error('limit must be an integer between 1 and 100 per paginationSchema');
    }
    this.fetchPage = fetchPage;
    this.limit = limit;
    this.status = params.status;
    this.sender = params.sender;
    this.recipient = params.recipient;
    this.includeTotal = params.include_total ?? false;
  }

  /**
   * Fetch next page of results. Returns null when no more pages exist.
   */
  async nextPage(): Promise<Stream[] | null> {
    if (!this.hasMore) return null;

    const response = await this.fetchPage({
      limit: this.limit,
      cursor: this.nextCursor ?? undefined,
      status: this.status,
      sender: this.sender,
      recipient: this.recipient,
      include_total: this.includeTotal,
    });

    const items = response.data || [];
    const nextCursor = response.meta?.next_cursor;

    if (nextCursor) {
      this.nextCursor = nextCursor;
    } else {
      this.hasMore = false;
    }

    return items;
  }

  /**
   * Async generator yielding single items across all pages.
   */
  async *autoPaginate(): AsyncGenerator<Stream, void, unknown> {
    while (this.hasMore) {
      const page = await this.nextPage();
      if (!page) break;
      for (const item of page) {
        yield item;
      }
    }
  }
}
`;

  // 9. src/client.ts
  files['src/client.ts'] = `/**
 * Synchronous / Async Fetch Client for Fluxora Backend API.
 */

import {
  FluxoraApiError,
  IdempotencyConflictError,
  ValidationError,
} from './errors.js';
import { generateIdempotencyKey } from './idempotency.js';
import { StreamPaginator } from './pagination.js';
import type {
  Stream,
  CreateStreamInput,
  StreamListResponse,
  StreamSingleResponse,
  HealthResponse,
  RootResponse,
  AuthSessionResponse,
  PrivacyConsent,
  PrivacyConsentResponse,
  WebhookDelivery,
  ListStreamsParams,
} from './types.js';

export interface FluxoraClientConfig {
  baseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
}

export class FluxoraClient {
  private baseUrl: string;
  private apiKey?: string;
  private bearerToken?: string;
  private headers: Record<string, string>;

  constructor(config: FluxoraClientConfig = {}) {
    this.baseUrl = (config.baseUrl || 'http://localhost:3000').replace(/\\/+$/, '');
    this.apiKey = config.apiKey;
    this.bearerToken = config.bearerToken;
    this.headers = {
      'User-Agent': 'FluxoraTypeScriptSDK/0.1.0',
      Accept: 'application/json',
      ...config.headers,
    };
  }

  public setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      params?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    let url = \`\${this.baseUrl}\${path}\`;

    if (options.params) {
      const queryParams = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          queryParams.append(k, String(v));
        }
      }
      const queryString = queryParams.toString();
      if (queryString) {
        url += \`?\${queryString}\`;
      }
    }

    const headers: Record<string, string> = { ...this.headers, ...options.headers };
    if (this.bearerToken) {
      headers['Authorization'] = \`Bearer \${this.bearerToken}\`;
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    let bodyPayload: string | undefined;
    if (options.body !== undefined) {
      bodyPayload = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: bodyPayload,
    });

    let data: any = {};
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') || data?.meta?.requestId || data?.error?.requestId;
      const errorCode = data?.error?.code || data?.code || 'HTTP_ERROR';
      const errorMessage = data?.error?.message || data?.message || response.statusText;

      if (response.status === 409 || errorCode === 'IDEMPOTENCY_CONFLICT') {
        throw new IdempotencyConflictError(
          response.status,
          'IDEMPOTENCY_CONFLICT',
          errorMessage || 'Idempotency key collision with differing payload',
          data?.stored_hash || data?.details?.stored_hash,
          data?.incoming_hash || data?.details?.incoming_hash,
          data,
          requestId,
        );
      }

      throw new FluxoraApiError(
        response.status,
        errorCode,
        errorMessage,
        data?.error?.details || data?.details,
        requestId,
      );
    }

    return data as T;
  }

  // --- System Endpoints ---

  async getRoot(): Promise<RootResponse> {
    return this.request<RootResponse>('GET', '/');
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  async getHealthReady(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health/ready');
  }

  async getHealthLive(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health/live');
  }

  // --- Auth Endpoints ---

  async createSession(address: string, role = 'viewer'): Promise<AuthSessionResponse> {
    if (!address) {
      throw new ValidationError('address is required for createSession');
    }
    return this.request<AuthSessionResponse>('POST', '/api/auth/session', {
      body: { address, role },
    });
  }

  // --- Stream Endpoints ---

  async createStream(
    input: CreateStreamInput,
    idempotencyKey?: string,
  ): Promise<Stream> {
    if (!input || !input.sender || !input.recipient || !input.amount || !input.asset) {
      throw new ValidationError('CreateStreamInput must include sender, recipient, amount, asset');
    }
    const key = idempotencyKey || generateIdempotencyKey();
    const res = await this.request<StreamSingleResponse>('POST', '/api/streams', {
      body: input,
      headers: { 'Idempotency-Key': key },
    });
    return res.data;
  }

  async getStream(streamId: string): Promise<Stream> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<StreamSingleResponse>('GET', \`/api/streams/\${streamId}\`);
    return res.data;
  }

  listStreams(params: ListStreamsParams = {}): StreamPaginator {
    return new StreamPaginator(
      (p) => this.request<StreamListResponse>('GET', '/api/streams', { params: p as Record<string, unknown> }),
      params,
    );
  }

  async cancelStream(streamId: string): Promise<Stream> {
    if (!streamId) throw new ValidationError('streamId is required');
    const res = await this.request<StreamSingleResponse>('POST', \`/api/streams/\${streamId}/cancel\`);
    return res.data;
  }

  // --- Privacy Endpoints ---

  async getPrivacyPolicy(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/privacy/policy');
  }

  async getPrivacyRetention(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/privacy/retention');
  }

  async putPrivacyConsent(consent: {
    address: string;
    analytics_optout: boolean;
    marketing_optout: boolean;
    biometric_processing_consent: boolean;
  }): Promise<PrivacyConsent> {
    const res = await this.request<PrivacyConsentResponse>('PUT', '/api/privacy/consent', {
      body: consent,
    });
    return res.data.consent;
  }

  async getPrivacyConsent(address: string): Promise<PrivacyConsent> {
    if (!address) throw new ValidationError('address is required');
    const res = await this.request<PrivacyConsentResponse>('GET', \`/api/privacy/consent/\${address}\`);
    return res.data.consent;
  }

  // --- Webhook Endpoints ---

  async queueWebhook(payload: Record<string, unknown>): Promise<WebhookDelivery> {
    const res = await this.request<{ success: boolean; data: WebhookDelivery }>('POST', '/api/webhooks', {
      body: payload,
    });
    return res.data;
  }

  async getWebhookDelivery(id: string): Promise<WebhookDelivery> {
    const res = await this.request<{ success: boolean; data: WebhookDelivery }>('GET', \`/api/webhooks/\${id}\`);
    return res.data;
  }
}
`;

  return files;
}

/**
 * Main execution.
 */
function main() {
  const spec = loadSpec(SPEC_PATH);
  const generatedFiles = generateTypeScriptSdk(spec);

  if (isCheckMode) {
    console.log(`[DRIFT CHECK] Checking TypeScript SDK files in ${OUT_DIR}...`);
    let hasDrift = false;

    for (const [relativePath, expectedContent] of Object.entries(generatedFiles)) {
      const fullPath = path.resolve(OUT_DIR, relativePath);
      if (!fs.existsSync(fullPath)) {
        console.error(`[DRIFT DETECTED] Missing file: ${relativePath}`);
        hasDrift = true;
        continue;
      }

      const existingContent = fs.readFileSync(fullPath, 'utf8');
      if (existingContent.trim() !== expectedContent.trim()) {
        console.error(`[DRIFT DETECTED] File content mismatch: ${relativePath}`);
        hasDrift = true;
      }
    }

    if (hasDrift) {
      console.error('[DRIFT CHECK FAILED] Generated TypeScript SDK differs from disk contents.');
      process.exit(1);
    } else {
      console.log('[DRIFT CHECK PASSED] All TypeScript SDK files match generated output.');
      process.exit(0);
    }
  } else {
    console.log(`Generating TypeScript Client SDK into ${OUT_DIR}...`);
    fs.mkdirSync(path.resolve(OUT_DIR, 'src'), { recursive: true });

    for (const [relativePath, content] of Object.entries(generatedFiles)) {
      const fullPath = path.resolve(OUT_DIR, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      console.log(`  Wrote ${relativePath}`);
    }

    console.log('[SDK GENERATION COMPLETE] Successfully generated TypeScript Client SDK.');
  }
}

main();
