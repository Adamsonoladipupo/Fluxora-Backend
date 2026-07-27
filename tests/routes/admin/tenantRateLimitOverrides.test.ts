import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { tenantRateLimitOverridesRouter } from '../../../src/routes/admin/tenantRateLimitOverrides.js';
import * as overrideService from '../../../src/services/tenantRateLimitOverride.service.js';
import { ApiError } from '../../../src/errors.js';

const ADMIN_KEY = 'test-admin-key-for-overrides';

function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${ADMIN_KEY}`);
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/', tenantRateLimitOverridesRouter);
  return app;
}

describe('Admin rate-limit override endpoints', () => {
  let prevAdminKey: string | undefined;

  beforeEach(() => {
    prevAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevAdminKey;
  });

  describe('POST /', () => {
    it('creates override — returns 201', async () => {
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue(null);
      vi.spyOn(overrideService, 'createOverride').mockResolvedValue({
        id: 'new-override-1',
        keyId: 'key-1',
        maxRequests: 5000,
        windowMs: 60000,
        expiresAt: null,
        createdBy: `admin:${ADMIN_KEY.slice(0, 8)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.keyId).toBe('key-1');
      expect(res.body.data.maxRequests).toBe(5000);
    });

    it('returns 409 when override already exists', async () => {
      vi.spyOn(overrideService, 'getOverride').mockResolvedValue({
        id: 'existing',
        keyId: 'key-1',
        maxRequests: 1000,
        windowMs: 60000,
        expiresAt: null,
        createdBy: 'admin:test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
        }),
      );

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid body', async () => {
      const res = await authed(
        request(createTestApp()).post('/').send({
          keyId: '',
          maxRequests: -1,
          windowMs: 500,
        }),
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 without admin auth', async () => {
      const res = await request(createTestApp()).post('/').send({
        keyId: 'key-1',
        maxRequests: 5000,
        windowMs: 60000,
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /', () => {
    it('returns all overrides', async () => {
      vi.spyOn(overrideService, 'listOverrides').mockResolvedValue([
        {
          id: 'override-1',
          keyId: 'key-1',
          maxRequests: 5000,
          windowMs: 60000,
          expiresAt: null,
          createdBy: 'admin:test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'override-2',
          keyId: 'key-2',
          maxRequests: 10000,
          windowMs: 120000,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          createdBy: 'admin:test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      const res = await authed(request(createTestApp()).get('/'));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 401 without admin auth', async () => {
      const res = await request(createTestApp()).get('/');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes correctly — returns 204', async () => {
      vi.spyOn(overrideService, 'deleteOverride').mockResolvedValue(undefined);

      const res = await authed(request(createTestApp()).delete('/override-1'));
      expect(res.status).toBe(204);
    });

    it('returns 404 for nonexistent ID', async () => {
      vi.spyOn(overrideService, 'deleteOverride').mockRejectedValue(
        new ApiError(404, 'NOT_FOUND', 'Override not found: nonexistent'),
      );

      const res = await authed(request(createTestApp()).delete('/nonexistent'));
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 without admin auth', async () => {
      const res = await request(createTestApp()).delete('/override-1');
      expect(res.status).toBe(401);
    });
  });
});
