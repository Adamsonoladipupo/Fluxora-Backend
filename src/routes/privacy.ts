/**
 * Privacy policy and consent-preference endpoints.
 *
 * Exposes the PII policy, data classification schema, retention schedule,
 * trust boundaries, and CCPA/BIPA-style recipient consent preferences as
 * machine-readable JSON.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  STREAM_FIELD_POLICIES,
  REQUEST_FIELD_POLICIES,
  RETENTION_SCHEDULE,
  TRUST_BOUNDARIES,
  DataClassification,
} from '../pii/policy.js';
import { computeAddressHash } from '../pii/pgcryptoEncryption.js';
import { getPool, query, PoolExhaustedError } from '../db/pool.js';
import { loadConfig } from '../config/env.js';
import {
  PrivacyConsentSchema,
  parseBody,
  formatZodIssues,
  type PrivacyConsentInput,
} from '../validation/schemas.js';
import {
  asyncHandler,
  notFound,
  serviceUnavailable,
  validationError,
} from '../middleware/errorHandler.js';
import { successResponse } from '../utils/response.js';

export const privacyRouter = Router();

const SERVICE_NAME = 'fluxora-backend';
const SERVICE_VERSION = '0.1.0';
const PrivacyConsentAddressSchema = PrivacyConsentSchema.pick({ address: true });

interface PrivacyConsentRow extends Record<string, unknown> {
  analytics_optout: boolean | string;
  marketing_optout: boolean | string;
  biometric_processing_consent: boolean | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PrivacyConsentResponse {
  analytics_optout: boolean;
  marketing_optout: boolean;
  biometric_processing_consent: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Middleware: set security and cache headers on every privacy response.
 *
 * Policy and consent documents must not be cached by intermediaries. Consent
 * state is recipient-specific and may be updated at any time.
 */
function privacyHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

privacyRouter.use(privacyHeaders);

/** Build a route-scoped 405 handler with an explicit Allow header. */
function rejectUnsupportedMethods(allowedMethods: string[]) {
  return (req: Request, res: Response): void => {
    const allow = allowedMethods.join(', ');
    res.setHeader('Allow', allow);
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `${req.method} is not allowed on this resource`,
      },
    });
  };
}

/** Wrap DB errors so pool exhaustion surfaces as a retryable 503. */
function wrapPrivacyDbError(err: unknown): never {
  if (
    err instanceof PoolExhaustedError ||
    (err && (err as Error).name === 'PoolExhaustedError')
  ) {
    throw serviceUnavailable('Privacy consent storage is temporarily unavailable. Please retry shortly.');
  }
  throw err;
}

/** Convert a pg timestamp value into a stable ISO-8601 string. */
function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Convert pg boolean values without trusting string truthiness. */
function toBoolean(value: boolean | string): boolean {
  return value === true || value === 'true';
}

/** Map a database row to the public consent representation without address data. */
function toConsentResponse(row: PrivacyConsentRow): PrivacyConsentResponse {
  return {
    analytics_optout: toBoolean(row.analytics_optout),
    marketing_optout: toBoolean(row.marketing_optout),
    biometric_processing_consent: toBoolean(row.biometric_processing_consent),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

/**
 * Resolve the active address-hashing key.
 *
 * @security The key is never returned to clients or logged. If it is missing,
 * the consent endpoint fails closed rather than storing plaintext addresses.
 */
function resolvePgcryptoKey(req: Request): string {
  const localConfig = req.app.locals.config as { pgcryptoKey?: string } | undefined;
  const key = localConfig ? localConfig.pgcryptoKey : loadConfig().pgcryptoKey;

  if (!key) {
    throw serviceUnavailable('Privacy consent storage is temporarily unavailable. Please retry shortly.');
  }

  return key;
}

/** Compute the deterministic consent lookup key without storing plaintext. */
function computeConsentAddressHash(req: Request, address: string): string {
  return computeAddressHash(address, resolvePgcryptoKey(req));
}

/** Parse and validate a consent write body through the shared Zod schema. */
function parseConsentBody(body: unknown): PrivacyConsentInput {
  const parsed = parseBody(PrivacyConsentSchema, body ?? {});

  if (!parsed.success) {
    const formatted = formatZodIssues(parsed.issues);
    throw validationError(
      formatted[0]?.message ?? 'Invalid consent preferences',
      { errors: formatted },
    );
  }

  return parsed.data;
}

/** Parse and validate a Stellar address path parameter. */
function parseConsentAddressParam(address: unknown): string {
  const parsed = parseBody(PrivacyConsentAddressSchema, { address });

  if (!parsed.success) {
    const formatted = formatZodIssues(parsed.issues);
    throw validationError(
      formatted[0]?.message ?? 'Invalid Stellar address',
      { errors: formatted },
    );
  }

  return parsed.data.address;
}

/**
 * GET /api/privacy/policy
 *
 * Returns the full PII policy document: field classifications,
 * retention schedule, and trust boundaries.
 */
privacyRouter.get('/policy', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    piiPolicy: {
      summary:
        'Fluxora stores only chain-derived pseudonymous data (Stellar public keys and ' +
        'on-chain amounts). No direct PII such as names, emails, or physical addresses ' +
        'is collected. HTTP request metadata (IP, user-agent) is ephemeral and never persisted.',
      dataClassifications: Object.values(DataClassification).map((level) => ({
        level,
        description: classificationDescription(level),
      })),
      fieldPolicies: {
        streamFields: STREAM_FIELD_POLICIES,
        requestFields: REQUEST_FIELD_POLICIES,
      },
      retentionSchedule: RETENTION_SCHEDULE,
      trustBoundaries: TRUST_BOUNDARIES,
    },
    _links: {
      self: '/api/privacy/policy',
      retention: '/api/privacy/retention',
      consent: '/api/privacy/consent',
      health: '/health',
      streams: '/api/streams',
    },
  });
});
privacyRouter.all('/policy', rejectUnsupportedMethods(['GET', 'HEAD']));

