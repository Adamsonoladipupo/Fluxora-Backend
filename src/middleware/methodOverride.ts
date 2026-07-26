import type { Request, Response, NextFunction } from 'express';
import { info } from '../utils/logger.js';
import { ApiErrorCode } from './errorHandler.js';

/**
 * Middleware that rewrites req.method to the value of X-HTTP-Method-Override
 * (or ?_method=) when the original request is a POST.
 *
 * Security: This middleware runs *before* the actual auth middleware in the
 * Express chain. It gates on the mere *presence* of a credential header
 * (Authorization or X-API-Key) — not its validity. The real authentication
 * check still runs downstream (per-route) and will reject invalid credentials
 * regardless of any method rewrite. This gate exists only to prevent
 * unauthenticated callers from casually using the override mechanism;
 * actual security is enforced by the downstream auth middleware.
 *
 * Restricted to a safe allowlist (PATCH, DELETE, PUT).
 *
 * IMPORTANT: If this middleware is ever moved to run after authentication,
 * replace `hasAuth` with a real `req.auth` / `res.locals.authenticated` check.
 */
export function methodOverrideMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only override POST requests
  if (req.method !== 'POST') {
    return next();
  }

  // Retrieve override method from header or query string
  const overrideMethod = req.headers['x-http-method-override'] || req.query._method;
  if (!overrideMethod) {
    return next();
  }

  // Gate: require a credential header to be present. Validity is NOT checked
  // here — downstream auth middleware enforces that. This prevents casual
  // override attempts by unauthenticated callers but trusts the auth layer
  // for real enforcement.
  const hasCredentialHeader = Boolean(req.headers.authorization || req.headers['x-api-key']);
  if (!hasCredentialHeader) {
    return next();
  }

  const method = (Array.isArray(overrideMethod) ? overrideMethod[0] : overrideMethod) as string;
  const upperMethod = method.toUpperCase();

  const allowed = ['PATCH', 'DELETE', 'PUT'];
  if (!allowed.includes(upperMethod)) {
    // Requirements state we must reject override attempts to unsupported methods with a 400
    res.status(400).json({
      error: {
        code: ApiErrorCode.VALIDATION_ERROR,
        message: 'Unsupported method override',
      }
    });
    return;
  }

  info('HTTP method overridden', {
    originalMethod: 'POST',
    effectiveMethod: upperMethod,
    path: req.path,
    requestId: req.id,
  });

  req.method = upperMethod;
  next();
}
