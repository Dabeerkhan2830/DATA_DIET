// Application Insights component, created only when an existing Log Analytics
// workspace is supplied.
//
// Deliberately conservative about cost: Application Insights bills on ingested
// data, and a workspace-based component cannot exist without a workspace.
// Creating a Log Analytics workspace silently as a side effect of "enable
// monitoring" would be an unrequested recurring bill, so the workspace must come
// from the parameter file and the whole module stays off by default.
//
// What this does NOT do: the FastAPI application emits no Application Insights
// telemetry today (no agent, no OpenTelemetry exporter — see
// docs/production-readiness.md section 7). Until that is implemented and tested,
// this resource only gives you a destination for platform logs and live metrics;
// claiming application-level observability from it would be a false claim.

param name string
param location string
param tags object = {}

@description('Resource id of an ALREADY EXISTING Log Analytics workspace. This template will not create one.')
param workspaceResourceId string

param retentionInDays int = 30

@description('Disable public ingestion/query endpoints. Requires a private-link setup for the query side, so leave true unless that is in place.')
param allowPublicNetworkAccess bool = true

resource ai 'Microsoft.Insights/components@2020-02-02' = {
  name: name
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspaceResourceId
    RetentionInDays: retentionInDays
    publicNetworkAccessForIngestion: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    publicNetworkAccessForQuery: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
  }
}

output componentId string = ai.id
output instrumentationKey string = ai.properties.InstrumentationKey
// Read the connection string from the portal or `az monitor app-insights
// component show --query connectionString`; this API version exposes no
// listConnectionStrings action, so the template does not invent one.
