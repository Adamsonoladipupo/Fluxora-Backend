# Deployment Guide

## Tiered Startup Dependency Probing

Before Fluxora accepts any HTTP traffic it runs a two-tier connectivity check
against every external dependency. This bounds the startup delay and surfaces
misconfiguration failures early so on-call engineers see a clear structured log
entry — not a cryptic 503 from the load balancer — within seconds of a bad
deploy.

### Tiers

| Tier | Dependencies | Failure behaviour |
|------|-------------|------------------|
| **hard** | PostgreSQL | Single probe attempt. On failure the process **exits immediately** with exit code 1. The structured `startup_probe:fatal` log includes the sanitised error and `"action": "process will exit"`. |
| **soft** | Redis, Stellar RPC | Retried with **decorrelated-jitter backoff** until either the probe succeeds or the total wall-clock budget (`STARTUP_PROBE_BUDGET_MS`) is exhausted. On budget exhaustion the service starts in **degraded mode** and the `startup_probe:degraded` log indicates which dependencies are unavailable. |

### Why this design?

- **Postgres is hard**: every write and read path requires a live pool
  connection. A misconfigured `DATABASE_URL` must be caught immediately — not
  after a readiness probe timeout that delays container restart.
- **Redis is soft**: rate-limiting, idempotency, and session stores fall back to
  in-memory or no-op implementations. A transient Redis restart during a rolling
  deploy should not kill the process.
- **Stellar RPC is soft**: the RPC tier has its own circuit breaker and cached
  fallbacks. Brief unavailability is tolerable; the service degrades gracefully
  rather than refusing all traffic.

### Configuration

All timeouts and the budget are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `STARTUP_PROBE_BUDGET_MS` | `30000` | Total wall-clock budget (ms) for soft-tier retries. Set this below your container-orchestrator readiness timeout. |
| `STARTUP_PROBE_POSTGRES_TIMEOUT_MS` | `5000` | Per-attempt timeout (ms) for the single Postgres hard probe. |
| `STARTUP_PROBE_REDIS_TIMEOUT_MS` | `3000` | Per-attempt timeout (ms) for each Redis soft-probe retry attempt. |
| `STARTUP_PROBE_STELLAR_TIMEOUT_MS` | `5000` | Per-attempt timeout (ms) for each Stellar RPC soft-probe retry attempt. |

All values must be strictly greater than 0. The Zod schema rejects 0 or
negative values at boot with a `ConfigError`.

### Kubernetes readiness/liveness alignment

Set `STARTUP_PROBE_BUDGET_MS` to a value **lower** than your pod's
`initialDelaySeconds` so Fluxora can reach its degraded-or-healthy state before
the kubelet starts counting readiness failures.

```yaml
# Example: 30 s budget, probe starts after 35 s
readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 35
  periodSeconds: 10
  failureThreshold: 3
```

```
STARTUP_PROBE_BUDGET_MS=30000   # 30 s — leaves 5 s margin before kubelet checks
```

### Log events

Every stage emits a structured JSON log entry. Fields are always present in
each event; optional fields are marked with `?`.

#### `startup_probe:begin`
```json
{
  "level": "info",
  "message": "startup_probe:begin",
  "dependencies": [
    { "name": "postgres", "tier": "hard" },
    { "name": "redis",    "tier": "soft" },
    { "name": "stellar_rpc", "tier": "soft" }
  ],
  "budgetMs": 30000
}
```

#### `startup_probe:attempt`
```json
{
  "level": "info",
  "message": "startup_probe:attempt",
  "dependency": "postgres",
  "tier": "hard",
  "attempt": 1,
  "timeoutMs": 5000,
  "budgetRemainingMs": 29800    // soft tier only
}
```

#### `startup_probe:success`
```json
{
  "level": "info",
  "message": "startup_probe:success",
  "dependency": "postgres",
  "tier": "hard",
  "attempt": 1,
  "outcome": "success",
  "latencyMs": 42
}
```

