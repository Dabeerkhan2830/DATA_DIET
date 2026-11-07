// Optional hub network for DataDiet: one VNet, a private-endpoint subnet, a
// MySQL-delegated subnet, and the private DNS zones both services need.
//
// Nothing here is created unless the caller enables private connectivity, and a
// private endpoint carries a monthly cost of its own (infra/azure/README.md
// lists the cost categories). The MySQL server picks exactly one of the two
// supported access modes — delegated subnet or private endpoint — because that
// choice is immutable after creation and the two cannot be combined.

param namePrefix string
param location string
param tags object = {}

@description('Address space for the VNet. Keep it inside the RFC1918 range you can peer with on-premise networks.')
param addressPrefixes array = ['10.70.0.0/16']

@description('Subnet for private endpoints. /28 or larger; privateEndpointNetworkPolicies must stay Disabled.')
param privateEndpointSubnetPrefix string = '10.70.1.0/28'

@description('Subnet delegated to MySQL Flexible Server. Requires /28 or larger and the flexibleServers delegation.')
param mysqlDelegatedSubnetPrefix string = '10.70.2.0/28'

@description('Create the delegated subnet that MySQL can be injected into. Only needed for mysqlNetworkMode=delegated.')
param enableMysqlDelegation bool = false

@description('Create the private-endpoint subnet. Only needed for mysqlNetworkMode=private-endpoint or a private Key Vault.')
param enablePrivateEndpoints bool = false

@description('DNS zone name MySQL resolves through. Verify against the region you deploy to; gov/armored clouds use a different suffix.')
param mysqlDnsZoneName string = 'privatelink.mysql.database.azure.com'

@description('DNS zone name Key Vault resolves through.')
param keyVaultDnsZoneName string = 'privatelink.vaultcore.azure.net'

// Both MySQL access modes need a private DNS zone; only the private-endpoint
// mode needs the subnet that hosts the NIC.
var createZones = enablePrivateEndpoints || enableMysqlDelegation

resource vnet 'Microsoft.Network/virtualNetworks@2026-03-01' = {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: addressPrefixes
    }
    subnets: union(
      enablePrivateEndpoints
        ? [
            {
              name: 'pe'
              properties: {
                addressPrefix: privateEndpointSubnetPrefix
                privateEndpointNetworkPolicies: 'Disabled'
                privateLinkServiceNetworkPolicies: 'Disabled'
              }
            }
          ]
        : [],
      enableMysqlDelegation
        ? [
            {
              name: 'mysql'
              properties: {
                addressPrefix: mysqlDelegatedSubnetPrefix
                delegations: [
                  {
                    name: 'mysql-delegation'
                    properties: {
                      serviceName: 'Microsoft.DBforMySQL/flexibleServers'
                    }
                  }
                ]
              }
            }
          ]
        : []
    )
  }
}

resource mysqlZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createZones) {
  name: mysqlDnsZoneName
  location: 'global'
  tags: tags
}

resource mysqlZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createZones) {
  parent: mysqlZone
  name: '${namePrefix}-mysql-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource keyVaultZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoints) {
  name: keyVaultDnsZoneName
  location: 'global'
  tags: tags
}

resource keyVaultZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoints) {
  parent: keyVaultZone
  name: '${namePrefix}-vault-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
// Composed from the VNet id rather than read back from the deployed subnet
// list, so an output never depends on which toggles happened to be on.
output privateEndpointSubnetId string = enablePrivateEndpoints ? '${vnet.id}/subnets/pe' : ''
output mysqlDelegatedSubnetId string = enableMysqlDelegation ? '${vnet.id}/subnets/mysql' : ''
output mysqlPrivateDnsZoneId string = createZones ? mysqlZone.id : ''
output keyVaultPrivateDnsZoneId string = enablePrivateEndpoints ? keyVaultZone.id : ''
