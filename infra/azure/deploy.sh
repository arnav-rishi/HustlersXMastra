#!/usr/bin/env bash
# LexGuard AI — Azure Container Apps deployment
#
# Orchestrates the two-phase deploy described in DEPLOYMENT.md:
#   1. base.bicep  — Container Apps Environment, ACR, Postgres, Qdrant, Jaeger
#      (Redis runs as a sidecar inside the api Container App, see apps.bicep —
#      TCP-transport internal ingress between separate container apps was
#      confirmed live to be unreliable on this environment)
#   2. az acr build — builds api/web/otel-collector/prometheus/grafana images
#      server-side (no local docker push)
#   3. apps.bicep  — api, web (external), otel-collector, prometheus, grafana
#      (Jaeger UI + Grafana are external; everything else internal-only)
#
# This script has NOT been run against a live subscription (no Azure CLI
# available in the environment it was written in). Read it before running it,
# and consider `az deployment group what-if` on each phase first. It is safe
# to re-run — every step is idempotent (`az deployment group create`,
# `az acr build`, and Bicep resources all upsert).
#
# Required before running:
#   az login
#   az account set --subscription <subscription-id>
#
# Required environment variables (see DEPLOYMENT.md for how to obtain each):
#   RESOURCE_GROUP            e.g. lexguard-prod
#   LOCATION                  match your Azure OpenAI resource's region, e.g. eastus
#   POSTGRES_ADMIN_PASSWORD   pick a strong password
#   QDRANT_API_KEY            pick a strong random string
#   AZURE_OPENAI_API_KEY
#   AZURE_OPENAI_ENDPOINT
#   AZURE_OPENAI_DEPLOYMENT
#   AZURE_OPENAI_EMBEDDING_DEPLOYMENT
#   JWT_PUBLIC_KEY_PATH       path to apps/api/keys/public.pem (generate per README if missing)
#   GRAFANA_ADMIN_PASSWORD    pick a strong password — Grafana is externally reachable
#
# Optional:
#   NAME_PREFIX               default "lexguard"
#   AZURE_OPENAI_DEPLOYMENT_MINI
#   AZURE_OPENAI_API_VERSION
#   ENKRYPT_ENABLED / LEXISNEXIS_ENABLED / HITL_ENABLED  default false/false/true
#   SKIP_BUILD=true           skip all 5 `az acr build` calls (Phase 2) and
#                             redeploy Bicep only, reusing an existing image
#                             tag (REUSE_IMAGE_TAG, required if SKIP_BUILD=true).
#                             Use this for config-only changes (env vars,
#                             ingress settings, secrets) — much faster than a
#                             full rebuild, and avoids the image tag drifting
#                             from what's actually needed.
#   REUSE_IMAGE_TAG           image tag to redeploy when SKIP_BUILD=true, e.g.
#                             the output of:
#                             az containerapp show --name lexguard-api \
#                               --resource-group <rg> \
#                               --query "properties.template.containers[0].image" -o tsv
#                             (take just the tag after the colon)
#
# IMPORTANT: QDRANT_API_KEY should be a value YOU pick once and reuse across
# every deploy.sh run for a given environment — NOT regenerated fresh each
# time. Qdrant is a stable, non-recreated resource across redeploys; passing
# a different QDRANT_API_KEY on a later run updates Qdrant's secret AND api's
# env together within that one run, but if any run only partially completes,
# they can drift out of sync (confirmed live: api's next embedding step
# started failing with "Unauthorized: Invalid API key or JWT" against Qdrant
# after an interrupted run). Pick one value and keep exporting the same one.

set -euo pipefail

: "${RESOURCE_GROUP:?Set RESOURCE_GROUP}"
: "${LOCATION:?Set LOCATION}"
: "${POSTGRES_ADMIN_PASSWORD:?Set POSTGRES_ADMIN_PASSWORD}"
: "${QDRANT_API_KEY:?Set QDRANT_API_KEY}"
: "${AZURE_OPENAI_API_KEY:?Set AZURE_OPENAI_API_KEY}"
: "${AZURE_OPENAI_ENDPOINT:?Set AZURE_OPENAI_ENDPOINT}"
: "${AZURE_OPENAI_DEPLOYMENT:?Set AZURE_OPENAI_DEPLOYMENT}"
: "${AZURE_OPENAI_EMBEDDING_DEPLOYMENT:?Set AZURE_OPENAI_EMBEDDING_DEPLOYMENT}"
: "${JWT_PUBLIC_KEY_PATH:?Set JWT_PUBLIC_KEY_PATH (path to public.pem)}"
: "${GRAFANA_ADMIN_PASSWORD:?Set GRAFANA_ADMIN_PASSWORD}"

