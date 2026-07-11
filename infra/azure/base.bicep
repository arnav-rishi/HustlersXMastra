// LexGuard AI — Azure base infrastructure (Container Apps Environment + data services)
//
// Phase 1 of the deployment: everything that doesn't depend on the api/web
// container images existing yet. Deploy this first, build+push images to the
// ACR it creates, then deploy apps.bicep. See ../../DEPLOYMENT.md.
//
// Deliberately does NOT provision a custom VNet: a Container Apps managed
// environment gets its own internal network regardless, and apps with
// ingress: "internal" are only reachable from other apps in the same
// environment (verified against Azure docs for Microsoft.App/managedEnvironments;
// not deployed/tested against a live subscription — run `az bicep build`
// against this file and `az deployment group what-if` before applying).

@description('Short, unique name used as a prefix for all resources (e.g. "lexguard"). Keep it lowercase/alphanumeric — it feeds into globally-unique resource names.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'lexguard'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Administrator username for the Postgres Flexible Server.')
param postgresAdminUsername string = 'lexguard'

@description('Administrator password for the Postgres Flexible Server.')
@secure()
param postgresAdminPassword string

@description('Postgres database name.')
param postgresDatabaseName string = 'lexguard_db'

@description('API key Qdrant will require on every request (used as QDRANT_API_KEY by the api container too).')
@secure()
param qdrantApiKey string

var uniqueSuffix = uniqueString(resourceGroup().id)
var acrName = '${namePrefix}acr${uniqueSuffix}'
var storageAccountName = take('${namePrefix}st${uniqueSuffix}', 24)
var qdrantShareName = 'qdrant-storage'

// ─── Log Analytics (required by Container Apps Environment) ──────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ─── Container Registry ───────────────────────────────────────────────────────

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

// User-assigned identity the Container Apps use to pull from ACR (no admin
// credentials stored anywhere).
resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-acr-pull'
  location: location
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, acrPullIdentity.id, 'AcrPull')
  scope: acr
  properties: {
    principalId: acrPullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    // Built-in "AcrPull" role
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// ─── Storage for Qdrant persistence (Container Apps have no local disk) ──────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource qdrantShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: qdrantShareName
  properties: {
    shareQuota: 50
  }
}

// ─── Container Apps Environment ───────────────────────────────────────────────

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource qdrantStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppsEnv
  name: 'qdrant-storage'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: qdrantShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ─── Postgres Flexible Server (replaces the local Docker postgres) ───────────

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${namePrefix}-pg-${uniqueSuffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminUsername
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgres
  name: postgresDatabaseName
}

// Container Apps aren't VNet-integrated here, so they reach Postgres over the
// public endpoint via TLS. This rule allows traffic that originates from
// other Azure services/resources (Container Apps included) — not the entire
// internet. Tighten with VNet integration + private access if this ever
// needs to be locked down further.
resource postgresFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ─── Redis Cache (replaces the local Docker redis) ────────────────────────────

resource redis 'Microsoft.Cache/redis@2023-08-01' = {
  name: '${namePrefix}-redis-${uniqueSuffix}'
  location: location
  properties: {
    sku: { name: 'Basic', family: 'C', capacity: 0 }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
  }
}

// ─── Qdrant (self-hosted container app, internal-only ingress) ───────────────

resource qdrant 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-qdrant'
  location: location
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      ingress: {
        external: false
        targetPort: 6333
        transport: 'http'
      }
      secrets: [
        { name: 'qdrant-api-key', value: qdrantApiKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'qdrant'
          image: 'qdrant/qdrant:v1.10.0'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'QDRANT__SERVICE__API_KEY', secretRef: 'qdrant-api-key' }
          ]
          volumeMounts: [
            { volumeName: 'qdrant-data', mountPath: '/qdrant/storage' }
          ]
        }
      ]
      volumes: [
        { name: 'qdrant-data', storageType: 'AzureFile', storageName: qdrantStorage.name }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ─── Outputs consumed by apps.bicep / deploy scripts ──────────────────────────

output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output acrPullIdentityId string = acrPullIdentity.id
output containerAppsEnvId string = containerAppsEnv.id
output containerAppsEnvDefaultDomain string = containerAppsEnv.properties.defaultDomain
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output postgresDatabaseUrl string = 'postgresql://${postgresAdminUsername}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/${postgresDatabaseName}?sslmode=require'
output redisHost string = redis.properties.hostName
output redisUrl string = 'rediss://:${redis.listKeys().primaryKey}@${redis.properties.hostName}:${redis.properties.sslPort}'
output qdrantInternalUrl string = 'http://${qdrant.properties.configuration.ingress.fqdn}'
