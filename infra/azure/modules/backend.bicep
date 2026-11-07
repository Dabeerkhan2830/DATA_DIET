// FastAPI backend on App Service Linux (built-in Python runtime, zip deploy).
//
// Runtime shape, verified against Microsoft Learn:
//   * Python is Linux-only on App Service today, so `kind` carries `linux`.
//   * The built-in image puts nginx in front and expects the app on 127.0.0.1
//     :8000, which is why the startup command binds port 8000 rather than $PORT
//     (`$PORT`/`WEBSITES_PORT` belong to custom containers, not this flow).
//   * `--proxy-headers` is safe here because nginx inside the container is the
//     only immediate peer. Do NOT widen `--forwarded-allow-ips` to `*`: the
//     public endpoint would then accept spoofed X-Forwarded-* headers.
//   * Oryx installs dependencies at deploy time only when it finds
//     requirements.txt at the root of the deployed folder, which is why the
//     deployment package is built from `backend/` (see the deploy workflow).
//
// Secrets are never inlined. Both DATABASE_URL and AUTH_JWT_SECRET are Key Vault
// references resolved by the platform at start-up, so the runtime identity needs
// "Key Vault Secrets User" on the vault (wired in main.bicep).

param name string
param location string
param tags object = {}

param planName string

@description('User-assigned managed identity for the site, created by main.bicep so the Key Vault role assignment and the site can both reference it without a circular module dependency.')
param identityResourceId string

@description('Principal id of the same identity, used to grant "Key Vault Secrets User" on the vault.')
param identityPrincipalId string

@description('App Service SKU name for the Linux plan: B1/B2/B3, S1-S3, P0v3-P3v3 or P1mv4-P5mv4. There is no B1v3. F1/Shared cannot run Linux.')
param appServiceSkuName string = 'B1'

param appServiceInstanceCount int = 2

@description('Python runtime for the built-in image, as it appears in `az webapp list-runtimes --os linux`. Verify the exact patch string before the first deployment.')
param pythonVersion string = '3.12'

@description('App Service Startup Command. The package root is backend/, so app.main:app resolves without --chdir.')
param startupCommand string = 'python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers'

@description('Unauthenticated liveness path. /api/v1/health never touches the database; /api/v1/health/ready does and answers 503 when the database is unreachable.')
param healthCheckPath string = '/api/v1/health'

@description('ENVIRONMENT as the application reads it. Anything other than production leaves the development secret and dev-login available (ADR-0014), so production deployments must set "production".')
@allowed([
  'development'
  'production'
])
param appEnvironment string = 'production'

@description('Browser origins allowed to call the API. Written to CORS_ORIGINS as a comma-separated list; HTTPS-only origins only.')
param corsOrigins array = []

param demoDataEnabled bool = false

@description('JSON object of allow-listed local source roots. App Service has no durable user filesystem, so the documented default {} keeps local-folder connectors unavailable.')
param localSourceRoots string = '{}'

param scanMaxRecords int = 5000

param scanBatchSize int = 500

param authJwtIssuer string = 'datadiet-api'

param authJwtAudience string = 'datadiet-api'

param authTokenTtlSeconds int = 3600

@description('Development sign-in provider. Ignored by the application in production, where the code disables it unconditionally; set false so the intent is visible in the resource.')
param authDevProviderEnabled bool = false

@description('Vault base URI used to build @Microsoft.KeyVault(SecretUri=...) references, e.g. https://myvault.vault.azure.net/.')
param keyVaultUri string

param databaseUrlSecretName string = 'datadiet-database-url'

param authJwtSecretName string = 'datadiet-auth-jwt-secret'

@description('Application Insights connection string. Only meaningful once the app actually emits telemetry — the OpenTelemetry/Azure Monitor agent is NOT wired into the code, so leaving this empty is the honest default.')
param applicationInsightsConnectionString string = ''

var skuTier = startsWith(appServiceSkuName, 'B')
    ? 'Basic'
    : startsWith(appServiceSkuName, 'S')
      ? 'Standard'
      : startsWith(appServiceSkuName, 'P')
        ? 'PremiumV3'
        : 'Premium'

resource plan 'Microsoft.Web/serverfarms@2025-03-01' = {
  name: planName
  location: location
  tags: tags
  // `linux` on the plan is what makes a per-app Linux plan; `reserved=true`
  // below is the parallel marker on the site. Both are listed in the
  // "unverified items" table in ../README.md because they must be confirmed
  // against the live provider on first what-if.
  kind: 'linux'
  sku: {
    name: appServiceSkuName
    tier: skuTier
    capacity: appServiceInstanceCount
  }
  properties: {
    // reserved=true is what marks a plan as Linux-capable.
    reserved: true
    zoneRedundant: false
    perSiteScaling: false
  }
}

resource site 'Microsoft.Web/sites@2025-03-01' = {
  name: name
  location: location
  tags: tags
  kind: 'app,linux'
  reserved: true
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityResourceId}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientCertEnabled: false
    keyVaultReferenceIdentity: identityResourceId
    siteConfig: {
      linuxFxVersion: 'PYTHON|${pythonVersion}'
      alwaysOn: appServiceSkuName != 'D1'
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'FtpsOnly'
      use32BitWorkerProcess: false
      healthCheckPath: healthCheckPath
      netStack: 'Other'
    }
  }
}

// The Startup Command lives on the `web` site config, not on the site itself.
resource webConfig 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: site
  name: 'web'
  properties: {
    linuxFxVersion: 'PYTHON|${pythonVersion}'
    appCommandLine: startupCommand
    healthCheckPath: healthCheckPath
    minTlsVersion: '1.2'
    ftpsState: 'FtpsOnly'
    http20Enabled: true
    alwaysOn: appServiceSkuName != 'D1'
    use32BitWorkerProcess: false
  }
}

resource settings 'Microsoft.Web/sites/config@2025-03-01' = {
  parent: site
  name: 'appsettings'
  properties: union(
    {
      ENVIRONMENT: appEnvironment
      // Comma-separated: a deployed platform can only carry flat strings, and
      // the settings model now accepts this form (backend/app/core/config.py).
      CORS_ORIGINS: join(',', corsOrigins)
      DATABASE_URL: '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${databaseUrlSecretName})'
      AUTH_JWT_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${authJwtSecretName})'
      AUTH_JWT_ISSUER: authJwtIssuer
      AUTH_JWT_AUDIENCE: authJwtAudience
      AUTH_TOKEN_TTL_SECONDS: string(authTokenTtlSeconds)
      AUTH_DEV_PROVIDER_ENABLED: string(authDevProviderEnabled)
      DEMO_DATA_ENABLED: string(demoDataEnabled)
      LOCAL_SOURCE_ROOTS: localSourceRoots
      SCAN_MAX_RECORDS: string(scanMaxRecords)
      SCAN_BATCH_SIZE: string(scanBatchSize)
      DATABASE_ECHO: 'false'
      // Oryx must run on zip/source deployments or requirements.txt is ignored.
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'true'
    },
    applicationInsightsConnectionString != ''
      ? { APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsightsConnectionString }
      : {}
  )
}

output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
output identityResourceId string = identityResourceId
output principalId string = identityPrincipalId
