/**
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
    this.baseUrl = (config.baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
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
    let url = `${this.baseUrl}${path}`;

    if (options.params) {
      const queryParams = new URLSearchParams();
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          queryParams.append(k, String(v));
        }
      }
      const queryString = queryParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = { ...this.headers, ...options.headers };
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
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
    const res = await this.request<StreamSingleResponse>('GET', `/api/streams/${streamId}`);
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
    const res = await this.request<StreamSingleResponse>('POST', `/api/streams/${streamId}/cancel`);
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
    const res = await this.request<PrivacyConsentResponse>('GET', `/api/privacy/consent/${address}`);
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
    const res = await this.request<{ success: boolean; data: WebhookDelivery }>('GET', `/api/webhooks/${id}`);
    return res.data;
  }
}
