/**
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
    super(`[${statusCode}] ${code}: ${message}`);
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
