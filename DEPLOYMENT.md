# Deploying LexGuard AI to Azure

Single-cloud deployment: everything runs in one Azure Container Apps
Environment, in your existing Azure account (the one already issuing
`AZURE_OPENAI_*` credentials) — no Vercel/Railway/Neon/Upstash accounts
needed.

## Why this shape

- **One public origin.** `apps/web`'s Next.js server proxies `/api/v1/*` to
  the api container server-side (`apps/web/next.config.mjs`, via
  `API_INTERNAL_URL`). The browser only ever talks to the web app's domain —
  it never makes a cross-origin request to the api, so there's no CORS to
  configure or keep in sync across two independently-managed domains.
- **`api` has internal-only ingress.** It's not reachable from the public
  internet at all, only from `web` inside the same Container Apps
  Environment. Smaller attack surface than exposing it directly.
- **Same region as Azure OpenAI.** Deploy Container Apps in the same region
  as your Azure OpenAI resource to cut latency on every agent call.
- **Managed Postgres + Redis**, replacing the local `docker-compose.yml`
  containers — same engines (Postgres 16, Redis), just hosted.

## What's been prepared (and verified locally)

| File | Purpose | Verified how |
|---|---|---|
| [apps/api/Dockerfile](apps/api/Dockerfile) | Production api image | Built + ran locally, `/health` returned 200 |
| [apps/web/Dockerfile](apps/web/Dockerfile) | Production web image (Next standalone) | Built + ran locally, proxy round-tripped to a real api container |
| [.dockerignore](.dockerignore) | Keeps build context small | — |
| [infra/azure/base.bicep](infra/azure/base.bicep) | Container Apps Env, ACR, Postgres, Redis, Qdrant | **Not deployed against a live subscription** — no `az`/`azd` available in the environment this was written in |
| [infra/azure/apps.bicep](infra/azure/apps.bicep) | api + web container apps | Same caveat |
| [infra/azure/deploy.sh](infra/azure/deploy.sh) | Orchestrates the two-phase deploy | Same caveat |

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

bash infra/azure/deploy.sh
```

This runs, in order: resource group → `base.bicep` (Container Apps
Environment, ACR, managed Postgres, managed Redis, self-hosted Qdrant with
Azure Files persistence) → `az acr build` for both images (builds happen in
Azure, not on your machine — no local `docker push` credentials needed) →
`apps.bicep` (api + web container apps). It's idempotent; re-running only
updates what changed.

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

## Cost shape (rough, eastus, as of writing)

- Container Apps: pay-per-use CPU/memory + a small always-on baseline for
  `minReplicas: 1` on api/web/qdrant — expect low tens of $/month at hackathon
  scale, more once you raise `maxReplicas` or usage grows.
- Postgres Flexible Server (Burstable B1ms): ~$12-15/month.
- Redis (Basic C0): ~$16/month.
- ACR (Basic): ~$5/month.
- Storage Account (Qdrant persistence): a few $/month at small volumes.

This is meaningfully more than a $10-20/month VPS running the same
`docker-compose.yml` you already have locally — the tradeoff is zero server
maintenance and one already-familiar vendor instead of a new one.

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
