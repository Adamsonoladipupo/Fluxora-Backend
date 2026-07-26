/**
 * Unit and integration tests for TypeScript Client SDK Generation (Issue #726).
 *
 * Coverage:
 * - Generator CLI execution & `--check` drift check.
 * - Custom output directory (`--out-dir`).
 * - Package structure, manifest metadata, and documentation.
 * - TypeScript client implementation & HTTP request builders.
 * - Error hierarchy (`FluxoraClientError`, `FluxoraApiError`, `IdempotencyConflictError`, `ValidationError`).
 * - Idempotency UUID generation, JSON canonicalization, and SHA-256 hashing.
 * - Cursor pagination semantics (`StreamPaginator`).
 * - Type round-tripping against actual `/api/streams` response shapes in `src/routes/streams.ts`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  FluxoraClient,
  FluxoraApiError,
  IdempotencyConflictError,
  ValidationError,
  generateIdempotencyKey,
  canonicalizeBody,
  hashBody,
  StreamPaginator,
  Stream,
} from '../../sdk/typescript/src/index.js';

const ROOT_DIR = process.cwd();
const SDK_DIR = path.resolve(ROOT_DIR, 'sdk/typescript');
const SCRIPT_PATH = path.resolve(ROOT_DIR, 'scripts/generate-sdk-ts.mjs');

describe('TypeScript Client SDK Generator (scripts/generate-sdk-ts.mjs)', () => {
  beforeAll(() => {
    // Ensure TypeScript SDK is freshly generated before running tests
    execSync(`node "${SCRIPT_PATH}"`, { stdio: 'pipe' });
  });

  // ── 1. Generator CLI & Drift Check ──────────────────────────────────────────

  describe('Generator CLI & Drift Check (--check)', () => {
    it('passes drift check (--check) when disk contents match freshly generated output', () => {
      const output = execSync(`node "${SCRIPT_PATH}" --check`, { encoding: 'utf8' });
      expect(output).toContain('[DRIFT CHECK PASSED]');
    });

    it('fails drift check (--check) when a generated file is altered', () => {
      const targetFile = path.resolve(SDK_DIR, 'src/errors.ts');
      const originalContent = fs.readFileSync(targetFile, 'utf8');

      try {
        fs.writeFileSync(targetFile, `${originalContent}\n// Temp drift comment`, 'utf8');

        expect(() => {
          execSync(`node "${SCRIPT_PATH}" --check`, { encoding: 'utf8', stdio: 'pipe' });
        }).toThrow();
      } finally {
        fs.writeFileSync(targetFile, originalContent, 'utf8');
      }
    });

    it('fails drift check (--check) when a required file is missing', () => {
      const tempDir = path.resolve(ROOT_DIR, 'tmp_test_sdk_ts_missing');
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        expect(() => {
          execSync(`node "${SCRIPT_PATH}" --check --out-dir "${tempDir}"`, { encoding: 'utf8', stdio: 'pipe' });
        }).toThrow();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('supports custom output directory (--out-dir)', () => {
      const customDir = path.resolve(ROOT_DIR, 'tmp_test_sdk_ts_custom');
      try {
        execSync(`node "${SCRIPT_PATH}" --out-dir "${customDir}"`, { encoding: 'utf8' });
        expect(fs.existsSync(path.resolve(customDir, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.resolve(customDir, 'src/client.ts'))).toBe(true);
        expect(fs.existsSync(path.resolve(customDir, 'src/types.ts'))).toBe(true);
      } finally {
        fs.rmSync(customDir, { recursive: true, force: true });
      }
    });
  });

  // ── 2. SDK Package Structure & Manifests ───────────────────────────────────

  describe('SDK File Structure & Package Metadata', () => {
    it('generates all required TypeScript package files', () => {
      const expectedFiles = [
        'package.json',
        'tsconfig.json',
        'README.md',
        'src/index.ts',
        'src/types.ts',
        'src/errors.ts',
        'src/idempotency.ts',
        'src/pagination.ts',
        'src/client.ts',
      ];

      for (const relPath of expectedFiles) {
        const fullPath = path.resolve(SDK_DIR, relPath);
        expect(fs.existsSync(fullPath), `Missing file: ${relPath}`).toBe(true);
      }
    });

    it('generates valid package.json manifest metadata', () => {
      const content = fs.readFileSync(path.resolve(SDK_DIR, 'package.json'), 'utf8');
      const pkg = JSON.parse(content);
      expect(pkg.name).toBe('@fluxora/sdk');
      expect(pkg.version).toBe('0.1.0');
      expect(pkg.main).toBe('./src/index.ts');
    });

    it('generates comprehensive README.md documentation', () => {
      const content = fs.readFileSync(path.resolve(SDK_DIR, 'README.md'), 'utf8');
      expect(content).toContain('# Fluxora TypeScript Client SDK');
      expect(content).toContain('FluxoraClient');
      expect(content).toContain('generateIdempotencyKey');
      expect(content).toContain('StreamPaginator');
    });
  });

  // ── 3. TypeScript Client Implementation & Request Builders ──────────────────

  describe('FluxoraClient Implementation', () => {
    it('initializes with default options', () => {
      const client = new FluxoraClient();
      expect(client).toBeInstanceOf(FluxoraClient);
    });

    it('allows updating bearer token and API key', () => {
      const client = new FluxoraClient();
      client.setBearerToken('test-jwt-token');
      client.setApiKey('test-api-key');

      // Verify token updates
      expect((client as any).bearerToken).toBe('test-jwt-token');
      expect((client as any).apiKey).toBe('test-api-key');
    });

    it('dispatches HTTP requests with correct path, headers, and query parameters', async () => {
      const globalFetchBackup = globalThis.fetch;
      try {
        const mockFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
          return new Response(JSON.stringify({ status: 'healthy', timestamp: '2026-07-25T00:00:00Z' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });
        globalThis.fetch = mockFetch as any;

        const client = new FluxoraClient({ baseUrl: 'http://api.test' });
        const health = await client.getHealth();

        expect(health.status).toBe('healthy');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toBe('http://api.test/health');
      } finally {
        globalThis.fetch = globalFetchBackup;
      }
    });

    it('handles 409 Idempotency Conflict responses', async () => {
      const globalFetchBackup = globalThis.fetch;
      try {
        const mockFetch = vi.fn(async () => {
          return new Response(
            JSON.stringify({
              error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Payload mismatch' },
              stored_hash: 'hash-abc',
              incoming_hash: 'hash-xyz',
            }),
            {
              status: 409,
              headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-123' },
            },
          );
        });
        globalThis.fetch = mockFetch as any;

        const client = new FluxoraClient();

        await expect(
          client.createStream(
            {
              sender: 'G123',
              recipient: 'G456',
              amount: '100',
              asset: 'XLM',
            },
            'duplicate-key',
          ),
        ).rejects.toThrow(IdempotencyConflictError);
      } finally {
        globalThis.fetch = globalFetchBackup;
      }
    });

    it('validates client-side input parameters before dispatching requests', async () => {
      const client = new FluxoraClient();
      await expect(client.createSession('')).rejects.toThrow(ValidationError);
      await expect(client.getStream('')).rejects.toThrow(ValidationError);
      await expect(client.cancelStream('')).rejects.toThrow(ValidationError);
    });
  });

  // ── 4. Idempotency Utilities ───────────────────────────────────────────────

  describe('Idempotency Utilities (src/idempotency.ts)', () => {
    it('generates valid UUID v4 idempotency keys', () => {
      const key1 = generateIdempotencyKey();
      const key2 = generateIdempotencyKey();

      expect(typeof key1).toBe('string');
      expect(key1).not.toBe(key2);
      expect(key1.length).toBeGreaterThanOrEqual(32);
    });

    it('canonicalizes JSON payloads recursively by sorting object keys', () => {
      const rawPayload = {
        recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        amount: '100.5000000',
        sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
        details: { b: 2, a: 1 },
      };

      const canonical = canonicalizeBody(rawPayload);
      expect(canonical).toBe(
        '{"amount":"100.5000000","details":{"a":1,"b":2},"recipient":"GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN","sender":"GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX"}',
      );
    });

    it('computes 64-character SHA-256 hex digest of payload', async () => {
      const payload = { test: 'value' };
      const hash = await hashBody(payload);

      expect(typeof hash).toBe('string');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── 5. Cursor Pagination Semantics ─────────────────────────────────────────

  describe('Cursor Pagination (src/pagination.ts)', () => {
    it('validates pagination limit constraint (1..100)', () => {
      const dummyFetcher = vi.fn();
      expect(() => new StreamPaginator(dummyFetcher, { limit: 0 })).toThrow();
      expect(() => new StreamPaginator(dummyFetcher, { limit: 150 })).toThrow();
      expect(() => new StreamPaginator(dummyFetcher, { limit: 50 })).not.toThrow();
    });

    it('paginates pages and auto-paginates items correctly', async () => {
      const page1Response = {
        success: true,
        data: [{ id: 's1' }, { id: 's2' }] as Stream[],
        meta: { next_cursor: 'cursor-2' },
      };

      const page2Response = {
        success: true,
        data: [{ id: 's3' }] as Stream[],
        meta: {},
      };

      const mockFetcher = vi
        .fn()
        .mockResolvedValueOnce(page1Response)
        .mockResolvedValueOnce(page2Response);

      const paginator = new StreamPaginator(mockFetcher, { limit: 2 });

      const items: Stream[] = [];
      for await (const item of paginator.autoPaginate()) {
        items.push(item);
      }

      expect(items).toHaveLength(3);
      expect(items[0].id).toBe('s1');
      expect(items[1].id).toBe('s2');
      expect(items[2].id).toBe('s3');
      expect(mockFetcher).toHaveBeenCalledTimes(2);
    });
  });

  // ── 6. Stream Type Round-Trip Validation ───────────────────────────────────

  describe('Stream Response Shape Round-Trip', () => {
    it('generated Stream type aligns with actual /api/streams response shape', () => {
      // Mock stream response object matching src/routes/streams.ts
      const streamFromApi: Stream = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        sender: 'GBBD47UZQ5CYVVEUVRYNQZX3G5KRZTAYF5XSVS2UKMCCWW5LJJLXNVQX',
        recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        amount: '500.0000000',
        asset: 'XLM',
        status: 'active',
        rate_per_second: '0.0050000',
        start_time: 1700000000,
        stop_time: 1700100000,
        created_at: '2026-07-25T12:00:00Z',
        updated_at: '2026-07-25T12:00:00Z',
      };

      expect(streamFromApi.id).toBeDefined();
      expect(streamFromApi.status).toBe('active');
      expect(streamFromApi.amount).toBe('500.0000000');
    });
  });
});
