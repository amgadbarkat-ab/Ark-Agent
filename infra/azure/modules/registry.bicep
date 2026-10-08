// Where Ark's images live. No admin user: the cluster pulls with its own identity.

param name string
param location string
param sku string
param tags object

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  // Registry names are global and letters and digits only.
  name: take('acr${replace(name, '-', '')}${uniqueString(resourceGroup().id)}', 50)
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output id string = registry.id
output name string = registry.name
output loginServer string = registry.properties.loginServer
