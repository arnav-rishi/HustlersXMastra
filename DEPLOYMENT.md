# Deploying LexGuard AI to Azure

Single-cloud deployment: everything runs in one Azure Container Apps
Environment, in your existing Azure account (the one already issuing
`AZURE_OPENAI_*` credentials) — no Vercel/Railway/Neon/Upstash accounts
needed.

## Why this shape

- **`api` is externally reachable, called directly by the browser with CORS**
  (`ALLOWED_ORIGINS` locked to the web app's origin). This was originally a
  zero-CORS design — `web`'s Next.js server proxying `/api/v1/*` to `api`
  server-side over internal-only ingress — but that was reverted after
  confirming live that this Container Apps Environment's internal HTTP
  ingress resets the connection on proxied `POST` requests with a body
  (multipart file uploads specifically broke; plain `GET`s worked fine).
  Internal ingress also failed a second, unrelated way for Redis (TCP
  transport, see below) — two distinct reliability problems were enough to
  move off internal ingress for anything load-bearing rather than keep
  debugging the platform's internal proxy layer.
- **Same region as Azure OpenAI.** Deploy Container Apps in the same region
  as your Azure OpenAI resource to cut latency on every agent call.
- **Managed Postgres**, replacing the local `docker-compose.yml` container —
  same engine (Postgres 16), just hosted. **Redis runs as a sidecar
  container inside `api`** (`localhost:6379`, same revision/network
  namespace) rather than its own Container App — its earlier TCP-transport
  internal ingress consistently timed out on every connection from `api`,
  regardless of ingress config (tried both default and explicit
  `exposedPort`). Classic "Azure Cache for Redis" is also retired for new
  deployments in this subscription, and its replacement ("Azure Managed
  Redis") has an unverified Bicep schema — the sidecar sidesteps both issues.

## What's been prepared (and verified locally)

| File | Purpose | Verified how |
|---|---|---|
| [apps/api/Dockerfile](apps/api/Dockerfile) | Production api image | Built + ran locally, `/health` returned 200 |
| [apps/web/Dockerfile](apps/web/Dockerfile) | Production web image (Next standalone) | Built + ran locally, proxy round-tripped to a real api container |
| [infra/otel/Dockerfile](infra/otel/Dockerfile) | OTel Collector image w/ baked config | Built + ran locally, config loaded with no errors |
| [infra/prometheus/Dockerfile](infra/prometheus/Dockerfile) | Prometheus image w/ build-time scrape target | Built + ran locally, confirmed substituted target via Prometheus's own config API |
| [infra/grafana/Dockerfile](infra/grafana/Dockerfile) | Grafana image w/ build-time datasource | Built + ran locally, confirmed substituted datasource URL via Grafana's API |
| [.dockerignore](.dockerignore) | Keeps build context small | — |
| [infra/azure/base.bicep](infra/azure/base.bicep) | Container Apps Env, ACR, Postgres, Redis, Qdrant, Jaeger | Deployed successfully to a live subscription during this session (`centralus`, after working through several Azure-side surprises — see below) |
| [infra/azure/apps.bicep](infra/azure/apps.bicep) | api, web, otel-collector, prometheus, grafana container apps | The api/web portion deployed successfully live. The otel-collector/prometheus/grafana additions have **not** been deployed live yet — written and locally image-verified only. Run `az deployment group what-if` before applying. |
| [infra/azure/deploy.sh](infra/azure/deploy.sh) | Orchestrates the phased deploy | Same as above |

### Real issues hit deploying this live (not hypothetical — actually happened)

- **Region matters more than expected.** `eastus` rejected both Postgres
  Flexible Server (`LocationIsOfferRestricted` — subscription-level, not a
  capacity issue) and, separately, Container Apps Environments
  (`AKSCapacityHeavyUsage`, transient regional capacity). Check
  `az postgres flexible-server list-skus --location <region>` before
  committing to a region — an empty result means that subscription can't
  provision Postgres there at all, regardless of what other resources
  (like Azure OpenAI) already work in that region.
- **Classic "Azure Cache for Redis" (`Microsoft.Cache/redis`) is retired for
  new deployments.** `base.bicep` now runs `redis:7-alpine` as a self-hosted
  container app instead (internal-only ingress) rather than the managed
  service — same image the local `docker-compose.yml` already uses.
- **`@qdrant/js-client-rest` ignores the URL's implicit port** and always
  tries 6333 unless told otherwise — breaks against any HTTPS endpoint that
  only exposes 443 (e.g. Container Apps external ingress). Fixed in
  `packages/qdrant/src/client.ts` by deriving the port explicitly from the
  URL instead of trusting the library default.
- **ARM's deployment-validation engine can hold a stale "resource X exists in
  location Y" lock** even after the resource is fully deleted (confirmed via
  both `az <service> show` and Resource Graph). `base.bicep`'s Postgres
  server name includes a `utcNow()`-derived token specifically so retries
  can't collide with this.

Before running the Bicep for real: `az bicep build --file infra/azure/base.bicep`
and `az deployment group what-if` on both files. Treat the Bicep as a strong
first draft, not a guarantee — I could validate the Dockerfiles by actually
building and running them here, but I have no Azure credentials or CLI in
this environment to do the same for the infrastructure templates.

Two real bugs were caught by actually building the images (worth knowing
about regardless of where you deploy):
1. `turbo prune` doesn't carry root-level config referenced via `extends`
   (`tsconfig.base.json`) — both Dockerfiles now `COPY` it in explicitly.
2. Turborepo 2's default `envMode: "strict"` was silently dropping
   `API_INTERNAL_URL` and all `NEXT_PUBLIC_*` vars from the `next build`
   process — `turbo.json`'s `build` task now declares them under `env`.
   Also: Next.js resolves `rewrites()` **once, at build time** — you cannot
   change the api proxy target with a runtime env var on the built image,
   only by rebuilding with a different `API_INTERNAL_URL` build arg.

## Prerequisites

- Azure CLI (`az`) logged in: `az login`, `az account set --subscription <id>`
- `jq` (deploy.sh parses `az` JSON output with it)
- An Azure OpenAI resource with chat + embedding deployments (you already
  have this — same values as your `.env.local`)
- RSA keypair for JWT signing, if you don't already have one:
  ```bash
  mkdir -p apps/api/keys
  openssl genrsa -out apps/api/keys/private.pem 2048
  openssl rsa -in apps/api/keys/private.pem -pubout -out apps/api/keys/public.pem
  ```
  Only `public.pem` goes to Azure (as `JWT_RS256_PUBLIC_KEY_PEM` — see
  `packages/shared/src/env.ts`); keep `private.pem` wherever you sign tokens.

## Deploy

```bash
cd lexguard-ai
export RESOURCE_GROUP=lexguard-prod
export LOCATION=eastus                     # match your Azure OpenAI resource's region — check its Overview blade
export POSTGRES_ADMIN_PASSWORD='<strong password>'
export QDRANT_API_KEY='<strong random string>'
export AZURE_OPENAI_API_KEY='<from your Azure OpenAI resource>'
export AZURE_OPENAI_ENDPOINT='https://<resource>.openai.azure.com'
export AZURE_OPENAI_DEPLOYMENT='<your chat deployment name>'
export AZURE_OPENAI_EMBEDDING_DEPLOYMENT='<your embedding deployment name>'
export JWT_PUBLIC_KEY_PATH="$(pwd)/apps/api/keys/public.pem"
export GRAFANA_ADMIN_PASSWORD='<strong password — Grafana is externally reachable>'

bash infra/azure/deploy.sh
```

This runs, in order: resource group → `base.bicep` (Container Apps
Environment, ACR, managed Postgres, self-hosted Redis, self-hosted Qdrant
with Azure Files persistence, Jaeger) → `az acr build` for all five images
(api, web, otel-collector, prometheus, grafana — builds happen in Azure, not
on your machine, no local `docker push` credentials needed) → `apps.bicep`
(api, web, otel-collector, prometheus, grafana container apps). It's
idempotent; re-running only updates what changed.

**Before committing to a region**, confirm Postgres Flexible Server is
actually offered to your subscription there — an empty result means it
isn't, regardless of what else works in that region:
```bash
az postgres flexible-server list-skus --location "$LOCATION" -o table
```

After it finishes, initialize the database and Qdrant collections against
the new environment:

```bash
export DATABASE_URL='<postgresDatabaseUrl output from the script>'
export QDRANT_URL='https://<qdrant internal fqdn — see script output>'
export QDRANT_API_KEY="$QDRANT_API_KEY"
pnpm --filter @lexguard/api db:migrate:deploy
pnpm qdrant:init
```

(`db:migrate:deploy` — not `db:migrate` — applies existing migrations
non-interactively; `db:migrate` runs `prisma migrate dev`, which is
dev-only and can prompt or generate new migrations against schema drift.)

## Custom domain

Once you have one:
```bash
az containerapp hostname add --name lexguard-web --resource-group $RESOURCE_GROUP --hostname app.yourdomain.com
az containerapp hostname bind --name lexguard-web --resource-group $RESOURCE_GROUP --hostname app.yourdomain.com --environment lexguard-env
```
Azure Container Apps provisions and renews the TLS certificate automatically
for managed certificates. `api` never needs a public hostname at all.

## Cost shape (rough, as of writing)

- Container Apps: pay-per-use CPU/memory + a small always-on baseline for
  `minReplicas: 1` on each of api/web/qdrant/redis/jaeger/otel-collector/
  prometheus/grafana (8 apps total) — expect tens of $/month at hackathon
  scale, more once you raise `maxReplicas` or usage grows.
- Postgres Flexible Server (Burstable B1ms): ~$12-15/month.
- ACR (Basic): ~$5/month.
- Storage Account (Qdrant persistence): a few $/month at small volumes.

Redis is now self-hosted (container app, no separate managed-service line
item) since classic Azure Cache for Redis is retired for new deployments —
see the issues list above.

This is meaningfully more than a $10-20/month VPS running the same
`docker-compose.yml` you already have locally — the tradeoff is zero server
maintenance and one already-familiar vendor instead of a new one.

## Security note: Jaeger has no authentication

Jaeger's OSS all-in-one image ships with no built-in auth, and its UI is
exposed externally (it needs to be, to be usable as a dashboard link).
Anyone with the URL can view every trace, which may include span attributes
touching contract content depending on instrumentation detail. Grafana at
least has a real admin password (`GRAFANA_ADMIN_PASSWORD`, required, no
default). Put a reverse proxy with auth in front of Jaeger (or Azure Front
Door + auth) before treating this as safe for real customer data — not done
here, flagged rather than silently shipped.

## What's intentionally not covered here

- **VNet integration / private endpoints for Postgres+Redis** — currently
  reachable over their public endpoint via TLS, firewalled to Azure-internal
  traffic only. Tighten this with VNet integration if compliance requires it.
- **Key Vault for secrets** — secrets currently live as Container Apps
  native secrets (encrypted at rest, not exposed in `az containerapp show`
  output to non-owners, but not centrally rotated/audited like Key Vault).
  Worth adding before handling real customer contracts.
- **CI/CD** — `deploy.sh` is meant to be run by hand or wired into a pipeline
  you control; it doesn't set one up itself.