#### `startup_probe:retry` *(soft tier only)*
```json
{
  "level": "warn",
  "message": "startup_probe:retry",
  "dependency": "redis",
  "tier": "soft",
  "attempt": 2,
  "outcome": "retry",
  "latencyMs": 3001,
  "error": "redis timed out after 3000 ms",
  "budgetRemainingMs": 24000
}
```

#### `startup_probe:degraded` *(soft tier only)*
```json
{
  "level": "warn",
  "message": "startup_probe:degraded",
  "dependency": "stellar_rpc",
  "tier": "soft",
  "attempts": 5,
  "outcome": "degraded",
  "latencyMs": 5002,
  "error": "stellar_rpc startup probe timed out after 5000 ms",
  "action": "service will start in degraded mode"
}
```

#### `startup_probe:fatal` *(hard tier only)*
```json
{
  "level": "error",
  "message": "startup_probe:fatal",
  "dependency": "postgres",
  "tier": "hard",
  "attempt": 1,
  "outcome": "fatal",
  "latencyMs": 5001,
  "error": "connect ECONNREFUSED [redacted-url]",
  "action": "process will exit"
}
```

#### `startup_probe:complete`
```json
{
  "level": "info",
  "message": "startup_probe:complete",
  "outcome": "degraded",
  "degradedDependencies": ["stellar_rpc"],
  "results": [
    { "name": "postgres",    "tier": "hard", "outcome": "success",  "attempts": 1, "latencyMs": 42 },
    { "name": "redis",       "tier": "soft", "outcome": "success",  "attempts": 3, "latencyMs": 12 },
    { "name": "stellar_rpc", "tier": "soft", "outcome": "degraded", "attempts": 5, "latencyMs": 5002 }
  ]
}
```

### Security

- All error messages emitted in logs are passed through `sanitiseErrorMessage()`
  (`src/health/checkers.ts`). Connection strings (e.g.
  `postgresql://user:pass@host/db`, `redis://admin:secret@host:6379`),
  passwords, and hostnames embedded in error strings are replaced with
  `[redacted-url]` or `[redacted-credentials]` before any log is written.
- The probe functions use transient, short-lived clients that are torn down
  immediately after each attempt — no connection pool pollution.
- `STARTUP_PROBE_*` timeout values are validated against a minimum of 1 by the
  Zod schema so they cannot be set to 0 to disable the timeout silently.

### On-call triage quick reference

| Log event | Meaning | Action |
|-----------|---------|--------|
| `startup_probe:fatal` | Postgres unreachable | Check `DATABASE_URL`, network policy, DB status |
| `startup_probe:degraded` for `redis` | Redis unreachable after budget | Check `REDIS_URL`, Redis cluster health |
| `startup_probe:degraded` for `stellar_rpc` | Stellar RPC unreachable after budget | Check `STELLAR_RPC_URL`, network egress |
| `startup_probe:complete` with `outcome: healthy` | All dependencies reachable | Normal startup |
| `startup_probe:complete` with `outcome: degraded` | One or more soft deps unavailable | Service started; investigate degraded deps |

---

## Docker Health Check Tuning

Fluxora's Docker container features parameterised health checks to accommodate different deployment environments.

**Build Arguments (Dockerfile):**
- `HEALTH_INTERVAL` (Default: `30s`): Time between Docker daemon health probes.
- `HEALTH_TIMEOUT` (Default: `5s`): Time before a Docker daemon probe fails.

**Runtime Environment Variables (App Level):**
- `HEALTH_CHECK_INTERVAL_MS` (Default: `30000`): Internal application polling interval.
- `HEALTH_CHECK_TIMEOUT_MS` (Default: `5000`): Maximum time allowed for internal liveness checks.

*Note: Runtime timeout values must be strictly greater than 0.*

## Blue/Green Deployment

Fluxora achieves zero-downtime deployments by running two parallel application
slots — **blue** and **green** — against the **same** PostgreSQL database and
the **same** Redis instance. Traffic is directed to one active slot at a time;
the inactive slot receives the new release, passes health checks, and then the
load balancer is flipped atomically.

### Architecture

