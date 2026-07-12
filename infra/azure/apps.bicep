// LexGuard AI — Azure Container Apps for api + web
//
// Phase 2 of the deployment: deploy base.bicep first, `az acr build` the api
// and web images into the ACR it creates, then deploy this file with the
// resulting image tags. See ../../DEPLOYMENT.md.
//
// api is EXTERNALLY reachable, called directly by the browser with CORS
// (ALLOWED_ORIGINS below), rather than proxied through web's Next.js server.
// Originally api was internal-only with web proxying /api/v1/* server-side
// (zero-CORS design) — reverted after confirming live that Container Apps'
// internal HTTP ingress resets the connection on proxied POST requests with
// a body (multipart file uploads specifically; plain GETs worked fine).
// Internal ingress on this environment has now shown two distinct
// reliability problems (this, and TCP-transport ingress for Redis — see
// base.bicep), so external+CORS was chosen as the reliable, standard path
// rather than continuing to debug the internal proxy layer.

@description('Same prefix used in base.bicep.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'lexguard'

param location string = resourceGroup().location

@description('ACR login server from base.bicep output (acrLoginServer).')
param acrLoginServer string

@description('Resource ID of the user-assigned identity from base.bicep output (acrPullIdentityId).')
param acrPullIdentityId string

@description('Container Apps Environment resource ID from base.bicep output (containerAppsEnvId).')
param containerAppsEnvId string

@description('Image tag for the api image, e.g. output of `az acr build ... --image lexguard-api:<tag>`.')
param apiImageTag string

@description('Image tag for the web image.')
param webImageTag string

@secure()
param databaseUrl string

@description('Comma-separated browser origins allowed to call api (CORS) — web app external FQDN.')
param allowedOrigins string

// Redis runs as a sidecar container inside apiApp below (localhost:6379) —
// no param needed. See base.bicep for why: TCP-transport internal ingress
// was confirmed live to time out between container apps in this environment.

param qdrantInternalUrl string

@secure()
param qdrantApiKey string

@secure()
param azureOpenAiApiKey string

param azureOpenAiEndpoint string
param azureOpenAiApiVersion string = '2024-10-01-preview'
param azureOpenAiDeployment string
param azureOpenAiDeploymentMini string = ''
param azureOpenAiEmbeddingDeployment string

@description('PEM contents of the RS256 public key used to verify JWTs (contents of apps/api/keys/public.pem).')
@secure()
param jwtPublicKeyPem string

param jwtIssuer string = 'https://api.lexguard.ai'
param jwtAudience string = 'lexguard-api'

@description('Bypasses real JWT verification (apps/api/src/middleware/auth.ts) and injects a fake authenticated admin user on every request. Purpose-built dev/demo escape hatch already in the codebase — appropriate for demonstrating the agent pipeline, NOT for anything handling real customer data/auth. Set to "false" once real signed JWTs are wired up for this environment.')
param devBypassAuth string = 'true'

param enkryptEnabled string = 'false'
param lexisNexisEnabled string = 'false'
param hitlEnabled string = 'true'

@description('Image tag for the otel-collector image (infra/otel/Dockerfile).')
param otelCollectorImageTag string

@description('Image tag for the prometheus image (infra/prometheus/Dockerfile).')
param prometheusImageTag string

@description('Image tag for the grafana image (infra/grafana/Dockerfile).')
param grafanaImageTag string

@description('Jaeger OTLP gRPC endpoint from base.bicep output (jaegerInternalOtlpEndpoint) — where the collector ships traces.')
param jaegerOtlpEndpoint string

@description('Grafana admin password — required (no default): Grafana is externally reachable, so this must not silently fall back to a weak default.')
@secure()
param grafanaAdminPassword string

var apiName = '${namePrefix}-api'
var webName = '${namePrefix}-web'
var otelCollectorName = '${namePrefix}-otel-collector'
var prometheusName = '${namePrefix}-prometheus'
var grafanaName = '${namePrefix}-grafana'

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${acrPullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvId
    configuration: {
      ingress: {
        // External: browser calls this directly with CORS (ALLOWED_ORIGINS
        // env var below) instead of going through web's proxy — see the
        // file header comment for why. Already behind JWT auth on every
        // protected route, same security model as any public API.
        external: true
        targetPort: 4000
        transport: 'http'
      }
      registries: [
        { server: acrLoginServer, identity: acrPullIdentityId }
      ]
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'qdrant-api-key', value: qdrantApiKey }
        { name: 'azure-openai-api-key', value: azureOpenAiApiKey }
        { name: 'jwt-public-key-pem', value: jwtPublicKeyPem }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${acrLoginServer}/lexguard-api:${apiImageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            // Redis is a sidecar container in this same app (see the
            // `redis` container below) — same revision, same network
            // namespace, reachable at localhost with no ingress involved.
            { name: 'REDIS_URL', value: 'redis://localhost:6379' }
            { name: 'QDRANT_URL', value: qdrantInternalUrl }
            { name: 'QDRANT_API_KEY', secretRef: 'qdrant-api-key' }
            { name: 'AZURE_OPENAI_API_KEY', secretRef: 'azure-openai-api-key' }
            { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
            { name: 'AZURE_OPENAI_API_VERSION', value: azureOpenAiApiVersion }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: azureOpenAiDeployment }
            { name: 'AZURE_OPENAI_DEPLOYMENT_MINI', value: azureOpenAiDeploymentMini }
            { name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', value: azureOpenAiEmbeddingDeployment }
            // Inline PEM instead of a mounted file — see JWT_RS256_PUBLIC_KEY_PEM
            // in packages/shared/src/env.ts, which takes precedence over
            // JWT_RS256_PUBLIC_KEY_PATH when set.
            { name: 'JWT_RS256_PUBLIC_KEY_PEM', secretRef: 'jwt-public-key-pem' }
            { name: 'JWT_ISSUER', value: jwtIssuer }
            { name: 'JWT_AUDIENCE', value: jwtAudience }
            { name: 'API_PORT', value: '4000' }
            { name: 'API_HOST', value: '0.0.0.0' }
            { name: 'ALLOWED_ORIGINS', value: allowedOrigins }
            { name: 'LEXGUARD_DEV_BYPASS_AUTH', value: devBypassAuth }
            { name: 'ENKRYPT_ENABLED', value: enkryptEnabled }
            { name: 'LEXISNEXIS_ENABLED', value: lexisNexisEnabled }
            { name: 'HITL_ENABLED', value: hitlEnabled }
            // Was previously unset here, silently defaulting to
            // http://localhost:4318 inside the container (i.e. nowhere) —
            // tracing/metrics export was a no-op until this pointed at a
            // real collector.
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://${otelCollectorApp.properties.configuration.ingress.fqdn}' }
            { name: 'OTEL_SERVICE_NAME', value: 'lexguard-api' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 4000 }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
            {
              // Readiness gates whether this replica gets traffic. Points at
              // /health (200 whenever the HTTP server is listening), NOT
              // /ready — /ready returns 503 if postgres/redis/qdrant is
              // degraded, which would pull EVERY replica out of rotation and
              // make the whole API return Azure's "Container App -
              // Unavailable" page for all requests (confirmed live: a single
              // failing qdrant check took the entire API offline). Downstream
              // health is a monitoring concern (/ready still exists for that,
              // and per-request failures surface as normal 5xx), not a reason
              // to refuse all traffic. failureThreshold is generous so a slow
              // cold start doesn't flap the replica out.
              type: 'Readiness'
              httpGet: { path: '/health', port: 4000 }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
        {
          name: 'redis'
          image: 'redis:7-alpine'
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      // Capped at 1 replica: redis runs as a sidecar in this same app now
      // (see above), so every replica would otherwise get its own
      // independent, unsynchronized Redis instance — breaking shared
      // rate-limiting/circuit-breaker state across replicas. Revisit if
      // this ever needs to scale beyond one instance (would need a real
      // shared Redis reachable by all replicas instead).
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: webName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${acrPullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvId
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        // Add a custom domain + managed certificate here once you have one
        // (`az containerapp hostname add` / `bind`), see DEPLOYMENT.md.
      }
      registries: [
        { server: acrLoginServer, identity: acrPullIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          // API_INTERNAL_URL is baked into this image at build time (Next.js
          // resolves rewrites() once, at `next build` — see apps/web/Dockerfile
          // comment). It must already point at apiApp's internal FQDN by the
          // time this image was built with `az acr build`.
          image: '${acrLoginServer}/lexguard-web:${webImageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

// ─── OTel Collector (internal-only — api ships traces/metrics here) ──────────

resource otelCollectorApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: otelCollectorName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${acrPullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvId
    configuration: {
      ingress: {
        external: false
        targetPort: 4318
        transport: 'http'
        // Container Apps ingress defaults to forcing HTTP->HTTPS redirects
        // even on internal-only ingress — api reaches this over plain
        // http://<internal-fqdn> (OTEL_EXPORTER_OTLP_ENDPOINT above), which
        // would otherwise 301 and break every trace/metric export.
        allowInsecure: true
        // Prometheus needs to reach the collector's own metrics-exporter
        // port (8888, see infra/otel/collector-config.yml's `prometheus`
        // exporter) separately from the OTLP receiver port (4318) that api
        // posts traces/metrics to.
        additionalPortMappings: [
          { targetPort: 8888, exposedPort: 8888, external: false }
        ]
      }
      registries: [
        { server: acrLoginServer, identity: acrPullIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'otel-collector'
          image: '${acrLoginServer}/lexguard-otel-collector:${otelCollectorImageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'JAEGER_ENDPOINT', value: jaegerOtlpEndpoint }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ─── Prometheus (internal-only — scraped by Grafana) ──────────────────────────

resource prometheusApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: prometheusName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${acrPullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvId
    configuration: {
      ingress: {
        external: false
        targetPort: 9090
        transport: 'http'
        // Container Apps ingress defaults to forcing HTTP->HTTPS redirects
        // even on internal-only ingress — grafana reaches this over plain
        // http://<internal-fqdn> (its datasource config, baked in at image
        // build time), which would otherwise 301 and break every query.
        allowInsecure: true
      }
      registries: [
        { server: acrLoginServer, identity: acrPullIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'prometheus'
          // Scrape target (otel-collector:8888) is baked in at build time —
          // see infra/prometheus/Dockerfile's OTEL_COLLECTOR_TARGET build-arg.
          image: '${acrLoginServer}/lexguard-prometheus:${prometheusImageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ─── Grafana (external — human-facing dashboard) ──────────────────────────────

resource grafanaApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: grafanaName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${acrPullIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvId
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
      }
      registries: [
        { server: acrLoginServer, identity: acrPullIdentityId }
      ]
      secrets: [
        { name: 'grafana-admin-password', value: grafanaAdminPassword }
      ]
    }
    template: {
      containers: [
        {
          name: 'grafana'
          // Datasource URL (prometheus:9090) is baked in at build time — see
          // infra/grafana/Dockerfile's PROMETHEUS_TARGET build-arg.
          image: '${acrLoginServer}/lexguard-grafana:${grafanaImageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'GF_SECURITY_ADMIN_PASSWORD', secretRef: 'grafana-admin-password' }
            { name: 'GF_SECURITY_ADMIN_USER', value: 'admin' }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output webFqdn string = webApp.properties.configuration.ingress.fqdn
output apiInternalFqdn string = apiApp.properties.configuration.ingress.fqdn
output grafanaFqdn string = grafanaApp.properties.configuration.ingress.fqdn
