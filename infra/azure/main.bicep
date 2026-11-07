// DataDiet — Azure landing template (resource-group scope).
//
// NOTHING HERE DEPLOYS. This is the infrastructure shape a future Azure
// deployment provisions; it has never been applied, and no subscription,
// tenant, region, hostname or tier is baked in (docs/azure-architecture.md).
//
// What is intentionally NOT in this template, and why:
//   * Secret values. The vault is created empty; an operator writes the
//     DATABASE_URL and AUTH_JWT_SECRET secrets
//     (docs/azure-deployment.md section 4). A value in a template, a parameter
//     file or a CI log is a leaked value.
//   * Application migrations. Alembic stays a human-gated, reviewed operation
//     (docs/setup.md section 8, ADR-0018); no pipeline runs it against
//     production.
//   * App Service VNet integration. Required for a private vault or a
//     private-only MySQL to be reachable from the backend, but its site child
//     resource shape is not verified here; the CLI path is documented instead.
//   * A Log Analytics workspace. It bills on ingestion, so it must be an
//     explicit, existing resource rather than a side effect.
//
// Deploy (only once credentials and a resource group exist):
//   az deployment group create \
//     --resource-group <rg> \
//     --template-file infra/azure/main.bicep \
//     --parameters @infra/azure/params/dev.parameters.json

targetScope = 'resourceGroup'

// ------------------------------------------------------------------ identity
@description('Which environment this deployment is. Drives naming, tags and fail-closed application settings.')
@allowed([
  'dev'
  'prod'
])
param environment string

@description('Azure region for every resource, e.g. westeurope. Must support App Service, MySQL Flexible Server and Static Web Apps together; verify with `az provider` / the product availability pages before committing.')
param location string

@description('Short globally-unique token (3-10 lowercase alphanumerics) appended to names that must be unique across all of Azure: the API app, the Static Web App, the vault and the MySQL server.')
@minLength(3)
@maxLength(10)
param nameToken string

@description('Common prefix for all resource names. Keep it short: vault names are capped at 24 characters.')
param namePrefix string = 'datadiet'

param tags object = {}

var baseTags = union(
  {
    project: 'datadiet'
    environment: environment
    managedBy: 'infra/azure/main.bicep'
  },
  tags
)

var backendAppName = '${namePrefix}-${environment}-api-${nameToken}'
var appPlanName = '${namePrefix}-${environment}-plan'
var identityName = '${namePrefix}-${environment}-api-id'
var frontendName = '${namePrefix}-${environment}-web-${nameToken}'
var keyVaultName = '${namePrefix}${environment}kv${nameToken}'
var mysqlServerName = '${replace(namePrefix, '-', '')}${environment}mysql${nameToken}'
var appEnvironment = environment == 'prod' ? 'production' : 'development'

// --------------------------------------------------------------- application
@description('Browser origins allowed to call the API, HTTPS-only. Written to CORS_ORIGINS as a comma-separated list. Set this to the Static Web App endpoint and/or the custom domain.')
param backendCorsOrigins array = []

@description('Synthetic demo endpoints. Off by default: on a network-reachable deployment they should not exist (docs/production-readiness.md section 9).')
param demoDataEnabled bool = false

param authJwtIssuer string = 'datadiet-api'

param authJwtAudience string = 'datadiet-api'

@description('Bearer token lifetime in seconds; the application validates 60..86400.')
param authTokenTtlSeconds int = 3600

@description('Development sign-in. Forcibly ignored when ENVIRONMENT=production. Turning it on for an Azure dev environment means anyone who can reach it can mint a synthetic account token, so it is false by default and only acceptable behind network restrictions.')
param authDevProviderEnabled bool = false

param databaseUrlSecretName string = 'datadiet-database-url'

param authJwtSecretName string = 'datadiet-auth-jwt-secret'

@description('App Service SKU for the Linux plan (B1-B3, S1-S3, P0v3-P3v3). B1 disables Always On; production wants at least S1 or P1v3.')
param appServiceSkuName string = 'B1'

