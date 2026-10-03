targetScope = 'resourceGroup'

@description('Azure region for the demo resources.')
param location string = resourceGroup().location

@description('Container Apps managed environment name.')
param environmentName string = 'cae-mission-control-demo'

@description('Container App name.')
param appName string = 'ca-mission-control-demo'

@description('User-assigned identity used by the GitHub Actions control workflow.')
param controlIdentityName string = 'id-mission-control-demo'

@description('Public immutable GHCR image reference, including its digest.')
param image string

@description('Unique Container Apps revision suffix for this deployment.')
param revisionSuffix string

@description('GitHub repository allowed to obtain an OIDC token for the demo environment.')
param githubRepository string = 'rsocko/mission-control'

var tags = {
  application: 'mission-control'
  environment: 'demo'
  persistence: 'ephemeral'
}

var containerAppsContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '358470bc-b998-42bd-ab17-a7e34c199c0f'
)

resource controlIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: controlIdentityName
  location: location
  tags: tags
}

resource githubEnvironmentCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: controlIdentity
  name: 'github-demo-environment'
  properties: {
    audiences: [
      'api://AzureADTokenExchange'
    ]
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:demo'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: null
    }
    peerAuthentication: {
      mtls: {
        enabled: false
      }
    }
    peerTrafficConfiguration: {
      encryption: {
        enabled: false
      }
    }
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        exposedPort: 0
        targetPort: 3099
        transport: 'Auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: []
    }
    template: {
      revisionSuffix: revisionSuffix
      containers: [
        {
          name: 'mission-control-demo'
          image: image
          env: [
            {
              name: 'MC_MODE'
              value: 'demo'
            }
            {
              name: 'MC_PUBLIC_DEMO'
              value: 'true'
            }
            {
              name: 'MC_DEPLOYMENT_REVISION'
              value: revisionSuffix
            }
            {
              name: 'MC_DB_PATH'
              value: '/app/data/mission-control.db'
            }
            {
              name: 'AI_PROVIDER'
              value: ''
            }
            {
              name: 'LOG_LEVEL'
              value: 'info'
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3099'
            }
            {
              name: 'HOSTNAME'
              value: '0.0.0.0'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health/live'
                port: 3099
                scheme: 'HTTP'
              }
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health/ready'
                port: 3099
                scheme: 'HTTP'
              }
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 6
            }
            {
              type: 'Startup'
              httpGet: {
                path: '/api/health/ready'
                port: 3099
                scheme: 'HTTP'
              }
              initialDelaySeconds: 2
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 60
            }
          ]
        }
      ]
      scale: {
        cooldownPeriod: 300
        minReplicas: 0
        maxReplicas: 1
        pollingInterval: 30
      }
    }
  }
}

resource controlRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(app.id, controlIdentity.id, containerAppsContributorRoleDefinitionId)
  scope: app
  properties: {
    principalId: controlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: containerAppsContributorRoleDefinitionId
  }
}

output appId string = app.id
output controlIdentityClientId string = controlIdentity.properties.clientId
output fqdn string = app.properties.configuration.ingress.fqdn
output origin string = 'https://${app.properties.configuration.ingress.fqdn}'
