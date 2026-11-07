// Reusable private endpoint + private DNS zone group.
//
// A private endpoint is a paid resource (see the cost table in
// infra/azure/README.md) and is only created when the caller asks for it, so no
// environment gets privateLink silently.

param name string
param location string
param tags object = {}

@description('Full resource id of the subnet that hosts the network interface.')
param subnetId string

@description('Resource id of the service that the endpoint tunnels to.')
param targetResourceId string

@description('Group id of the target resource, e.g. vault, mysqlServer, batchAccount. These differ per service and are validated against the live provider, so they are parameters rather than constants.')
param groupName string

@description('Private DNS zone to link the endpoint to (e.g. privatelink.vaultcore.azure.net). Empty means no zone group is created, which leaves name resolution to the caller.')
param privateDnsZoneId string = ''

resource pe 'Microsoft.Network/privateEndpoints@2026-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: targetResourceId
          groupIds: [ groupName ]
          requestMessage: 'Requested by DataDiet infrastructure template.'
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2026-03-01' = if (privateDnsZoneId != '') {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'config-1'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

output privateEndpointId string = pe.id
output ipAddress array = pe.properties.customDnsConfigs[*].ipAddresses
