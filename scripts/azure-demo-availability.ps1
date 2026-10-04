[CmdletBinding()]
param(
    [ValidateSet('status', 'suspend', 'sustain')]
    [string]$Action = 'status',

    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    [Parameter(Mandatory)]
    [string]$AppName,

    [ValidateRange(30, 1800)]
    [int]$TimeoutSeconds = 600,

    [ValidateRange(2, 60)]
    [int]$PollIntervalSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzureCli {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$Json
    )

    $output = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed with exit code $LASTEXITCODE`: az $($Arguments -join ' ')"
    }

    if ($Json) {
        return $output | ConvertFrom-Json
    }

    return $output
}

function Get-ContainerApp {
    return Invoke-AzureCli -Json -Arguments @(
        'containerapp', 'show',
        '--resource-group', $ResourceGroup,
        '--name', $AppName,
        '--only-show-errors',
        '--output', 'json'
    )
}

function Get-Revision {
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName
    )

    return Invoke-AzureCli -Json -Arguments @(
        'containerapp', 'revision', 'show',
        '--resource-group', $ResourceGroup,
        '--name', $AppName,
        '--revision', $RevisionName,
        '--only-show-errors',
        '--output', 'json'
    )
}

function Set-ReplicaRange {
    param(
        [Parameter(Mandatory)]
        [int]$Minimum,

        [Parameter(Mandatory)]
        [int]$Maximum
    )

    $app = Get-ContainerApp
    if (
        [int]$app.properties.template.scale.minReplicas -eq $Minimum -and
        [int]$app.properties.template.scale.maxReplicas -eq $Maximum
    ) {
        return $app
    }

    Invoke-AzureCli -Arguments @(
        'containerapp', 'update',
        '--resource-group', $ResourceGroup,
        '--name', $AppName,
        '--min-replicas', $Minimum,
        '--max-replicas', $Maximum,
        '--only-show-errors',
        '--output', 'none'
    ) | Out-Null

    return Get-ContainerApp
}

function Set-RunningState {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('start', 'stop')]
        [string]$Operation,

        [Parameter(Mandatory)]
        [ValidateSet('Running', 'Stopped')]
        [string]$ExpectedStatus
    )

    $app = Get-ContainerApp
    if ($app.properties.runningStatus -eq $ExpectedStatus) {
        return $app
    }

    Invoke-AzureCli -Arguments @(
        'rest',
        '--method', 'post',
        '--url', "https://management.azure.com$($app.id)/$Operation`?api-version=2026-07-01",
        '--only-show-errors',
        '--output', 'none'
    ) | Out-Null

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds $PollIntervalSeconds
        $app = Get-ContainerApp
        if ($app.properties.runningStatus -eq $ExpectedStatus) {
            return $app
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Container App remained '$($app.properties.runningStatus)'; expected '$ExpectedStatus'."
}

function Wait-RevisionReady {
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastHealthState = 'Unknown'
    $lastRunningState = 'Unknown'
    $lastReadinessError = $null

    do {
        $revision = Get-Revision -RevisionName $RevisionName
        $lastHealthState = [string]$revision.properties.healthState
        $lastRunningState = [string]$revision.properties.runningState
        if (
            $lastHealthState -eq 'Healthy' -and
            $lastRunningState -like 'Running*' -and
            [int]$revision.properties.replicas -ge 1
        ) {
            break
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    if (
        $lastHealthState -ne 'Healthy' -or
        $lastRunningState -notlike 'Running*' -or
        [int]$revision.properties.replicas -lt 1
    ) {
        throw "Revision '$RevisionName' was not ready. Health: '$lastHealthState'; running state: '$lastRunningState'."
    }

    $readinessUrl = "https://$($revision.properties.fqdn)/api/health/ready"
    do {
        try {
            $readiness = Invoke-RestMethod -Uri $readinessUrl -Method Get -TimeoutSec 15
            if ($readiness.ready -eq $true) {
                return $revision
            }
        }
        catch {
            $lastReadinessError = $_.Exception.Message
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    $detail = if ($lastReadinessError) { " Last error: $lastReadinessError" } else { '' }
    throw "Revision '$RevisionName' did not pass $readinessUrl.$detail"
}

switch ($Action) {
    'suspend' {
        $app = Set-ReplicaRange -Minimum 0 -Maximum 1
        $app = Set-RunningState -Operation stop -ExpectedStatus Stopped
    }
    'sustain' {
        $app = Set-ReplicaRange -Minimum 1 -Maximum 1
        $revisionName = [string]$app.properties.latestRevisionName
        $app = Set-RunningState -Operation start -ExpectedStatus Running
        $revision = Wait-RevisionReady -RevisionName $revisionName
        $app = Get-ContainerApp
    }
    'status' {
        $app = Get-ContainerApp
    }
}

$revisionName = [string]$app.properties.latestRevisionName
$revision = Get-Revision -RevisionName $revisionName
$result = [ordered]@{
    action = $Action
    runningStatus = [string]$app.properties.runningStatus
    minReplicas = [int]$app.properties.template.scale.minReplicas
    maxReplicas = [int]$app.properties.template.scale.maxReplicas
    revision = $revisionName
    revisionHealth = [string]$revision.properties.healthState
    revisionRunningState = [string]$revision.properties.runningState
    replicas = [int]$revision.properties.replicas
    image = [string]$app.properties.template.containers[0].image
    origin = "https://$($app.properties.configuration.ingress.fqdn)"
}

$result | ConvertTo-Json

if ($env:GITHUB_STEP_SUMMARY) {
    @"
## Demo environment

| Property | Value |
| --- | --- |
| Action | ``$($result.action)`` |
| Status | ``$($result.runningStatus)`` |
| Replicas | ``$($result.minReplicas)..$($result.maxReplicas)`` (current: ``$($result.replicas)``) |
| Revision | ``$($result.revision)`` |
| Revision health | ``$($result.revisionHealth)`` / ``$($result.revisionRunningState)`` |
| Image | ``$($result.image)`` |
"@ | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
}