```
                        ┌─────────────────────────────────────┐
                        │  Front-side Load Balancer / ALB      │
                        │  (routes 100 % of traffic to one     │
                        │   slot at a time during steady state) │
                        └────────────┬────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                                             ▼
  ┌──────────────────────┐                    ┌──────────────────────┐
  │  app-blue  :3000     │                    │  app-green :3001     │
  │  DEPLOYMENT_SLOT=blue│                    │  DEPLOYMENT_SLOT=    │
  │                      │                    │    green             │
  │  X-Fluxora-           │                    │  X-Fluxora-          │
  │  Deployment-Slot:    │                    │  Deployment-Slot:    │
  │    blue              │                    │    green             │
  └──────────┬───────────┘                    └──────────┬──────────┘
             │                                           │
             └──────────────────┬────────────────────────┘
                                │
               ┌────────────────┴─────────────────┐
               │                                  │
     ┌─────────▼──────────┐           ┌───────────▼────────┐
     │  PostgreSQL :5432  │           │  Redis :6379        │
     │  (shared schema)   │           │  (shared state)     │
     └────────────────────┘           └────────────────────┘
```

**Key properties:**

| Property | Detail |
|---|---|
| Shared database | Both slots use the same `DATABASE_URL`; schema is always consistent |
| Shared Redis | Idempotency keys, rate-limit counters, circuit-breaker state, and leader-election leases are consistent across slots during a cutover |
| Slot identifier | `DEPLOYMENT_SLOT` env var (`blue` or `green`) — read at request time, never cached |
| Identification header | `X-Fluxora-Deployment-Slot` on every HTTP response |
| Port mapping | blue → 3000, green → 3001 (host); both listen on container port 3000 |

---

### The `X-Fluxora-Deployment-Slot` Response Header

Every HTTP response carries this header, regardless of status code (2xx, 4xx,
5xx). Its purpose is to let a front-side load balancer or e2e test suite assert
which slot handled a specific request — particularly useful during the brief
window when traffic is being shifted.

**Implementation (`src/app.ts`):**

```typescript
/**
 * deploymentSlotMiddleware
 *
 * Emits `X-Fluxora-Deployment-Slot` on every response so that a front-side
 * load balancer or the e2e suite can verify which slot answered a request
 * during a blue/green cutover.
 *
 * @security The header value is constrained to /^[a-z0-9-]+$/i to prevent
 *           header injection. Any non-conforming value is replaced with "blue".
 */
function deploymentSlotMiddleware(req, res, next) {
  const raw = process.env.DEPLOYMENT_SLOT ?? 'blue';
  const slot = /^[a-z0-9-]+$/i.test(raw) ? raw : 'blue';
  res.setHeader('X-Fluxora-Deployment-Slot', slot);
  next();
}
```

The middleware runs at the top of the Express middleware stack — before body
parsing, authentication, and routing — so no code path can send a response
without the header.

**Behaviour summary:**

| `DEPLOYMENT_SLOT` value | Header value |
|---|---|
| `blue` | `blue` |
| `green` | `green` |
| `canary-1`, `release-2025` | passed through unchanged |
| *(unset)* or `""` | `blue` (default) |
| Contains CRLF, spaces, or special chars | `blue` (sanitised) |

---

### Shared State Considerations

Because both slots target the same Redis instance, the following subsystems
remain consistent during a cutover:

| Subsystem | Redis key prefix | Behaviour during cutover |
|---|---|---|
| Idempotency store | `idempotency:` | A key written by the blue slot is visible to green; no duplicate deliveries |
| Rate limiter | `rl:` | Sliding-window counters are shared; clients cannot bypass limits by hitting the new slot |
| Webhook circuit breaker | `cbk:` | Breaker state is propagated across slots; a tripped breaker on blue is also open on green |
| Indexer leader election | `indexer:leader` | Only one slot holds the leader lease at a time; the other defers replay |
| Admin-state lock | `admin:lock:` | Pause flags are consistent across both slots |

> **Rule:** When deploying a change that alters Redis key structure or TTL
> semantics, apply the migration in a backwards-compatible way (e.g. write the
> new key alongside the old key) and only remove the old key after both slots
> have been running the new code for the full key TTL.

---

### Shared Database and Migration Safety

