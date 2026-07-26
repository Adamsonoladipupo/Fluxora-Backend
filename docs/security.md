# Security Guidelines & Audit Logging

## Indexer Worker mTLS Connections

The connection between the backend and the indexer worker operates over a mutually authenticated TLS (mTLS) session. This is a high-value trust boundary.

### Certificate Validation Failures

Whenever client-certificate validation fails for an indexer connection, the backend records the failure to prevent misconfigurations or active attacks from going unnoticed. 

**Logging Behavior:**
- An immutable entry is written to the structured audit log with the action `MTLS_VALIDATION_FAILED`.
- The entry captures public certificate fields (e.g., subject, issuer, serial number) and a generalized failure reason (e.g., `EXPIRED_CERT`, `UNKNOWN_CA`).
- **Private key material is never logged.**

**Metrics and Alerting:**
- A Prometheus counter `indexer_mtls_validation_failures_total` is incremented.
- This metric is labeled by `reason`, allowing operators to set up alerts for repeated failures.

If validation failures spike, operators should query the `audit_logs` table (or `/api/audit` endpoint) for more detailed correlations and investigate the corresponding clients.
