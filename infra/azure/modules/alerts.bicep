// What wakes somebody, and what stops a surprise bill.

param name string
param tags object
param location string
param actionGroupId string
param databaseId string
param clusterId string
param insightsId string
param workspaceId string
@description('The public address of the application, e.g. https://ark.example.com. Empty skips the availability check.')
param healthUrl string
param monthlyBudget int
param budgetEmail string
param budgetStartDate string = '${utcNow('yyyy-MM')}-01'

var action = [{ actionGroupId: actionGroupId }]

resource databaseCpu 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${name}-db-cpu'
  location: 'global'
  tags: tags
  properties: {
    description: 'The database has been busy for fifteen minutes. Look at slow queries before scaling it up.'
    severity: 2
    enabled: true
    scopes: [databaseId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'cpu'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'cpu_percent'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
        }
      ]
    }
    actions: action
  }
}

resource databaseStorage 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${name}-db-storage'
  location: 'global'
  tags: tags
  properties: {
    description: 'The database is more than 85% full. It grows by itself, but find out why before the bill does.'
    severity: 2
    enabled: true
    scopes: [databaseId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'storage'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'storage_percent'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
        }
      ]
    }
    actions: action
  }
}

resource databaseConnections 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${name}-db-connections-failed'
  location: 'global'
  tags: tags
  properties: {
    description: 'Connections to the database are failing. Either the credentials changed or the network did.'
    severity: 1
    enabled: true
    scopes: [databaseId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failed'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'connections_failed'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Total'
        }
      ]
    }
    actions: action
  }
}

resource nodeCpu 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${name}-node-cpu'
  location: 'global'
  tags: tags
  properties: {
    description: 'The cluster nodes are running hot. The work pool scales out on its own up to its limit; if it is at the limit, raise it.'
    severity: 2
    enabled: true
    scopes: [clusterId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'cpu'
          criterionType: 'StaticThresholdCriterion'
          metricName: 'node_cpu_usage_percentage'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
        }
      ]
    }
    actions: action
  }
}

// Is it up? Asked every five minutes from three places, because one place failing is the network
// and all of them failing is us.
resource availabilityTest 'Microsoft.Insights/webtests@2022-06-15' = if (!empty(healthUrl)) {
  name: 'avail-${name}'
  location: location
  tags: union(tags, { 'hidden-link:${insightsId}': 'Resource' })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: 'avail-${name}'
    Name: 'Ark health'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      { Id: 'emea-nl-ams-azr' }
      { Id: 'emea-gb-db3-azr' }
      { Id: 'emea-fr-pra-edge' }
    ]
    Request: {
      RequestUrl: '${healthUrl}/health'
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 14
    }
  }
}

resource availabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(healthUrl)) {
  name: 'alert-${name}-down'
  location: 'global'
  tags: tags
  properties: {
    description: 'Ark did not answer its health check from at least two of the three places. It is down, or its certificate is about to run out.'
    severity: 0
    enabled: true
    scopes: [availabilityTest.id, insightsId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: availabilityTest.id
      componentId: insightsId
      failedLocationCount: 2
    }
    actions: action
  }
}

// Is it failing? The server writes a line for a request that answered 5xx and for anything that threw
// (server/src/observability.ts), by name and route pattern and never by content, and the cluster's
// logging sends them here. More than a handful in ten minutes is a bad release, a database that is
// refusing, or a dependency that is down; the line says which route and which kind of error.
resource serverErrors 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-${name}-5xx'
  location: location
  tags: tags
  properties: {
    displayName: 'Ark is answering with errors'
    description: 'More than ten failed requests (5xx) or unhandled errors in ten minutes. Query the same log for type request and request-failed to see the route and the kind of error: docs/ark/13-azure-hosting.md, What to watch.'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    criteria: {
      allOf: [
        {
          query: '''
ContainerLogV2
| where PodNamespace == "ark" and ContainerName == "server"
| extend line = tostring(LogMessage)
| where line startswith "{"
| extend entry = parse_json(line)
| where entry.type == "request-failed" or (entry.type == "request" and toint(entry.status) >= 500)
'''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 10
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [actionGroupId]
    }
  }
}

// A ceiling nobody notices until it is crossed is not a ceiling. Mail at eighty percent of what has
// been spent, and again when the forecast says the month will pass the whole amount.
resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (monthlyBudget > 0) {
  name: 'budget-${name}'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      spent80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [budgetEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [budgetEmail]
      }
    }
  }
}
