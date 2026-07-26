import { expect, test, vi, beforeEach } from 'vitest';
import { PeerCertificate } from 'tls';
import { logMtlsValidationFailure, parseAuthorizationError } from '../../src/indexer/mtlsAudit.js';
import * as auditLog from '../../src/lib/auditLog.js';
import { indexerMtlsValidationFailuresTotal } from '../../src/metrics.js';

vi.mock('../../src/lib/auditLog.js', () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock('../../src/metrics.js', () => {
  const inc = vi.fn();
  const labels = vi.fn(() => ({ inc }));
  return {
    indexerMtlsValidationFailuresTotal: {
      labels
    }
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

test('parseAuthorizationError maps certificate expired', () => {
  expect(parseAuthorizationError('CERT_HAS_EXPIRED')).toBe('EXPIRED_CERT');
});

test('parseAuthorizationError maps unknown CA', () => {
  expect(parseAuthorizationError('unable to verify the first certificate')).toBe('UNKNOWN_CA');
  expect(parseAuthorizationError('self signed certificate')).toBe('UNKNOWN_CA');
});

test('parseAuthorizationError maps invalid subject', () => {
  expect(parseAuthorizationError('hostname/IP does not match certificate subject alt name')).toBe('INVALID_SUBJECT');
});

test('logMtlsValidationFailure logs audit entry and increments metric', () => {
  const cert: PeerCertificate = {
    subject: { CN: 'bad-client' } as any,
    issuer: { CN: 'bad-ca' } as any,
    serialNumber: '12345',
    valid_from: '2023-01-01',
    valid_to: '2024-01-01',
    fingerprint256: 'AB:CD',
    // Mock private key and other things to ensure they are filtered
    privateKey: 'SECRET_KEY',
  } as any;

  logMtlsValidationFailure('CERT_HAS_EXPIRED', cert, 'conn-123');

  expect(indexerMtlsValidationFailuresTotal.labels).toHaveBeenCalledWith({ reason: 'EXPIRED_CERT' });
  const incMock = vi.mocked(indexerMtlsValidationFailuresTotal.labels({ reason: 'EXPIRED_CERT' }).inc);
  expect(incMock).toHaveBeenCalled();

  expect(auditLog.recordAuditEvent).toHaveBeenCalledWith(
    'MTLS_VALIDATION_FAILED',
    'indexer_connection',
    'conn-123',
    'conn-123',
    expect.objectContaining({
      reason: 'EXPIRED_CERT',
      authError: 'CERT_HAS_EXPIRED',
      subject: cert.subject,
      issuer: cert.issuer,
      serialNumber: cert.serialNumber,
      valid_from: cert.valid_from,
      valid_to: cert.valid_to,
      fingerprint256: cert.fingerprint256,
    })
  );

  const auditCall = vi.mocked(auditLog.recordAuditEvent).mock.calls[0];
  const metaObj = auditCall[4] as Record<string, unknown>;
  expect(metaObj.privateKey).toBeUndefined(); // MUST NOT log private key material
});

test('logMtlsValidationFailure handles null certificate gracefully', () => {
  logMtlsValidationFailure(undefined, null, 'conn-456');

  expect(indexerMtlsValidationFailuresTotal.labels).toHaveBeenCalledWith({ reason: 'NO_CERTIFICATE' });

  expect(auditLog.recordAuditEvent).toHaveBeenCalledWith(
    'MTLS_VALIDATION_FAILED',
    'indexer_connection',
    'conn-456',
    'conn-456',
    expect.objectContaining({
      reason: 'NO_CERTIFICATE',
      authError: undefined,
    })
  );
});
