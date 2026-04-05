[CmdletBinding()]
param(
  [string]$BackendRoot = '',
  [string]$BackupRootDir = '',
  [string]$LogDir = '',
  [string]$NodeExecutable = 'node',
  [string]$PowerShellExecutable = '',
  [string]$PgDumpPath = 'pg_dump'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_backup_common.ps1')

if (-not $PowerShellExecutable) {
  $PowerShellExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
Import-DotEnv -BackendRoot $resolvedBackendRoot

if ($PgDumpPath -eq 'pg_dump') {
  $PgDumpPath = Get-ConfigValue -Names @('BACKUP_PG_DUMP_PATH', 'PG_DUMP_PATH') -DefaultValue $PgDumpPath
}

$resolvedBackupRoot = Resolve-BackupRootDir -ExplicitPath $BackupRootDir -BackendRoot $resolvedBackendRoot
$resolvedLogDir = Resolve-LogDir -ExplicitPath $LogDir -BackupRootDir $resolvedBackupRoot
$ctx = New-BackupRunContext -Job 'backup_all' -BackendRoot $resolvedBackendRoot -BackupRoot $resolvedBackupRoot -LogRoot $resolvedLogDir
$summary = New-BaseSummary -Context $ctx -Operation 'backup'
$summary.jobs = @()

Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
  event = 'backup_all_started'
  run_id = $ctx.RunId
  job = $ctx.Job
  started_at = $ctx.StartedAt.ToString('o')
  backend_root = $resolvedBackendRoot
  backup_root = $resolvedBackupRoot
  log_dir = $resolvedLogDir
})

$jobDefinitions = @(
  [pscustomobject]@{
    Name = 'postgres'
    Executable = $PowerShellExecutable
    Arguments = @(
      '-NoProfile'
      '-ExecutionPolicy'
      'Bypass'
      '-File'
      (Join-Path $resolvedBackendRoot 'scripts\backup\backup-postgres.ps1')
      '-BackendRoot'
      $resolvedBackendRoot
      '-BackupRootDir'
      $resolvedBackupRoot
      '-LogDir'
      $resolvedLogDir
      '-PgDumpPath'
      $PgDumpPath
    )
  },
  [pscustomobject]@{
    Name = 'uploads'
    Executable = $PowerShellExecutable
    Arguments = @(
      '-NoProfile'
      '-ExecutionPolicy'
      'Bypass'
      '-File'
      (Join-Path $resolvedBackendRoot 'scripts\backup\backup-uploads.ps1')
      '-BackendRoot'
      $resolvedBackendRoot
      '-BackupRootDir'
      $resolvedBackupRoot
      '-LogDir'
      $resolvedLogDir
    )
  },
  [pscustomobject]@{
    Name = 'firestore'
    Executable = $NodeExecutable
    Arguments = @(
      (Join-Path $resolvedBackendRoot 'scripts\backup\backup-firestore.js')
      "--backup-root=$resolvedBackupRoot"
      "--log-dir=$resolvedLogDir"
    )
  }
)

$hadFailures = $false

foreach ($job in $jobDefinitions) {
  $stdoutPath = Join-Path $resolvedLogDir "$($ctx.Job)_$($job.Name)_$($ctx.TimestampCompact).stdout.log"
  $stderrPath = Join-Path $resolvedLogDir "$($ctx.Job)_$($job.Name)_$($ctx.TimestampCompact).stderr.log"

  Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
    event = 'backup_all_job_started'
    run_id = $ctx.RunId
    component = $job.Name
    executable = $job.Executable
    arguments = $job.Arguments
    started_at = (Get-Date).ToString('o')
  })

  $process = Start-Process `
    -FilePath $job.Executable `
    -ArgumentList $job.Arguments `
    -WorkingDirectory $resolvedBackendRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru `
    -Wait

  if (Test-Path -LiteralPath $stdoutPath) {
    Get-Content -LiteralPath $stdoutPath | Add-Content -Path $ctx.LogPath -Encoding UTF8
  }
  if (Test-Path -LiteralPath $stderrPath) {
    Get-Content -LiteralPath $stderrPath | Add-Content -Path $ctx.LogPath -Encoding UTF8
  }

  $jobSummary = [ordered]@{
    component = $job.Name
    exit_code = $process.ExitCode
    success = $process.ExitCode -eq 0
    stdout_path = $stdoutPath
    stderr_path = $stderrPath
  }
  $summary.jobs += $jobSummary

  Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
    event = 'backup_all_job_finished'
    run_id = $ctx.RunId
    component = $job.Name
    exit_code = $process.ExitCode
    success = $jobSummary.success
    ended_at = (Get-Date).ToString('o')
  })

  if ($process.ExitCode -ne 0) {
    $hadFailures = $true
  }
}

if ($hadFailures) {
  $summary.errors = @('Al menos uno de los componentes de backup fallo. Revise el log consolidado.')
}

$summary = Complete-Summary -Context $ctx -Summary $summary -Success (-not $hadFailures)
Write-JsonLog -Path $ctx.LogPath -Payload $summary

if ($hadFailures) {
  exit 1
}

exit 0
