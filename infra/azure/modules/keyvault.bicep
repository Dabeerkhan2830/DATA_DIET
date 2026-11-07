// DataDiet Key Vault: RBAC authorisation, soft delete and purge protection on,
// and no secret values anywhere in this file.
//
// The template creates the vault and the role assignments; an operator creates
// the secrets out-of-band (docs/azure-deployment.md). That split is deliberate:
// a secret value in a Bicep file, parameter file or CI log is a leaked secret.
//
// App Service resolves `@Microsoft.KeyVault(...)` references from the worker, so
// a vault whose public access is disabled is unreachable unless the App Service
// plan has VNet integration, which this template does NOT configure. The
// `allowPublicAccess` switch therefore defaults to true with an IP allowlist, and
// docs/azure-deployment.md records the private-vault follow-up.

param name string
param location string
param tags object = {}

@description('Tenant that owns the vault. Defaults to the deploying subscription tenant.')
param tenantId string = subscription().tenantId

@description('Allow the vault to be reached from Azure services / the internet. Required for App Service Key Vault references without VNet integration.')
param allowPublicAccess bool = true

@description('When allowPublicAccess is true, restrict it to these CIDR ranges. An empty list means the vault is open to all networks and is only acceptable for throwaway development.')
param firewallIpRanges array = []

@description('Subnet hosting the private endpoint, when the vault is meant to be private.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id (privatelink.vaultcore.azure.net) linked to the private endpoint.')
param privateDnsZoneId string = ''

@description('RBAC assignments to create on the vault: principalId plus roleDefinitionId, one entry per identity that must read secrets.')
param roleAssignments array = []

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: allowPublicAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: allowPublicAccess ? 'Allow' : 'Deny'
      ipRules: allowPublicAccess ? [for range in firewallIpRanges: { value: range }] : []
      virtualNetworkRules: []
    }
  }
}

// Key Vault Secrets User — read-only secret access, which is all a runtime
// identity needs to resolve an app-setting reference.
resource ra 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for assignment in roleAssignments: {
    scope: vault
    name: guid(vault.id, assignment.principalId, assignment.roleDefinitionId)
    properties: {
      principalId: assignment.principalId
      roleDefinitionId: assignment.roleDefinitionId
      principalType: 'ServicePrincipal'
      description: 'DataDiet infrastructure role assignment'
    }
  }
]

module vaultPe './private-link.bicep' = if (privateEndpointSubnetId != '') {
  name: 'keyvault-private-endpoint'
  params: {
    name: '${name}-pe'
    location: location
    tags: tags
    subnetId: privateEndpointSubnetId
    targetResourceId: vault.id
    // The group id for Key Vault; verify with `az network private-endpoint
    // ... ` against the live provider before a production cutover.
    groupName: 'vault'
    privateDnsZoneId: privateDnsZoneId
  }
}

output vaultId string = vault.id
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
