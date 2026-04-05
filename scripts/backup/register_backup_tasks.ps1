[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$BackendRoot = '',
  [string]$TaskPrefix = 'SOS Backend Backup',
  [string]$TriggerTime = '01:00'
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
    [string]$ResolvedBackendRoot
  )

  return "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`" -BackendRoot `"$ResolvedBackendRoot`""
}

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runnerPath = Join-Path $resolvedBackendRoot 'scripts\backup\run-backup-all.ps1'

$taskDefinition = [pscustomobject]@{
  TaskName = "$TaskPrefix - Daily"
  Description = 'Daily backup of PostgreSQL, uploads and Firestore for SOS Backend.'
  TriggerType = 'Daily'
  TriggerTime = $TriggerTime
  Execute = $powershellExe
  Arguments = New-RunnerArgument -RunnerPath $runnerPath -ResolvedBackendRoot $resolvedBackendRoot
}

$taskDefinition | Select-Object TaskName, TriggerType, TriggerTime, Execute, Arguments | Format-Table -AutoSize

if (-not $Apply) {
  Write-Output 'Modo preview: no se registraron tareas. Use -Apply para registrarlas en Windows Task Scheduler.'
  return
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8)

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Highest

$action = New-ScheduledTaskAction -Execute $taskDefinition.Execute -Argument $taskDefinition.Arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $taskDefinition.TriggerTime

Register-ScheduledTask `
  -TaskName $taskDefinition.TaskName `
  -Description $taskDefinition.Description `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Output 'Tarea de backup registrada correctamente en Windows Task Scheduler.'
