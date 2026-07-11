#!/usr/bin/env bash
# LexGuard AI — Azure Container Apps deployment
#
# Orchestrates the two-phase deploy described in DEPLOYMENT.md:
#   1. base.bicep  — Container Apps Environment, ACR, Postgres, Redis, Qdrant
#   2. az acr build — builds api/web images server-side (no local docker push)
#   3. apps.bicep  — api (internal-only) + web (external) container apps
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
#
# Optional:
#   NAME_PREFIX               default "lexguard"
#   AZURE_OPENAI_DEPLOYMENT_MINI
#   AZURE_OPENAI_API_VERSION
#   ENKRYPT_ENABLED / LEXISNEXIS_ENABLED / HITL_ENABLED  default false/false/true

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

NAME_PREFIX="${NAME_PREFIX:-lexguard}"
AZURE_OPENAI_DEPLOYMENT_MINI="${AZURE_OPENAI_DEPLOYMENT_MINI:-}"
AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-2024-10-01-preview}"
ENKRYPT_ENABLED="${ENKRYPT_ENABLED:-false}"
LEXISNEXIS_ENABLED="${LEXISNEXIS_ENABLED:-false}"
HITL_ENABLED="${HITL_ENABLED:-true}"
IMAGE_TAG="$(date +%Y%m%d%H%M%S)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "== Phase 0: resource group =="
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "== Phase 1: base infrastructure (Container Apps Env, ACR, Postgres, Redis, Qdrant) =="
BASE_OUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$SCRIPT_DIR/base.bicep" \
  --parameters namePrefix="$NAME_PREFIX" \
               postgresAdminPassword="$POSTGRES_ADMIN_PASSWORD" \
               qdrantApiKey="$QDRANT_API_KEY" \
  --query properties.outputs -o json)

ACR_NAME=$(echo "$BASE_OUT" | jq -r '.acrName.value')
ACR_LOGIN_SERVER=$(echo "$BASE_OUT" | jq -r '.acrLoginServer.value')
ACR_PULL_IDENTITY_ID=$(echo "$BASE_OUT" | jq -r '.acrPullIdentityId.value')
CONTAINER_APPS_ENV_ID=$(echo "$BASE_OUT" | jq -r '.containerAppsEnvId.value')
CONTAINER_APPS_ENV_DEFAULT_DOMAIN=$(echo "$BASE_OUT" | jq -r '.containerAppsEnvDefaultDomain.value')
DATABASE_URL=$(echo "$BASE_OUT" | jq -r '.postgresDatabaseUrl.value')
REDIS_URL=$(echo "$BASE_OUT" | jq -r '.redisUrl.value')
QDRANT_INTERNAL_URL=$(echo "$BASE_OUT" | jq -r '.qdrantInternalUrl.value')

# Container Apps' internal-ingress FQDN is deterministic: <app-name>.internal.<env-default-domain>.
# Knowing this up front means the api app doesn't need to exist yet before
# building the web image with the correct proxy target baked in.
API_INTERNAL_FQDN="${NAME_PREFIX}-api.internal.${CONTAINER_APPS_ENV_DEFAULT_DOMAIN}"

echo "ACR: $ACR_LOGIN_SERVER"
echo "Qdrant internal URL: $QDRANT_INTERNAL_URL"
echo "api will be reachable internally at: http://$API_INTERNAL_FQDN"

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
  --build-arg NEXT_PUBLIC_API_BASE_URL= \
  --build-arg API_INTERNAL_URL="http://$API_INTERNAL_FQDN" \
  "$REPO_ROOT"

echo "== Phase 3: deploy api + web container apps =="
JWT_PUBLIC_KEY_PEM="$(cat "$JWT_PUBLIC_KEY_PATH")"

APPS_OUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$SCRIPT_DIR/apps.bicep" \
  --parameters namePrefix="$NAME_PREFIX" \
               acrLoginServer="$ACR_LOGIN_SERVER" \
               acrPullIdentityId="$ACR_PULL_IDENTITY_ID" \
               containerAppsEnvId="$CONTAINER_APPS_ENV_ID" \
               apiImageTag="$IMAGE_TAG" \
               webImageTag="$IMAGE_TAG" \
               databaseUrl="$DATABASE_URL" \
               redisUrl="$REDIS_URL" \
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

echo ""
echo "== Done =="
echo "Web:          https://$WEB_FQDN"
echo "API (internal, not publicly reachable): $API_FQDN"
echo ""
if [ "$API_FQDN" != "$API_INTERNAL_FQDN" ]; then
  echo "NOTE: the web image was built assuming API_INTERNAL_URL=http://$API_INTERNAL_FQDN"
  echo "      but the actual api FQDN is $API_FQDN. Re-run this script (or just"
  echo "      the Phase 2b + Phase 3 steps with API_INTERNAL_FQDN=$API_FQDN exported)"
  echo "      to rebuild web with the correct address baked in."
fi
echo ""
echo "Next: run 'pnpm db:migrate' and 'pnpm qdrant:init' against this environment"
echo "(see DEPLOYMENT.md) before using the app."
