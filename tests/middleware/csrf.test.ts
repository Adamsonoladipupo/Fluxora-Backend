import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  csrfMiddleware,
  isCookieAuthenticated,
  parseCookies,
  safeCompareCsrfTokens,
  generateCsrfToken,
  setCsrfCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from '../../src/middleware/csrf.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

describe('CSRF Middleware Utilities', () => {
  describe('parseCookies', () => {
    it('returns empty object when header is undefined or empty', () => {
      expect(parseCookies(undefined)).toEqual({});
      expect(parseCookies('')).toEqual({});
    });

    it('parses single cookie pair', () => {
      expect(parseCookies('foo=bar')).toEqual({ foo: 'bar' });
    });

    it('parses multiple cookie pairs', () => {
      const header = 'session=12345; fluxora_csrf=abc-secret-token; theme=dark';
      expect(parseCookies(header)).toEqual({
        session: '12345',
        fluxora_csrf: 'abc-secret-token',
        theme: 'dark',
      });
    });

    it('handles encoded values correctly', () => {
      const token = encodeURIComponent('special value = % &');
      expect(parseCookies(`fluxora_csrf=${token}`)).toEqual({
        fluxora_csrf: 'special value = % &',
      });
    });

    it('gracefully handles malformed URI components', () => {
      expect(parseCookies('fluxora_csrf=%E0%A4%A')).toEqual({
        fluxora_csrf: '%E0%A4%A',
      });
    });
  });

  describe('isCookieAuthenticated', () => {
    it('returns false when Authorization header (Bearer) is present', () => {
      const req = {
        headers: {
          authorization: 'Bearer valid-jwt-token',
          cookie: 'session=12345',
        },
      } as unknown as Request;
      expect(isCookieAuthenticated(req)).toBe(false);
    });

    it('returns false when X-API-Key header is present', () => {
      const req = {
        headers: {
          'x-api-key': 'flx_test_key_123',
          cookie: 'session=12345',
        },
      } as unknown as Request;
      expect(isCookieAuthenticated(req)).toBe(false);
    });

    it('returns false when no Cookie header is present', () => {
      const req = {
        headers: {},
      } as unknown as Request;
      expect(isCookieAuthenticated(req)).toBe(false);
    });

    it('returns true when Cookie header is present and no Bearer/API-key header is set', () => {
      const req = {
        headers: {
          cookie: 'session=12345; fluxora_csrf=secret',
        },
      } as unknown as Request;
      expect(isCookieAuthenticated(req)).toBe(true);
    });
  });

  describe('safeCompareCsrfTokens', () => {
    it('returns true for matching tokens in constant time', () => {
      const token = 'a'.repeat(64);
      expect(safeCompareCsrfTokens(token, token)).toBe(true);
    });

    it('returns false for mismatched tokens of same length', () => {
      const tokenA = 'a'.repeat(64);
      const tokenB = 'b'.repeat(64);
      expect(safeCompareCsrfTokens(tokenA, tokenB)).toBe(false);
    });

    it('returns false for tokens of different lengths without throwing', () => {
      expect(safeCompareCsrfTokens('short', 'longer-token-string')).toBe(false);
    });

    it('returns false if either token is missing or empty', () => {
      expect(safeCompareCsrfTokens(undefined, 'token')).toBe(false);
      expect(safeCompareCsrfTokens('token', undefined)).toBe(false);
      expect(safeCompareCsrfTokens('', '')).toBe(false);
    });
  });

  describe('generateCsrfToken and setCsrfCookie', () => {
    it('generates a 64-character hex CSRF token', () => {
      const token1 = generateCsrfToken();
      const token2 = generateCsrfToken();
      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).not.toEqual(token2);
    });

    it('sets Set-Cookie header on response', () => {
      const resHeader: Record<string, string[]> = { 'set-cookie': [] };
      const res = {
        append: (name: string, val: string) => {
          if (name.toLowerCase() === 'set-cookie') {
            resHeader['set-cookie'].push(val);
          }
        },
      } as unknown as Response;

      setCsrfCookie(res, 'my-token-123', { secure: true, sameSite: 'strict' });
      expect(resHeader['set-cookie']).toHaveLength(1);
      expect(resHeader['set-cookie'][0]).toContain(`${CSRF_COOKIE_NAME}=my-token-123`);
      expect(resHeader['set-cookie'][0]).toContain('SameSite=strict');
      expect(resHeader['set-cookie'][0]).toContain('Secure');
    });
  });
});

