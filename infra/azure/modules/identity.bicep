// How the cluster reads the secrets without holding a password for them.
//
// External Secrets runs in the cluster as a service account. That account is trusted, by its
// issuer and name, to act as this identity, and this identity may read secrets in the vault and do
// nothing else. A token is exchanged at the moment of use and lasts minutes.

param name string
param location string
param tags object
param oidcIssuerUrl string
param keyVaultName string

@description('The Kubernetes namespace External Secrets is installed in, and the service account it runs as.')
param operatorNamespace string = 'external-secrets'
param operatorServiceAccount string = 'external-secrets'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}-secrets'
  location: location
  tags: tags
}

resource trust 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'external-secrets'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${operatorNamespace}:${operatorServiceAccount}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource readSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'KeyVaultSecretsUser')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    // Key Vault Secrets User: read secrets, nothing else.
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
