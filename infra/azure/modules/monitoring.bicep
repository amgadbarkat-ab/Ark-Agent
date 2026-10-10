// Where logs and metrics go, and who is told when something is wrong.

param name string
param location string
param retentionDays int
param alertEmail string
param tags object

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionDays
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

// Application Insights is where the availability test lives. The application itself is not
// instrumented with it; logs come from the cluster.
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
  }
}

// One place alerts go. Email is the floor; add a webhook or an SMS here when somebody is on call.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${name}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('ark${uniqueString(name)}', 12)
    enabled: true
    emailReceivers: [
      {
        name: 'owner'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output insightsId string = insights.id
output actionGroupId string = actionGroup.id