param appServiceInstanceCount int = 2

@description('Python runtime as listed by `az webapp list-runtimes --os linux`. Confirm the exact value before the first deployment.')
param pythonVersion string = '3.12'

// ------------------------------------------------------------------ frontend
@description('Free has no SLA and no private endpoints; Standard is the production choice.')
@allowed([
  'Free'
  'Standard'
])
param frontendSku string = 'Free'

@description('Public hostname already verified in DNS. Empty keeps the *.azurestaticapps.net endpoint.')
param frontendCustomDomain string = ''

// ------------------------------------------------------------------ database
@description('"8.4" requires the preview api-version in modules/mysql.bicep; "8.0" works with the stable one. The two are coupled — change them together.')
@allowed([
  '8.0'
  '8.4'
])
param mysqlVersion string = '8.4'

param mysqlSkuName string = 'Burstable_B2s'

param mysqlSkuCapacity int = 2

param mysqlStorageSizeGb int = 32

param mysqlBackupRetentionDays int = 7

@description('Geo-redundant backup, roughly doubling backup storage cost. A deliberate per-environment decision.')
param mysqlGeoRedundantBackup bool = false

@description('Zone-redundant HA doubles compute cost. Off by default.')
param mysqlHighAvailability bool = false

param mysqlAdministratorLogin string

@description('MySQL server administrator password. Reference it from Key Vault in the parameter file ("reference": {"keyVault": {...}}) — never commit or echo a value.')
@secure()
param mysqlAdministratorLoginPassword string

param mysqlDatabaseName string = 'datadiet'

@description('Immutable after creation. "public" needs mysqlFirewallRules pinned to the App Service outbound addresses; the private modes also need App Service VNet integration before the backend can reach the server (docs/azure-deployment.md section 6).')
@allowed([
  'public'
  'private-endpoint'
  'delegated'
])
param mysqlNetworkMode string = 'public'

@description('SQL firewall rules for public mode: [{name, startIpAddress, endIpAddress}].')
param mysqlFirewallRules array = []

// ----------------------------------------------------------------- networking
param addressPrefixes array = ['10.70.0.0/16']

param privateEndpointSubnetPrefix string = '10.70.1.0/28'

param mysqlDelegatedSubnetPrefix string = '10.70.2.0/28'

var needsVnet = mysqlNetworkMode != 'public'

// ------------------------------------------------------------------ keyvault
@description('Let Azure services and App Service reach the vault over its public endpoint. Key Vault references in application settings cannot resolve without this unless the backend has VNet integration.')
param keyVaultAllowPublicAccess bool = true

@description('CIDR ranges allowed to reach the vault when public access is on. An empty list is development-only.')
param keyVaultFirewallIpRanges array = []

@description('Put a private endpoint on the vault. Implies a VNet and, for the backend to use it, App Service VNet integration.')
param keyVaultPrivateAccess bool = false

var needsPrivateEndpoints = keyVaultPrivateAccess || mysqlNetworkMode == 'private-endpoint'
var keyVaultUri = 'https://${keyVaultName}.vault.azure.net/'

// 'Key Vault Secrets User' — read-only secret access, enough to resolve an
// application-setting reference and nothing more.
var keyVaultSecretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'

// --------------------------------------------------------------- monitoring
@description('Resource id of an EXISTING Log Analytics workspace. Leave empty to skip Application Insights entirely — it is billed on ingestion and the app emits no AI telemetry yet.')
param logAnalyticsWorkspaceResourceId string = ''

var enableMonitoring = logAnalyticsWorkspaceResourceId != ''

// ------------------------------------------------------------------ modules
resource backendIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: baseTags
}

module network './modules/network.bicep' = if (needsVnet || needsPrivateEndpoints) {
  name: 'network'
  params: {
    namePrefix: namePrefix
    location: location
    tags: baseTags
    addressPrefixes: addressPrefixes
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    mysqlDelegatedSubnetPrefix: mysqlDelegatedSubnetPrefix
    enableMysqlDelegation: mysqlNetworkMode == 'delegated'
    enablePrivateEndpoints: needsPrivateEndpoints
  }
}