Both slots point at the same `DATABASE_URL`.  The migration runner
(`src/db/migrate.ts`) wraps every migration in a PostgreSQL advisory lock
(`pg_advisory_lock`) so concurrent executions of `pnpm run migrate` are safe:

```
Slot A: acquires advisory lock → applies migration M1 → releases lock
Slot B: blocks on advisory lock → sees M1 already in pgmigrations → skips → releases lock
```

The `pgmigrations` table records each applied migration by name.
`checkPendingMigrations()` reads this table at startup and throws
`PendingMigrationsError` if any migration file on disk is not yet recorded,
preventing a slot from starting against a stale schema.

#### Migration decision tree

```
Is the DDL change additive (new column with default, new table, new index)?
├── YES → Safe to deploy without a migration window.
│         1. Add the migration file.
│         2. docker-compose exec app-green pnpm run migrate
│         3. Promote green slot.
│         4. app-blue automatically sees the new schema on next request.
└── NO  → Requires a multi-step deploy:
          Step 1: Deploy a backwards-compatible version of the code that can
                  work with both the old and new schema simultaneously.
          Step 2: Apply the migration.
          Step 3: Deploy the final version of the code.
          Step 4: Remove compatibility shims.
```

---

### Starting Both Slots Locally

```bash
# Build and start everything (postgres + redis + app-blue + app-green)
docker-compose up -d

# Confirm both slots are healthy
curl -s http://localhost:3000/health | jq .status   # blue slot
curl -s http://localhost:3001/health | jq .status   # green slot

# Confirm slot identification headers
curl -sI http://localhost:3000/health | grep X-Fluxora
# X-Fluxora-Deployment-Slot: blue

curl -sI http://localhost:3001/health | grep X-Fluxora
# X-Fluxora-Deployment-Slot: green
```

---

### Cutover Procedure — Manual (nginx / docker-compose)

> **Pre-condition:** Active slot is `blue` (port 3000). New release goes to
> `green` (port 3001).

**1. Build and start the inactive slot with the new image:**
```bash
docker-compose up -d --no-deps --build app-green
```

**2. Wait for the green slot to pass health checks:**
```bash
# Poll until HTTP 200 is returned
until curl -sf http://localhost:3001/health > /dev/null; do
  echo "Waiting for green slot…"; sleep 2
done
echo "Green slot is healthy"
```

**3. Run database migrations (idempotent — safe to run while blue is live):**
```bash
docker-compose exec app-green pnpm run migrate
```

> `checkPendingMigrations()` in `src/db/migrate.ts` will throw on startup if
> the migration is not applied; the green slot will refuse to start, protecting
> you from accidentally promoting an incompatible schema.

**4. Verify the deployment slot header on the green slot:**
```bash
curl -sI http://localhost:3001/health | grep -i x-fluxora
# Expected: X-Fluxora-Deployment-Slot: green
```

**5. Switch the nginx upstream:**
```nginx
# /etc/nginx/conf.d/fluxora.conf
upstream fluxora_backend {
  server localhost:3001;  # ← was 3000 (blue), now 3001 (green)
}
```
```bash
nginx -t && nginx -s reload
```

**6. Confirm live traffic is hitting the green slot:**
```bash
curl -sI https://your-api-domain.com/health | grep -i x-fluxora
# Expected: X-Fluxora-Deployment-Slot: green
```

**7. Soak period — leave the blue slot running for 10–15 minutes:**
This preserves an instant rollback path without requiring a rebuild.

**8. Decommission the old slot:**
```bash
docker-compose stop app-blue
```

---

### Cutover Procedure — Automated (AWS ALB + ECS)

This procedure uses weighted target groups to shift traffic gradually.

**Pre-condition:** Blue target group is at 100 %, green is at 0 %.

