import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { methodOverrideMiddleware } from '../../src/middleware/methodOverride.js';

function createMockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    method: 'POST',
    headers: {},
    query: {},
    path: '/api/streams',
    id: 'test-req-id',
    ...overrides,
  } as any;
}

function createMockRes(): Partial<Response> & { _statusCode: number; _body: any } {
  const res: any = {
    _statusCode: 200,
    _body: undefined,
    status(code: number) {
      this._statusCode = code;
      return this;
    },
    json(body: any) {
      this._body = body;
      return this;
    },
  };
  return res;
}

describe('methodOverrideMiddleware', () => {
  it('does not override non-POST requests', () => {
    let nextCalled = false;
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('GET');
  });

  it('does not override POST without override header', () => {
    let nextCalled = false;
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('POST');
  });

  it('does not override POST with override header but no auth header', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: { 'x-http-method-override': 'DELETE' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    // Method should remain unchanged because no auth header is present
    expect(req.method).toBe('POST');
  });

  it('allows override with a valid auth header present (Authorization)', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'DELETE',
        authorization: 'Bearer garbage-token',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    // Method is rewritten — auth validity is checked downstream
    expect(req.method).toBe('DELETE');
  });

  it('allows override with X-API-Key header present (even if garbage)', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'PUT',
        'x-api-key': 'garbage-key',
      },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    // Method is rewritten — downstream auth will reject the garbage key
    expect(req.method).toBe('PUT');
  });

  it('allows override via query string _method parameter', () => {
    let nextCalled = false;
    const req = createMockReq({
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      query: { _method: 'PATCH' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    expect(req.method).toBe('PATCH');
  });

  it('rejects unsupported override methods with 400', () => {
    const req = createMockReq({
      method: 'POST',
      headers: {
        'x-http-method-override': 'GET',
        authorization: 'Bearer x',
      },
    });
    const res = createMockRes();
    const next = () => { throw new Error('next() should not be called'); };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(res._statusCode).toBe(400);
    expect(res._body?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('uses query _method only when header override is absent', () => {
    let nextCalled = false;
    // Query _method present but no auth header → gate prevents override
    const req = createMockReq({
      method: 'POST',
      headers: {},
      query: { _method: 'DELETE' },
    });
    const res = createMockRes();
    const next = () => { nextCalled = true; };

    methodOverrideMiddleware(req as Request, res as Response, next);

    expect(nextCalled).toBe(true);
    // Method remains POST — no credentials present to pass the gate
    expect(req.method).toBe('POST');
  });
});
