[CmdletBinding()]
param(
  [switch]$Apply,

  [string]$BackendRoot = '',

  [string]$TaskPrefix = 'SOS Backend Retention',

  [ValidateSet('dry-run', 'execute')]
  [string]$VerificationMode = 'dry-run',

  [ValidateSet('dry-run', 'execute')]
  [string]$AuditMode = 'dry-run',

  [ValidateSet('dry-run', 'execute')]
  [string]$AttachmentsMode = 'dry-run',

  [int]$VerificationLimit = 500,
  [int]$AuditLimit = 500,
  [int]$AttachmentsLimit = 5000
)

$ErrorActionPreference = 'Stop'

function Resolve-BackendRoot {
  param([string]$InputRoot)

  if ($InputRoot) {
    return (Resolve-Path $InputRoot).Path
  }

  return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function New-RunnerArgument {
  param(
    [string]$RunnerPath,
    [string]$Job,
    [string]$Mode,
    [int]$Limit
  )

  return "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`" -Job $Job -Mode $Mode -Limit $Limit"
}

function Build-TaskDefinitions {
  param(
    [string]$ResolvedBackendRoot,
    [string]$ResolvedTaskPrefix,
    [string]$VerificationJobMode,
    [string]$AuditJobMode,
    [string]$AttachmentsJobMode,
    [int]$VerificationJobLimit,
    [int]$AuditJobLimit,
    [int]$AttachmentsJobLimit
  )

  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $runnerPath = Join-Path $ResolvedBackendRoot 'scripts\retention\run_retention_job.ps1'

  return @(
    [pscustomobject]@{
      TaskName = "$ResolvedTaskPrefix - Verification Codes"
      Description = 'Retention job for verification_codes. Default schedule uses dry-run until execute mode is explicitly approved.'
      Job = 'verification_codes_prune'
      Mode = $VerificationJobMode
      Limit = $VerificationJobLimit
      TriggerType = 'Daily'
      TriggerTime = '02:15'
      TriggerDay = $null
      Execute = $powershellExe
      Arguments = New-RunnerArgument -RunnerPath $runnerPath -Job 'verification_codes_prune' -Mode $VerificationJobMode -Limit $VerificationJobLimit
    },
    [pscustomobject]@{
      TaskName = "$ResolvedTaskPrefix - Audit Archive"
      Description = 'Retention job for auditoria_eventos archive rollover. Default schedule uses dry-run until execute mode is explicitly approved.'
      Job = 'audit_events_archive_rollover'
      Mode = $AuditJobMode
      Limit = $AuditJobLimit
      TriggerType = 'Weekly'
      TriggerTime = '02:45'
      TriggerDay = 'Sunday'
      Execute = $powershellExe
      Arguments = New-RunnerArgument -RunnerPath $runnerPath -Job 'audit_events_archive_rollover' -Mode $AuditJobMode -Limit $AuditJobLimit
    },
    [pscustomobject]@{
      TaskName = "$ResolvedTaskPrefix - Attachments Reconcile Report"
      Description = 'Report-only reconciliation for attachment metadata versus local files. This task should remain dry-run.'
      Job = 'attachments_reconcile_report'
      Mode = $AttachmentsJobMode
      Limit = $AttachmentsJobLimit
      TriggerType = 'Weekly'
      TriggerTime = '03:15'
      TriggerDay = 'Sunday'
      Execute = $powershellExe
      Arguments = New-RunnerArgument -RunnerPath $runnerPath -Job 'attachments_reconcile_report' -Mode $AttachmentsJobMode -Limit $AttachmentsJobLimit
    }
  )
}

function New-TaskTriggerDefinition {
  param([pscustomobject]$Task)

  if ($Task.TriggerType -eq 'Daily') {
    return New-ScheduledTaskTrigger -Daily -At $Task.TriggerTime
  }

  return New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Task.TriggerDay -At $Task.TriggerTime
}

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
$taskDefinitions = Build-TaskDefinitions `
  -ResolvedBackendRoot $resolvedBackendRoot `
  -ResolvedTaskPrefix $TaskPrefix `
  -VerificationJobMode $VerificationMode `
  -AuditJobMode $AuditMode `
  -AttachmentsJobMode $AttachmentsMode `
  -VerificationJobLimit $VerificationLimit `
  -AuditJobLimit $AuditLimit `
  -AttachmentsJobLimit $AttachmentsLimit

$preview = $taskDefinitions | Select-Object TaskName, Job, Mode, TriggerType, TriggerDay, TriggerTime, Limit, Execute, Arguments
$preview | Format-Table -AutoSize

if (-not $Apply) {
  Write-Output 'Modo preview: no se registraron tareas. Use -Apply para registrarlas en Windows Task Scheduler.'
  return
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Highest

foreach ($task in $taskDefinitions) {
  $action = New-ScheduledTaskAction -Execute $task.Execute -Argument $task.Arguments
  $trigger = New-TaskTriggerDefinition -Task $task

  Register-ScheduledTask `
    -TaskName $task.TaskName `
    -Description $task.Description `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null
}

Write-Output 'Tareas registradas correctamente en Windows Task Scheduler.'