NAME_PREFIX="${NAME_PREFIX:-lexguard}"
AZURE_OPENAI_DEPLOYMENT_MINI="${AZURE_OPENAI_DEPLOYMENT_MINI:-}"
AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-2024-10-01-preview}"
ENKRYPT_ENABLED="${ENKRYPT_ENABLED:-false}"
LEXISNEXIS_ENABLED="${LEXISNEXIS_ENABLED:-false}"
HITL_ENABLED="${HITL_ENABLED:-true}"
SKIP_BUILD="${SKIP_BUILD:-false}"
if [ "$SKIP_BUILD" = "true" ]; then
  : "${REUSE_IMAGE_TAG:?SKIP_BUILD=true requires REUSE_IMAGE_TAG}"
  IMAGE_TAG="$REUSE_IMAGE_TAG"
else
  IMAGE_TAG="$(date +%Y%m%d%H%M%S)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "== Phase 0: resource group =="
# az group create errors if the group already exists in a *different*
# location than the one passed in — even though a resource group's own
# region is just metadata and doesn't restrict which region the resources
# deployed into it can use. Reuse the existing group as-is if present instead
# of trying to "recreate" it with a possibly-different LOCATION.
if az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Resource group $RESOURCE_GROUP already exists — reusing it."
else
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
fi

echo "== Phase 1: base infrastructure (Container Apps Env, ACR, Postgres, Qdrant, Jaeger) =="
BASE_OUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$SCRIPT_DIR/base.bicep" \
  --parameters namePrefix="$NAME_PREFIX" \
               location="$LOCATION" \
               postgresAdminPassword="$POSTGRES_ADMIN_PASSWORD" \
               qdrantApiKey="$QDRANT_API_KEY" \
  --query properties.outputs -o json)

ACR_NAME=$(echo "$BASE_OUT" | jq -r '.acrName.value')
ACR_LOGIN_SERVER=$(echo "$BASE_OUT" | jq -r '.acrLoginServer.value')
ACR_PULL_IDENTITY_ID=$(echo "$BASE_OUT" | jq -r '.acrPullIdentityId.value')
CONTAINER_APPS_ENV_ID=$(echo "$BASE_OUT" | jq -r '.containerAppsEnvId.value')
CONTAINER_APPS_ENV_DEFAULT_DOMAIN=$(echo "$BASE_OUT" | jq -r '.containerAppsEnvDefaultDomain.value')
DATABASE_URL=$(echo "$BASE_OUT" | jq -r '.postgresDatabaseUrl.value')
QDRANT_INTERNAL_URL=$(echo "$BASE_OUT" | jq -r '.qdrantInternalUrl.value')
JAEGER_EXTERNAL_FQDN=$(echo "$BASE_OUT" | jq -r '.jaegerExternalFqdn.value')
JAEGER_OTLP_ENDPOINT=$(echo "$BASE_OUT" | jq -r '.jaegerInternalOtlpEndpoint.value')

# Container Apps' internal-ingress FQDN is deterministic: <app-name>.internal.<env-default-domain>.
# Knowing this up front means these apps don't need to exist yet before
# building images that bake in a proxy/scrape target pointing at them.
API_INTERNAL_FQDN="${NAME_PREFIX}-api.internal.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"
OTEL_COLLECTOR_INTERNAL_FQDN="${NAME_PREFIX}-otel-collector.internal.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"
PROMETHEUS_INTERNAL_FQDN="${NAME_PREFIX}-prometheus.internal.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"
# External-ingress apps use <app-name>.<default-domain> (no ".internal." segment).
# None of these exist yet at this point (all deployed in Phase 3), but their
# FQDNs are deterministic, so images can bake in working values now.
GRAFANA_EXTERNAL_FQDN="${NAME_PREFIX}-grafana.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"
# api is external (browser calls it directly with CORS) — see apps.bicep's
# header comment for why this isn't proxied through web anymore.
API_EXTERNAL_FQDN="${NAME_PREFIX}-api.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"
WEB_EXTERNAL_FQDN="${NAME_PREFIX}-web.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"

echo "ACR: $ACR_LOGIN_SERVER"
echo "Qdrant internal URL: $QDRANT_INTERNAL_URL"
echo "api will be reachable at: https://$API_EXTERNAL_FQDN"
echo "Jaeger UI: https://$JAEGER_EXTERNAL_FQDN"

if [ "$SKIP_BUILD" = "true" ]; then
  echo "== Phase 2: skipped (SKIP_BUILD=true) — reusing image tag $IMAGE_TAG =="
