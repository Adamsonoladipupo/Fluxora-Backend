/**
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