```bash
# 1. Register the new green task and confirm health checks pass
aws ecs update-service \
  --cluster fluxora \
  --service fluxora-green \
  --force-new-deployment

# 2. Wait for green tasks to reach RUNNING + healthy
aws ecs wait services-stable \
  --cluster fluxora \
  --services fluxora-green

# 3. Apply migrations (run from any task; advisory lock prevents conflicts)
aws ecs run-task \
  --cluster fluxora \
  --task-definition fluxora-migrate \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx]}"

# 4. Gradually shift traffic: 90/10 → 50/50 → 0/100
aws elbv2 modify-listener \
  --listener-arn arn:aws:elasticloadbalancing:... \
  --default-actions '[
    {"Type":"forward","ForwardConfig":{"TargetGroups":[
      {"TargetGroupArn":"arn:...blue","Weight":90},
      {"TargetGroupArn":"arn:...green","Weight":10}
    ]}}
  ]'

# (repeat with 50/50 then 0/100 after monitoring)

# 5. Verify the slot header on a sampled request
curl -sI https://your-api-domain.com/health | grep -i x-fluxora
```

---

### Cutover Procedure — Automated (HAProxy)

```
# haproxy.cfg
backend fluxora_backend
  server blue  localhost:3000 check weight 0   # being drained
  server green localhost:3001 check weight 100 # receiving all traffic

# Reload without dropping connections
haproxy -f /etc/haproxy/haproxy.cfg -sf $(pidof haproxy)
```

Steps:
1. Deploy to the inactive slot; wait for HAProxy health checks to turn green.
2. Set the new slot's weight to 100 and the old slot's weight to 0 (or any
   weighted distribution for a canary release).
3. Reload HAProxy (`-sf` for soft reload — no connection drops).
4. After the drain period (tracked via `X-Fluxora-Deployment-Slot` in access
   logs), stop the old slot.

---

**Integration Tests**

- **Redis-backed adminStateLock integration:** Set `REDIS_INTEGRATION=true` and point `REDIS_TEST_URL` at a test Redis instance (for example a locally running `redis-server` or the compose `redis` service). Then run the specific test file:

```bash
REDIS_INTEGRATION=true REDIS_TEST_URL=redis://:fluxora_redis_password@127.0.0.1:6379 pnpm test tests/state/adminStateLock.concurrentReindex.test.ts
```

- Security: tests use transient Redis clients that are torn down after each test. Do not run against production Redis instances — use an isolated test instance only.

---

### Rollback Procedure

> Use this if errors are detected **after** cutover.  The old slot remains
> running during the soak period specifically to make this instant.

**1. Redirect traffic back to the old slot immediately:**

nginx:
```bash
# Restore the old upstream port
sed -i 's/server localhost:3001/server localhost:3000/' /etc/nginx/conf.d/fluxora.conf
nginx -t && nginx -s reload
```

AWS ALB:
```bash
aws elbv2 modify-listener \
  --listener-arn arn:aws:elasticloadbalancing:... \
  --default-actions '[{"Type":"forward","TargetGroupArn":"arn:...blue"}]'
```

**2. Verify the old slot is serving traffic:**
```bash
curl -sI https://your-api-domain.com/health | grep -i x-fluxora
# Expected: X-Fluxora-Deployment-Slot: blue
```

**3. Stop the failed slot to prevent accidental traffic leakage:**
```bash
docker-compose stop app-green
# or: aws ecs update-service --cluster fluxora --service fluxora-green --desired-count 0
```

**4. Investigate the failed slot's logs:**
```bash
docker-compose logs app-green --tail=200
# or: aws logs filter-log-events --log-group-name /ecs/fluxora-green
```

**5. Roll back the migration (only if the migration was destructive):**

> ⚠️  Only required if the schema change is not backwards-compatible with the
> old application code (rare — avoid destructive migrations in production).

```bash
# node-pg-migrate supports down migrations
docker-compose exec app-blue \
  npx node-pg-migrate down --count 1
```

**6. Fix and re-deploy to the inactive slot before the next cutover attempt.**

---

### Operational Runbook — Quick Reference

| Situation | Indicator | Action |
|---|---|---|
| New slot starts but health check fails | `GET /health` → non-200 | Check logs: `docker-compose logs app-green` |
| Cutover causes 5xx spike | Error-rate alert fires | Rollback: redirect LB back to old slot |
| Migration fails on green slot | `PendingMigrationsError` in logs | Fix migration file; rerun `pnpm run migrate` |
| Both slots healthy but wrong header in prod | `X-Fluxora-Deployment-Slot: blue` after promoting green | Verify LB upstream was updated and reloaded |
| Redis unavailable during cutover | `startup_probe:degraded redis` in logs | Both slots fall back to in-process/no-op; service continues degraded |
| Postgres advisory lock contention | Slow migration observed | Expected during concurrent `pnpm run migrate`; one slot will wait |
| Old slot not stopped after soak | Two slots receiving traffic | Acceptable; LB sends 100 % to new slot; stop old slot when ready |

