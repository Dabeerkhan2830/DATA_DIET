// Azure Static Web Apps for the React/Vite frontend.
//
// Two build models exist and only one is assumed here:
//
//   * deploy-prebuilt (default): CI runs `npm run build` and uploads
//     `frontend/dist` with the SWA CLI. The site is created without a repository
//     binding, so nothing needs a long-lived GitHub token stored in Azure.
//   * build-from-source (`buildFromSource=true`): Azure clones the GitHub
//     repository and builds it itself. That needs `repositoryUrl`, a branch and
//     repository access — for a private repository the platform stores a GitHub
//     credential, which is exactly the permanent-credential pattern this repo
//     avoids (AGENTS.md / docs/production-readiness.md section 9). It stays off
//     unless someone decides otherwise.
//
// SKUs: only Free and Standard remain (the Dedicated plan was retired
// 2025-10-31). Free has no SLA and no private endpoints; Standard is the choice
// for anything facing real users. See the cost table in ../README.md.

param name string
param location string
param tags object = {}

@description('Free has no SLA and caps custom domains and staging environments; Standard is the production choice.')
@allowed([
  'Free'
  'Standard'
])
param sku string = 'Free'

@description('Build the site inside Azure from the repository instead of uploading a CI-built dist folder.')
param buildFromSource bool = false

param repositoryUrl string = ''

param branch string = 'main'

@description('Where the Vite app lives relative to the repository root. Only used for build-from-source.')
param appLocation string = 'frontend'

@description('Build output relative to the repository root — `vite build` writes frontend/dist.')
param outputLocation string = 'frontend/dist'

@description('Custom domain already verified in DNS, e.g. datadiet.example.edu. Empty means the *.azurestaticapps.net endpoint stays the only entry point.')
param customDomain string = ''

resource swa 'Microsoft.Web/staticSites@2025-03-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku == 'Standard' ? 'Standard' : 'Free'
    tier: sku == 'Standard' ? 'Standard' : 'Free'
  }
  properties: union(
    {
      // Keep PR preview environments: they are how a UI change is reviewed
      // before it reaches the production slot of the site.
      stagingEnvironmentPolicy: 'Enabled'
      allowConfigFileUpdates: true
      provider: buildFromSource ? 'GitHub' : 'External'
      publicNetworkAccess: 'Enabled'
    },
    buildFromSource
      ? {
          repository: repositoryUrl
          branch: branch
          buildProperties: {
            appLocation: appLocation
            outputLocation: outputLocation
          }
        }
      : {}
  )
}

// A custom domain needs its DNS record verified first; `staticwebapp` validates
// a txt token, so this resource fails loudly rather than silently half-working.
resource domain 'Microsoft.Web/staticSites/customDomains@2025-03-01' = if (customDomain != '') {
  parent: swa
  name: customDomain
}

output defaultHostname string = swa.properties.defaultHostname
output staticSiteId string = swa.id
output staticSiteName string = swa.name
