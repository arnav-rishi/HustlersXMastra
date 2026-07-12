// LexGuard AI — Azure Container Apps for api + web
//
// Phase 2 of the deployment: deploy base.bicep first, `az acr build` the api
// and web images into the ACR it creates, then deploy this file with the
// resulting image tags. See ../../DEPLOYMENT.md.
//
// api gets INTERNAL-ONLY ingress — it is never reached directly by a browser.
// web is the only externally-facing app; its Next.js server proxies
// /api/v1/* to api's internal FQDN (see apps/web/next.config.mjs), so the
// browser only ever talks to one origin and CORS is a non-issue.
//
// Not deployed/tested against a live subscription — run `az bicep build`
// against this file and `az deployment group what-if` before applying.

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

@secure()
param redisUrl string

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
        external: false
        targetPort: 4000
        transport: 'http'
      }
      registries: [
        { server: acrLoginServer, identity: acrPullIdentityId }
      ]
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'redis-url', value: redisUrl }
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
            { name: 'REDIS_URL', secretRef: 'redis-url' }
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
              type: 'Readiness'
              httpGet: { path: '/ready', port: 4000 }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
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