else
  echo "== Phase 2a: build+push api image (server-side, via ACR Tasks) =="
  az acr build \
    --registry "$ACR_NAME" \
    --image "lexguard-api:$IMAGE_TAG" \
    --file "$REPO_ROOT/apps/api/Dockerfile" \
    "$REPO_ROOT"

  echo "== Phase 2b: build+push web image =="
  az acr build \
    --registry "$ACR_NAME" \
    --image "lexguard-web:$IMAGE_TAG" \
    --file "$REPO_ROOT/apps/web/Dockerfile" \
    --build-arg NEXT_PUBLIC_API_BASE_URL="https://$API_EXTERNAL_FQDN" \
    --build-arg API_INTERNAL_URL="http://$API_INTERNAL_FQDN" \
    --build-arg NEXT_PUBLIC_GRAFANA_URL="https://$GRAFANA_EXTERNAL_FQDN" \
    --build-arg NEXT_PUBLIC_JAEGER_URL="https://$JAEGER_EXTERNAL_FQDN" \
    --build-arg NEXT_PUBLIC_DEV_TENANT_ID="00000000-0000-0000-0000-000000000001" \
    --build-arg NEXT_PUBLIC_DEV_AUTH_TOKEN="dev-bypass-token" \
    "$REPO_ROOT"

  echo "== Phase 2c: build+push otel-collector image =="
  az acr build \
    --registry "$ACR_NAME" \
    --image "lexguard-otel-collector:$IMAGE_TAG" \
    --file "$REPO_ROOT/infra/otel/Dockerfile" \
    "$REPO_ROOT"

  echo "== Phase 2d: build+push prometheus image =="
  az acr build \
    --registry "$ACR_NAME" \
    --image "lexguard-prometheus:$IMAGE_TAG" \
    --file "$REPO_ROOT/infra/prometheus/Dockerfile" \
    --build-arg OTEL_COLLECTOR_TARGET="$OTEL_COLLECTOR_INTERNAL_FQDN:8888" \
    "$REPO_ROOT"

  echo "== Phase 2e: build+push grafana image =="
  az acr build \
    --registry "$ACR_NAME" \
    --image "lexguard-grafana:$IMAGE_TAG" \
    --file "$REPO_ROOT/infra/grafana/Dockerfile" \
    --build-arg PROMETHEUS_TARGET="http://$PROMETHEUS_INTERNAL_FQDN:9090" \
    "$REPO_ROOT"
fi

echo "== Phase 3: deploy api, web, otel-collector, prometheus, grafana container apps =="
JWT_PUBLIC_KEY_PEM="$(cat "$JWT_PUBLIC_KEY_PATH")"

APPS_OUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$SCRIPT_DIR/apps.bicep" \
  --parameters namePrefix="$NAME_PREFIX" \
               location="$LOCATION" \
               acrLoginServer="$ACR_LOGIN_SERVER" \
               acrPullIdentityId="$ACR_PULL_IDENTITY_ID" \
               containerAppsEnvId="$CONTAINER_APPS_ENV_ID" \
               apiImageTag="$IMAGE_TAG" \
               webImageTag="$IMAGE_TAG" \
               otelCollectorImageTag="$IMAGE_TAG" \
               prometheusImageTag="$IMAGE_TAG" \
               grafanaImageTag="$IMAGE_TAG" \
               jaegerOtlpEndpoint="$JAEGER_OTLP_ENDPOINT" \
               grafanaAdminPassword="$GRAFANA_ADMIN_PASSWORD" \
               allowedOrigins="https://$WEB_EXTERNAL_FQDN" \
               databaseUrl="$DATABASE_URL" \
               qdrantInternalUrl="$QDRANT_INTERNAL_URL" \
               qdrantApiKey="$QDRANT_API_KEY" \
               azureOpenAiApiKey="$AZURE_OPENAI_API_KEY" \
               azureOpenAiEndpoint="$AZURE_OPENAI_ENDPOINT" \
               azureOpenAiApiVersion="$AZURE_OPENAI_API_VERSION" \
               azureOpenAiDeployment="$AZURE_OPENAI_DEPLOYMENT" \
               azureOpenAiDeploymentMini="$AZURE_OPENAI_DEPLOYMENT_MINI" \
               azureOpenAiEmbeddingDeployment="$AZURE_OPENAI_EMBEDDING_DEPLOYMENT" \
               jwtPublicKeyPem="$JWT_PUBLIC_KEY_PEM" \
               enkryptEnabled="$ENKRYPT_ENABLED" \
               lexisNexisEnabled="$LEXISNEXIS_ENABLED" \
               hitlEnabled="$HITL_ENABLED" \
  --query properties.outputs -o json)

WEB_FQDN=$(echo "$APPS_OUT" | jq -r '.webFqdn.value')
API_FQDN=$(echo "$APPS_OUT" | jq -r '.apiInternalFqdn.value')
GRAFANA_FQDN=$(echo "$APPS_OUT" | jq -r '.grafanaFqdn.value')

echo ""
echo "== Done =="
echo "Web:          https://$WEB_FQDN"
echo "API:          https://$API_FQDN  (external — browser calls this directly, CORS-restricted to the web origin)"
echo "Grafana:      https://$GRAFANA_FQDN  (user: admin)"
echo "Jaeger:       https://$JAEGER_EXTERNAL_FQDN"
echo ""
if [ "$API_FQDN" != "$API_EXTERNAL_FQDN" ]; then
  echo "NOTE: the web image was built assuming NEXT_PUBLIC_API_BASE_URL=https://$API_EXTERNAL_FQDN"
  echo "      but the actual api FQDN is $API_FQDN. Re-run this script (or just"
  echo "      the Phase 2b + Phase 3 steps) to rebuild web with the correct address baked in."
fi
echo ""
echo "Next: run 'pnpm --filter @lexguard/api db:migrate:deploy' and 'pnpm qdrant:init'"
echo "against this environment (see DEPLOYMENT.md) before using the app."