module vault './modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: keyVaultName
    location: location
    tags: baseTags
    allowPublicAccess: keyVaultAllowPublicAccess
    firewallIpRanges: keyVaultFirewallIpRanges
    privateEndpointSubnetId: keyVaultPrivateAccess ? network.outputs.privateEndpointSubnetId : ''
    privateDnsZoneId: keyVaultPrivateAccess ? network.outputs.keyVaultPrivateDnsZoneId : ''
    roleAssignments: [
      {
        principalId: backendIdentity.properties.principalId
        roleDefinitionId: keyVaultSecretsUserRole
      }
    ]
  }
}

module mysql './modules/mysql.bicep' = {
  name: 'mysql'
  params: {
    name: mysqlServerName
    location: location
    tags: baseTags
    version: mysqlVersion
    skuName: mysqlSkuName
    skuCapacity: mysqlSkuCapacity
    storageSizeGb: mysqlStorageSizeGb
    backupRetentionDays: mysqlBackupRetentionDays
    geoRedundantBackup: mysqlGeoRedundantBackup
    highAvailability: mysqlHighAvailability
    administratorLogin: mysqlAdministratorLogin
    administratorLoginPassword: mysqlAdministratorLoginPassword
    databaseName: mysqlDatabaseName
    networkMode: mysqlNetworkMode
    firewallRules: mysqlFirewallRules
    privateEndpointSubnetId: mysqlNetworkMode == 'private-endpoint'
      ? network.outputs.privateEndpointSubnetId
      : ''
    privateDnsZoneId: needsVnet ? network.outputs.mysqlPrivateDnsZoneId : ''
    delegatedSubnetId: mysqlNetworkMode == 'delegated'
      ? network.outputs.mysqlDelegatedSubnetId
      : ''
  }
}

module backend './modules/backend.bicep' = {
  name: 'backend'
  params: {
    name: backendAppName
    planName: appPlanName
    location: location
    tags: baseTags
    identityResourceId: backendIdentity.id
    identityPrincipalId: backendIdentity.properties.principalId
    appServiceSkuName: appServiceSkuName
    appServiceInstanceCount: appServiceInstanceCount
    pythonVersion: pythonVersion
    healthCheckPath: '/api/v1/health'
    appEnvironment: appEnvironment
    corsOrigins: backendCorsOrigins
    demoDataEnabled: demoDataEnabled
    authJwtIssuer: authJwtIssuer
    authJwtAudience: authJwtAudience
    authTokenTtlSeconds: authTokenTtlSeconds
    authDevProviderEnabled: authDevProviderEnabled
    keyVaultUri: keyVaultUri
    databaseUrlSecretName: databaseUrlSecretName
    authJwtSecretName: authJwtSecretName
    applicationInsightsConnectionString: ''
  }
}

module frontend './modules/frontend.bicep' = {
  name: 'frontend'
  params: {
    name: frontendName
    location: location
    tags: baseTags
    sku: frontendSku
    customDomain: frontendCustomDomain
  }
}

module monitoring './modules/monitoring.bicep' = if (enableMonitoring) {
  name: 'monitoring'
  params: {
    name: '${namePrefix}-${environment}-ai'
    location: location
    tags: baseTags
    workspaceResourceId: logAnalyticsWorkspaceResourceId
  }
}

// ------------------------------------------------------------------- outputs
output backendUrl string = 'https://${backend.outputs.defaultHostName}'
output frontendUrl string = 'https://${frontend.outputs.defaultHostname}'
output keyVaultName string = vault.outputs.vaultName
output mysqlFullyQualifiedDomainName string = mysql.outputs.fullyQualifiedDomainName
output mysqlPort int = mysql.outputs.port
output backendManagedIdentityPrincipalId string = backendIdentity.properties.principalId

@description('Origins to paste into backendCorsOrigins once the frontend hostname is known.')
output suggestedCorsOrigins array = ['https://${frontend.outputs.defaultHostname}']
