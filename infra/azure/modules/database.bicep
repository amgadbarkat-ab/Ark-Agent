// PostgreSQL, managed: backups, patching and failover are Azure's. Two databases on one server: the
// application's, and the hub's own (conversations), which must stay separate from it.

param name string
param location string
param subnetId string
param privateZoneId string
param skuName string
param skuTier string
param storageGb int
param backupRetentionDays int
param geoRedundantBackup bool
param highAvailability bool
param administratorLogin string
@secure()
param administratorPassword string
param logAnalyticsWorkspaceId string
param tags object

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: take('psql-${name}-${uniqueString(resourceGroup().id)}', 63)
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageGb
      autoGrow: 'Enabled'
    }
    backup: {
      // Point-in-time restore to any second in this window. The one setting that decides how much
      // can be lost to a mistake.
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: highAvailability ? 'ZoneRedundant' : 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: subnetId
      privateDnsZoneArmResourceId: privateZoneId
      publicNetworkAccess: 'Disabled'
    }
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Disabled'
    }
  }
}

// The vector extension, which the application's schema uses. Allowed here, created by the migrations.
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR,PG_TRGM,PGCRYPTO,UUID-OSSP'
    source: 'user-override'
  }
}

// Every connection is encrypted. (On by default; stated so a later change has to be deliberate.)
resource tls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
  dependsOn: [extensions]
}

resource application 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'openbot'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [tls]
}

resource hub 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'hub'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [application]
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'logs'
  scope: server
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output id string = server.id
output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
