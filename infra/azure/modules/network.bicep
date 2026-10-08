// The private network: the cluster in one subnet, the database in another it alone can be reached
// from. Nothing here is reachable from the internet except what the ingress publishes.

param name string
param location string
param addressSpace string
param tags object

var aksSubnetPrefix = cidrSubnet(addressSpace, 20, 0)
var databaseSubnetPrefix = cidrSubnet(addressSpace, 24, 16)

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'vnet-${name}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressSpace] }
    subnets: [
      {
        name: 'aks'
        properties: { addressPrefix: aksSubnetPrefix }
      }
      {
        name: 'database'
        properties: {
          addressPrefix: databaseSubnetPrefix
          // Only a flexible server may live here.
          delegations: [
            {
              name: 'postgres'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
    ]
  }
}

// The database has no public address. Its name resolves, inside this network only, to a private one.
resource privateZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${name}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource zoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateZone
  name: 'link-${name}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

output aksSubnetId string = '${vnet.id}/subnets/aks'
output databaseSubnetId string = '${vnet.id}/subnets/database'
output databaseSubnetPrefix string = databaseSubnetPrefix
output privateZoneId string = privateZone.id
