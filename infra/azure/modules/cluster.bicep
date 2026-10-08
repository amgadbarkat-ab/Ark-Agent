// The Kubernetes cluster the chart runs on.
//
// Chosen over a container-app service because the chart is Kubernetes-native, and because a hosted
// Bot's own computer (the cloud runtime) is a pod of its own, which needs the Kubernetes API.
//
// Sign-in to the cluster is Microsoft Entra only: there is no shared admin credential to leak.

param name string
param location string
param tags object
param kubernetesVersion string
param subnetId string
param systemVmSize string
param userVmSize string
param userMinCount int
param userMaxCount int
param zones array
param adminGroupObjectId string
param authorizedIpRanges array
param logAnalyticsWorkspaceId string
param registryId string

resource cluster 'Microsoft.ContainerService/managedClusters@2024-09-01' = {
  name: 'aks-${name}'
  location: location
  tags: tags
  sku: {
    name: 'Base'
    // The paid tier carries the uptime commitment on the control plane.
    tier: 'Standard'
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    kubernetesVersion: empty(kubernetesVersion) ? null : kubernetesVersion
    dnsPrefix: take('ark-${name}', 54)
    enableRBAC: true
    // No static admin kubeconfig. People and pipelines authenticate as themselves.
    disableLocalAccounts: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      adminGroupObjectIDs: [adminGroupObjectId]
    }
    // What lets a pod be an Azure identity without a secret (workload identity).
    oidcIssuerProfile: { enabled: true }
    securityProfile: {
      workloadIdentity: { enabled: true }
    }
    apiServerAccessProfile: {
      enablePrivateCluster: false
      authorizedIPRanges: authorizedIpRanges
    }
    autoUpgradeProfile: {
      // Patch releases of the chosen minor version arrive on their own; a new minor is a decision.
      upgradeChannel: 'patch'
      nodeOSUpgradeChannel: 'NodeImage'
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      // NetworkPolicy is enforced, which the chart's policies need in order to mean anything.
      networkPolicy: 'cilium'
      networkDataplane: 'cilium'
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
      serviceCidr: '10.250.0.0/16'
      dnsServiceIP: '10.250.0.10'
      podCidr: '10.244.0.0/16'
    }
    agentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        vmSize: systemVmSize
        count: 2
        minCount: 2
        maxCount: 3
        enableAutoScaling: true
        availabilityZones: zones
        osType: 'Linux'
        osSKU: 'AzureLinux'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: subnetId
        // Only cluster components run here, so a busy workload cannot starve the cluster.
        nodeTaints: ['CriticalAddonsOnly=true:NoSchedule']
      }
      {
        name: 'work'
        mode: 'User'
        vmSize: userVmSize
        count: userMinCount
        minCount: userMinCount
        maxCount: userMaxCount
        enableAutoScaling: true
        availabilityZones: zones
        osType: 'Linux'
        osSKU: 'AzureLinux'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: subnetId
      }
    ]
    addonProfiles: {
      // Container logs and metrics, into the same workspace as everything else.
      omsagent: {
        enabled: true
        config: { logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceId }
      }
      // Azure Policy's built-in checks of what runs in the cluster.
      azurepolicy: { enabled: true }
    }
    // The managed NGINX the chart's ingress class names (webapprouting.kubernetes.azure.com).
    ingressProfile: {
      webAppRouting: { enabled: true }
    }
  }
}

// The cluster may pull images from the registry, and nothing else may.
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registryId, cluster.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: cluster.properties.identityProfile.kubeletidentity.objectId
    principalType: 'ServicePrincipal'
    // AcrPull
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}

// Staff who may administer the cluster, by Entra group.
resource clusterAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(cluster.id, adminGroupObjectId, 'ClusterAdmin')
  scope: cluster
  properties: {
    principalId: adminGroupObjectId
    principalType: 'Group'
    // Azure Kubernetes Service RBAC Cluster Admin
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b')
  }
}

resource controlPlaneLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'control-plane'
  scope: cluster
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      // Who did what to the cluster, which is the log an investigation starts from.
      { category: 'kube-audit-admin', enabled: true }
      { category: 'kube-apiserver', enabled: true }
      { category: 'guard', enabled: true }
    ]
  }
}

output id string = cluster.id
output name string = cluster.name
output oidcIssuerUrl string = cluster.properties.oidcIssuerProfile.issuerURL
