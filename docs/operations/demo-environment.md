# Demo environment operations

The public Mission Control demo runs as an ephemeral Azure Container App. Its
SQLite database is reset and seeded whenever the container starts, so the
environment does not require durable application storage.

## Cost controls

The deployment in `infra/demo/main.bicep` intentionally:

- pulls the public image from GHCR instead of maintaining Azure Container
  Registry;
- allows the Consumption-plan app to scale from zero to one replica;
- does not retain container logs in Log Analytics; and
- grants the GitHub control identity the built-in Container Apps Operator role
  on only the demo app.

With `minReplicas` set to `0`, Azure can remove the final replica when there are
no HTTP requests. Compute charges stop while the revision has zero replicas.
The first request after scale-down has a cold start. A stopped app is different:
it cannot be awakened by HTTP traffic until the Start action runs.

Real-time logs remain available through the Container Apps log stream even
though historical logs are not saved.

## September 2026 cost investigation

An Azure Cost Management query grouped by resource and meter found:

| Resource | Meter | Cost |
| --- | --- | ---: |
| Container App | Memory and vCPU, active and idle | $11.77 |
| Azure Container Registry | Basic Registry Unit | $4.86 |
| Log Analytics workspace | Analytics Logs Data Ingestion | $0.00023 |

The workspace ingested less than 0.5 MB from its creation through September.
The larger amount visually adjacent to the workspace in the portal screenshot
was not a charge produced by this workspace's ingestion meter. The workspace
was still removed because the demo does not need retained logs.

## Infrastructure as code

Azure Resource Manager (ARM) is Azure's deployment and control plane. Bicep is
the typed, concise source language used here to generate an ARM template. The
Bicep file makes the live resource configuration reviewable, repeatable, and
recoverable instead of leaving the only copy in Azure deployment history.

Deploy the checked-in configuration from an authenticated Azure CLI:

```powershell
az deployment group create `
  --resource-group rg-mission-control-demo `
  --name demo-cost-controls `
  --template-file infra\demo\main.bicep `
  --parameters infra\demo\main.bicepparam
```

Deployments are incremental. After confirming that the environment reports
`appLogsConfiguration.destination` as empty and that the app is healthy from
GHCR, the old demo-only registry and workspace can be deleted:

```powershell
az acr delete `
  --resource-group rg-mission-control-demo `
  --name acrmcdemorsocko `
  --yes

az monitor log-analytics workspace delete `
  --resource-group rg-mission-control-demo `
  --workspace-name log-mission-control-demo `
  --yes `
  --force true
```

When publishing a new demo revision, update both the immutable `image` digest
and the unique `revisionSuffix` in `infra/demo/main.bicepparam`.

## Start, stop, and status controls

The **Control demo environment** GitHub Actions workflow provides manual
`start`, `stop`, and `status` actions. Its scheduled run stops the app daily at
03:00 UTC. Starting enables the app again; because the minimum replica count is
zero, a replica starts when the next HTTP request arrives.

The workflow authenticates through GitHub OIDC and stores no Azure credential.
Configure these non-secret repository variables:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Client ID output by the Bicep deployment |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `DEMO_RESOURCE_GROUP` | `rg-mission-control-demo` |
| `DEMO_CONTAINER_APP` | `ca-mission-control-demo` |

The `demo` GitHub environment must exist because the managed identity accepts
OIDC tokens only with the subject
`repo:rsocko/mission-control:environment:demo`.

The underlying REST actions are also available to authenticated operators:

```powershell
$appId = az containerapp show `
  --resource-group rg-mission-control-demo `
  --name ca-mission-control-demo `
  --query id `
  --output tsv

az rest --method post `
  --url "https://management.azure.com$appId/stop?api-version=2026-07-01"

az rest --method post `
  --url "https://management.azure.com$appId/start?api-version=2026-07-01"
```
