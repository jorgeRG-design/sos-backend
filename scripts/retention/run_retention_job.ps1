[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('verification_codes_prune', 'audit_events_archive_rollover', 'attachments_reconcile_report')]
  [string]$Job,

  [ValidateSet('dry-run', 'execute')]
  [string]$Mode = 'dry-run',

  [int]$Limit = 0,

  [string]$Cutoff = '',

  [string]$BackendRoot = '',

  [string]$NodeExecutable = 'node',

  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-BackendRoot {
  param([string]$InputRoot)

  if ($InputRoot) {
    return (Resolve-Path $InputRoot).Path
  }

  return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Get-JobScriptPath {
  param(
    [string]$ResolvedBackendRoot,
    [string]$JobName
  )

  $relative = switch ($JobName) {
    'verification_codes_prune' { 'scripts\retention\verification_codes_prune.js' }
    'audit_events_archive_rollover' { 'scripts\retention\audit_events_archive_rollover.js' }
    'attachments_reconcile_report' { 'scripts\retention\attachments_reconcile_report.js' }
    default { throw "Job no soportado: $JobName" }
  }

  return Join-Path $ResolvedBackendRoot $relative
}

function Ensure-Directory {
  param([string]$PathValue)

  if (-not (Test-Path $PathValue)) {
    New-Item -ItemType Directory -Path $PathValue -Force | Out-Null
  }
}

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
$jobScriptPath = Get-JobScriptPath -ResolvedBackendRoot $resolvedBackendRoot -JobName $Job

if (-not (Test-Path $jobScriptPath)) {
  throw "No se encontro el script del job: $jobScriptPath"
}

if (-not $LogDir) {
  $LogDir = Join-Path $resolvedBackendRoot 'runtime_logs\retention'
}

Ensure-Directory -PathValue $LogDir

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$logPath = Join-Path $LogDir "${Job}_${Mode}_${timestamp}.log"
$stdoutPath = Join-Path $LogDir "${Job}_${Mode}_${timestamp}.stdout.log"
$stderrPath = Join-Path $LogDir "${Job}_${Mode}_${timestamp}.stderr.log"

$argumentList = @($jobScriptPath, "--mode=$Mode")
if ($Limit -gt 0) {
  $argumentList += "--limit=$Limit"
}
if ($Cutoff) {
  $argumentList += "--cutoff=$Cutoff"
}

$wrapperStart = [ordered]@{
  event = 'retention_wrapper_started'
  job = $Job
  mode = $Mode
  started_at = (Get-Date).ToString('o')
  backend_root = $resolvedBackendRoot
  node = $NodeExecutable
  script = $jobScriptPath
  log_path = $logPath
  stdout_path = $stdoutPath
  stderr_path = $stderrPath
  arguments = $argumentList
}
$wrapperStart | ConvertTo-Json -Compress | Set-Content -Path $logPath -Encoding UTF8

$process = Start-Process `
  -FilePath $NodeExecutable `
  -ArgumentList $argumentList `
  -WorkingDirectory $resolvedBackendRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru `
  -Wait

if (Test-Path $stdoutPath) {
  Get-Content -Path $stdoutPath | Add-Content -Path $logPath -Encoding UTF8
}

if (Test-Path $stderrPath) {
  Get-Content -Path $stderrPath | Add-Content -Path $logPath -Encoding UTF8
}

$wrapperEnd = [ordered]@{
  event = 'retention_wrapper_finished'
  job = $Job
  mode = $Mode
  ended_at = (Get-Date).ToString('o')
  exit_code = $process.ExitCode
  log_path = $logPath
}
$wrapperEnd | ConvertTo-Json -Compress | Add-Content -Path $logPath -Encoding UTF8

exit $process.ExitCode
