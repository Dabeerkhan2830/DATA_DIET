// Azure Database for MySQL Flexible Server for DataDiet.
//
// Two things about this module are load-bearing and easy to get wrong:
//
// 1. API version. MySQL 8.4 is only accepted by a preview resource API
//    (2025-06-01-preview); the newest stable type, 2024-12-30, validates
//    `version` as '5.7' | '8.0.21'. Switching `mysqlVersion` to '8.0' also
//    means switching this api-version back to the stable one — the two are
//    coupled and must be verified with `az bicep build` + a what-if against a
//    subscription (infra/azure/README.md, "Unverified items").
// 2. The network mode cannot be changed after creation, and a VNet-integrated
//    server can never have a public endpoint. Choose it deliberately per
//    environment rather than by copy-paste.
//
// The template cannot create in-database users, so the DML-only runtime account
// and the schema-change (migration) account described in
// docs/production-readiness.md section 5 are provisioned by an operator inside
// the server after deployment.

param name string
param location string
param tags object = {}

@description('MySQL major/minor version. "8.4" needs the preview api-version used by this module; "8.0" is served by the stable type.')
@allowed([
  '8.0'
  '8.4'
])
param version string = '8.4'

@description('Server SKU, e.g. Burstable_B2s for development or GeneralPurpose_D2ds_v5 for production. The tier is derived from this name.')
param skuName string = 'Burstable_B2s'

@description('Number of vCores for the chosen SKU; the SKU name alone does not always fix it.')
param skuCapacity int = 2

param storageSizeGb int = 32

@description('Let the server grow storage automatically. Turning this off means watching disk headroom yourself.')
param autoGrow bool = true

param backupRetentionDays int = 7

@description('Geo-redundant backup copies backups to a paired region and roughly doubles backup storage cost. Off by default; enable per environment as a deliberate decision.')
param geoRedundantBackup bool = false

@description('Zone-redundant HA doubles compute cost and constrains SKUs/regions. Off by default.')
param highAvailability bool = false

param administratorLogin string

@description('Server administrator password. Supply it through a Key Vault reference in the parameter file — never commit or echo it.')
@secure()
param administratorLoginPassword string

@description('The application database. Alembic and the app both point at this schema.')
param databaseName string = 'datadiet'

@description('"public" = internet reachable but firewalled; "private-endpoint" = a NIC in your VNet; "delegated" = injected into a delegated subnet. Immutable once created.')
@allowed([
  'public'
  'private-endpoint'
  'delegated'
])
param networkMode string = 'public'

@description('Subnet id for the private endpoint (networkMode=private-endpoint).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for the private endpoint (networkMode=private-endpoint).')
param privateDnsZoneId string = ''

@description('Delegated subnet id (networkMode=delegated); pair it with privateDnsZoneId.')
param delegatedSubnetId string = ''

@description('SQL-level firewall rules, only meaningful in public mode: [{name, startIpAddress, endIpAddress}]. Pin them to the App Service plan outbound addresses, never 0.0.0.0/0.')
param firewallRules array = []

@description('Minimum TLS the server accepts. The app connection string must ask for the same or stronger.')
@allowed([
  'TLS1_2'
  'TLS1_3'
])
param minimalTlsVersion string = 'TLS1_2'

@description('Server character set — keep in step with infra/docker-compose.dev.yml so development and Azure behave identically.')
param characterSetServer string = 'utf8mb4'

@description('Server collation — the development container uses utf8mb4_0900_ai_ci.')
param collationServer string = 'utf8mb4_0900_ai_ci'

@description('Private endpoint group id for MySQL Flexible Server. Verify against the live provider (`az network private-endpoint ...`) before a production run.')
param privateLinkGroupId string = 'mysqlServer'

var isPublic = networkMode == 'public'
var isPrivateEndpoint = networkMode == 'private-endpoint'
var isDelegated = networkMode == 'delegated'

resource server 'Microsoft.DBforMySQL/flexibleServers@2025-06-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: startsWith(skuName, 'Burstable')
      ? 'Burstable'
      : startsWith(skuName, 'GeneralPurpose')
        ? 'GeneralPurpose'
        : 'MemoryOptimized'
    capacity: skuCapacity
  }
  properties: {
    createMode: 'Default'
    // A string parameter cannot be assigned straight to this enum-typed
    // property, so the value is re-materialised as literals.
    version: version == '8.4' ? '8.4' : '8.0.21'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    storage: {
      storageSizeGB: storageSizeGb
      autoGrow: autoGrow ? 'Enabled' : 'Disabled'
      storageRedundancy: 'LocalRedundancy'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: highAvailability ? 'ZoneRedundant' : 'Disabled'
    }
    network: {
      publicNetworkAccess: isPublic ? 'Enabled' : 'Disabled'
      delegatedSubnetResourceId: isDelegated ? delegatedSubnetId : null
      privateDnsZoneResourceId: isDelegated ? privateDnsZoneId : null
    }
  }
}

resource appDatabase 'Microsoft.DBforMySQL/flexibleServers/databases@2025-06-01-preview' = {
  parent: server
  name: databaseName
}

// TLS is a server parameter on Flexible Server, not a top-level property: the
// old `sslEnforce`/`minimalTlsVersion` fields no longer exist in these API
// versions. require_secure_transport is the switch that actually rejects
// plaintext connections.
resource tlsConfig 'Microsoft.DBforMySQL/flexibleServers/configurations@2025-06-01-preview' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

resource tlsVersionConfig 'Microsoft.DBforMySQL/flexibleServers/configurations@2025-06-01-preview' = {
  parent: server
  name: 'tls_version'
  properties: {
    value: minimalTlsVersion == 'TLS1_3' ? 'TLS 1.3' : 'TLS 1.2'
    source: 'user-override'
  }
}

resource charsetConfig 'Microsoft.DBforMySQL/flexibleServers/configurations@2025-06-01-preview' = {
  parent: server
  name: 'character_set_server'
  properties: {
    value: characterSetServer
    source: 'user-override'
  }
}

resource collationConfig 'Microsoft.DBforMySQL/flexibleServers/configurations@2025-06-01-preview' = {
  parent: server
  name: 'collation_server'
  properties: {
    value: collationServer
    source: 'user-override'
  }
}

resource fw 'Microsoft.DBforMySQL/flexibleServers/firewallRules@2025-06-01-preview' = [
  for rule in firewallRules: {
    parent: server
    name: rule.name
    properties: {
      startIpAddress: rule.startIpAddress
      endIpAddress: rule.endIpAddress
    }
  }
]

module mysqlPe './private-link.bicep' = if (isPrivateEndpoint) {
  name: 'mysql-private-endpoint'
  params: {
    name: '${name}-pe'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: server.id
    groupName: privateLinkGroupId
    privateDnsZoneId: privateDnsZoneId
  }
}

output serverId string = server.id
output fullyQualifiedDomainName string = server.properties.fullyQualifiedDomainName
output port int = 3306