/**
 * GET /api/privacy/retention
 *
 * Lightweight view of just the retention schedule for quick
 * compliance checks.
 */
privacyRouter.get('/retention', (_req: Request, res: Response) => {
  res.json({
    retentionSchedule: RETENTION_SCHEDULE,
    _links: {
      self: '/api/privacy/retention',
      fullPolicy: '/api/privacy/policy',
    },
  });
});
privacyRouter.all('/retention', rejectUnsupportedMethods(['GET', 'HEAD']));

/**
 * PUT /api/privacy/consent
 *
 * Upserts the recipient consent-preference document. The plaintext Stellar
 * address is accepted only at the HTTP boundary, converted to a keyed HMAC via
 * computeAddressHash, and never stored in privacy_consents.
 */
privacyRouter.put(
  '/consent',
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseConsentBody(req.body);
    const addressHash = computeConsentAddressHash(req, input.address);

    let result;
    try {
      result = await query<PrivacyConsentRow>(
        getPool(),
        `
          INSERT INTO privacy_consents (
            address_hash,
            analytics_optout,
            marketing_optout,
            biometric_processing_consent,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, NOW(), NOW())
          ON CONFLICT (address_hash) DO UPDATE SET
            analytics_optout = EXCLUDED.analytics_optout,
            marketing_optout = EXCLUDED.marketing_optout,
            biometric_processing_consent = EXCLUDED.biometric_processing_consent,
            updated_at = NOW()
          RETURNING
            analytics_optout,
            marketing_optout,
            biometric_processing_consent,
            created_at,
            updated_at
        `,
        [
          addressHash,
          input.analytics_optout,
          input.marketing_optout,
          input.biometric_processing_consent,
        ],
      );
    } catch (err) {
      wrapPrivacyDbError(err);
    }

    const row = result!.rows[0];
    res.status(200).json(successResponse({ consent: toConsentResponse(row!) }, req.id));
  }),
);
privacyRouter.all('/consent', rejectUnsupportedMethods(['PUT']));

/**
 * GET /api/privacy/consent/:address
 *
 * Returns the stored consent preferences for a Stellar address by hashing the
 * route parameter and querying privacy_consents.address_hash. The response does
 * not echo the plaintext address or its keyed hash.
 */
privacyRouter.get(
  '/consent/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const address = parseConsentAddressParam(req.params['address']);
    const addressHash = computeConsentAddressHash(req, address);

    let result;
    try {
      result = await query<PrivacyConsentRow>(
        getPool(),
        `
          SELECT
            analytics_optout,
            marketing_optout,
            biometric_processing_consent,
            created_at,
            updated_at
          FROM privacy_consents
          WHERE address_hash = $1
        `,
        [addressHash],
      );
    } catch (err) {
      wrapPrivacyDbError(err);
    }

    const row = result!.rows[0];
    if (!row) throw notFound('Privacy consent');

    res.json(successResponse({ consent: toConsentResponse(row) }, req.id));
  }),
);
privacyRouter.all('/consent/:address', rejectUnsupportedMethods(['GET', 'HEAD']));

/** Map a classification enum value to a human-readable description. */
function classificationDescription(level: DataClassification): string {
  switch (level) {
    case DataClassification.PUBLIC:
      return 'Freely shareable; no privacy implications.';
    case DataClassification.INTERNAL:
      return 'Operational data visible to authenticated users and operators.';
    case DataClassification.SENSITIVE:
      return 'Pseudonymous identifiers that could be correlated to real identities. Redacted in logs.';
    case DataClassification.RESTRICTED:
      return 'Credentials or direct PII. Never persisted, never logged.';
  }
}