describe('CSRF Middleware Integration Tests', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(csrfMiddleware);

    app.get('/api/streams', (_req: Request, res: Response) => {
      res.json({ success: true, action: 'read' });
    });

    app.post('/api/streams', (_req: Request, res: Response) => {
      res.json({ success: true, action: 'create' });
    });

    app.patch('/api/streams/:id', (_req: Request, res: Response) => {
      res.json({ success: true, action: 'update' });
    });

    app.delete('/api/streams/:id', (_req: Request, res: Response) => {
      res.json({ success: true, action: 'delete' });
    });

    app.use(errorHandler);
  });

  it('allows safe HTTP GET requests without CSRF tokens even with cookie session', async () => {
    const res = await request(app)
      .get('/api/streams')
      .set('Cookie', 'session=user_session_123');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'read' });
  });

  it('allows Bearer token authenticated mutating POST requests without CSRF tokens', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('Authorization', 'Bearer sample_jwt_token')
      .set('Cookie', 'session=user_session_123')
      .send({ name: 'test stream' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'create' });
  });

  it('allows API key authenticated mutating POST requests without CSRF tokens', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('X-API-Key', 'flx_test_key_abc123')
      .set('Cookie', 'session=user_session_123')
      .send({ name: 'test stream' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'create' });
  });

  it('blocks cookie-authenticated POST request when fluxora_csrf cookie is missing', async () => {
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', 'session=user_session_123')
      .set('X-CSRF-Token', 'some_token')
      .send({ name: 'test stream' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks cookie-authenticated POST request when X-CSRF-Token header is missing', async () => {
    const token = generateCsrfToken();
    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=user_session_123; ${CSRF_COOKIE_NAME}=${token}`)
      .send({ name: 'test stream' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('CSRF token missing');
  });

  it('blocks cookie-authenticated POST request when tokens do not match', async () => {
    const tokenCookie = generateCsrfToken();
    const tokenHeader = generateCsrfToken();

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=user_session_123; ${CSRF_COOKIE_NAME}=${tokenCookie}`)
      .set('X-CSRF-Token', tokenHeader)
      .send({ name: 'test stream' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('CSRF token mismatch');
  });

  it('allows cookie-authenticated POST request when fluxora_csrf cookie and X-CSRF-Token header match', async () => {
    const token = generateCsrfToken();

    const res = await request(app)
      .post('/api/streams')
      .set('Cookie', `session=user_session_123; ${CSRF_COOKIE_NAME}=${token}`)
      .set(CSRF_HEADER_NAME, token)
      .send({ name: 'test stream' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'create' });
  });

  it('allows cookie-authenticated PATCH request when tokens match', async () => {
    const token = generateCsrfToken();

    const res = await request(app)
      .patch('/api/streams/s_123')
      .set('Cookie', `session=user_session_123; ${CSRF_COOKIE_NAME}=${token}`)
      .set('x-csrf-token', token)
      .send({ name: 'updated stream' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'update' });
  });

  it('allows cookie-authenticated DELETE request when tokens match', async () => {
    const token = generateCsrfToken();

    const res = await request(app)
      .delete('/api/streams/s_123')
      .set('Cookie', `session=user_session_123; ${CSRF_COOKIE_NAME}=${token}`)
      .set('X-CSRF-Token', token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'delete' });
  });
});
