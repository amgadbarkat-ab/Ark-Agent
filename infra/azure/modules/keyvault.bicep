// The secrets: the key everything stored is encrypted with, the session secret, the hub's keys, the
// database address, the payment provider's keys. They are put here by scripts/bootstrap-secrets.sh and
// by hand, never by this template (which would have to hold them), and the cluster reads them through
// External Secrets with no password of its own.

param name string
param location string
param tenantId string
param tags object
param logAnalyticsWorkspaceId string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${name}-${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    // Access by role, not by access policy: who may read what is then visible in one place.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // A deleted vault, or secret, cannot be purged before its retention ends, so a stolen credential
    // cannot be used to destroy the keys the stored data depends on.
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Who read or changed a secret, kept with the rest of the logs.
resource audit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'audit'
  scope: vault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
  }
}

output id string = vault.id
output name string = vault.name
output uri string = vault.properties.vaultUri