---

### Security Assumptions

| Assumption | Detail |
|---|---|
| `DEPLOYMENT_SLOT` is untrusted input | Value is read from env at request time and sanitised to `[a-z0-9-]` before being placed in a response header to prevent header injection |
| Clients cannot spoof the header | `res.setHeader()` always overwrites any client-supplied value of the same name |
| Redis password must be rotated in non-local environments | The `docker-compose.yml` default (`fluxora_redis_password`) is a local-dev-only value; use a secrets manager in staging and production |
| Migration runs require privileged DB access | Only the application's `DATABASE_URL` user needs `CREATE TABLE` / `ALTER TABLE` rights; restrict this for the replicas in read-heavy setups |
| Port 3001 (green) must be firewalled in production | Expose only the active slot's port to public traffic; the inactive slot should be accessible only from the load balancer's health-check IP range |

---

### Testing

The full blue/green test suite lives in `tests/app.blueGreen.test.ts`.

**Run the tests:**
```bash
pnpm test tests/app.blueGreen.test.ts
# Or with coverage:
pnpm test:coverage
```

**What is covered (≥ 95 % line/branch coverage):**

| Test group | Scenarios |
|---|---|
| Default / fallback | Absent env var, empty string |
| Explicit slots | `blue`, `green` |
| Custom slot names | `canary-1`, `release-2025`, `hotfix`, `BLUE` |
| Header injection prevention | CRLF, LF, null byte, spaces, semicolons, angle brackets, unicode |
| Request-time reading | Env var mutation between requests on the same app instance |
| HTTP methods | GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE |
| Response status codes | 200 (root, health), 404 (unknown route), 500 (thrown error via `__test/error`) |
| Concurrent requests | 10 simultaneous requests return the same slot |
| Client spoof prevention | Client-supplied header value is overwritten by the server |
| Module exports | `createApp()` and the default `app` export both serve the header |
| Header casing | Lowercase key accessible via `x-fluxora-deployment-slot` |

### gRPC Health Check (Kubernetes-native probes)

Kubernetes' built-in gRPC probes (`livenessProbe.grpc` / `readinessProbe.grpc`, and the standalone `grpc-health-probe` binary) speak the standard `grpc.health.v1.Health` protocol rather than plain HTTP. Fluxora can expose this alongside the existing HTTP `/health` endpoints, on a separate port so it never competes with API traffic.

**Runtime Environment Variables (App Level):**
- `GRPC_HEALTH_ENABLED` (Default: `false`): Enables the gRPC health service.
- `GRPC_HEALTH_PORT` (Default: `50051`): Port the gRPC health service binds to. Must differ from `PORT` (the HTTP port).

The service reuses the exact same `HealthCheckManager` dependency checks as `/health/ready` (`src/config/health.ts`) — it does not re-implement or duplicate any check logic, so the two surfaces cannot drift out of sync. `healthy` and `degraded` both map to `SERVING` (matching `/health/ready`'s 200 response for both statuses); `unhealthy` maps to `NOT_SERVING`.

**Security note:** like the internal HTTP endpoints documented above, the gRPC health port is intentionally unauthenticated — Kubernetes probes and `grpc-health-probe` don't send credentials. This port must **not** be exposed outside the cluster network (no public LoadBalancer/Ingress); bind it only to a `ClusterIP` service or rely on the pod's default internal-only networking.

**Example — `grpc-health-probe` (manual check):**
```bash
grpc-health-probe -addr=localhost:50051
```

**Example — Kubernetes probe configuration:**
```yaml
livenessProbe:
  grpc:
    port: 50051
readinessProbe:
  grpc:
    port: 50051
  periodSeconds: 10
```
