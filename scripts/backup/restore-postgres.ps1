[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DumpFile,

  [string]$BackendRoot = '',
  [string]$LogDir = '',
  [string]$PgRestorePath = 'pg_restore',
  [string]$PsqlPath = 'psql'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_backup_common.ps1')

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
Import-DotEnv -BackendRoot $resolvedBackendRoot

if (-not (Test-Path -LiteralPath $DumpFile)) {
  throw "No se encontro el dump a restaurar: $DumpFile"
}

$resolvedBackupRoot = Resolve-BackupRootDir -ExplicitPath '' -BackendRoot $resolvedBackendRoot
$resolvedLogDir = Resolve-LogDir -ExplicitPath $LogDir -BackupRootDir $resolvedBackupRoot
$ctx = New-BackupRunContext -Job 'restore_postgres' -BackendRoot $resolvedBackendRoot -BackupRoot $resolvedBackupRoot -LogRoot $resolvedLogDir
$summary = New-BaseSummary -Context $ctx -Operation 'restore'

if ($PgRestorePath -eq 'pg_restore') {
  $PgRestorePath = Get-ConfigValue -Names @('BACKUP_PG_RESTORE_PATH', 'PG_RESTORE_PATH') -DefaultValue $PgRestorePath
}
if ($PsqlPath -eq 'psql') {
  $PsqlPath = Get-ConfigValue -Names @('BACKUP_PSQL_PATH', 'PSQL_PATH') -DefaultValue $PsqlPath
}

$stdoutPath = Join-Path $resolvedLogDir "restore_postgres_$($ctx.TimestampCompact).stdout.log"
$stderrPath = Join-Path $resolvedLogDir "restore_postgres_$($ctx.TimestampCompact).stderr.log"
$validationStdoutPath = Join-Path $resolvedLogDir "restore_postgres_$($ctx.TimestampCompact).validation.stdout.log"
$validationStderrPath = Join-Path $resolvedLogDir "restore_postgres_$($ctx.TimestampCompact).validation.stderr.log"

$pgConfig = Get-PostgresConfig
$resolvedDumpFile = [System.IO.Path]::GetFullPath($DumpFile)

Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
  event = 'restore_postgres_started'
  run_id = $ctx.RunId
  job = $ctx.Job
  started_at = $ctx.StartedAt.ToString('o')
  dump_file = $resolvedDumpFile
  database = $pgConfig.Database
  host = $pgConfig.Host
  port = $pgConfig.Port
})

$previousPassword = Use-PostgresPassword -Password $pgConfig.Password
$previousSslMode = Set-PostgresSslModeFromConfig -PostgresConfig $pgConfig

try {
  $restoreArguments = @(
    '--clean'
    '--if-exists'
    '--no-owner'
    '--no-privileges'
    "--host=$($pgConfig.Host)"
    "--port=$($pgConfig.Port)"
    "--username=$($pgConfig.User)"
    "--dbname=$($pgConfig.Database)"
    $resolvedDumpFile
  )

  $restoreProcess = Start-Process `
    -FilePath $PgRestorePath `
    -ArgumentList $restoreArguments `
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

  if ($restoreProcess.ExitCode -ne 0) {
    throw "pg_restore finalizo con codigo $($restoreProcess.ExitCode)."
  }

  $validationPerformed = $false
  $validationSucceeded = $false
  $validationWarning = $null
  try {
    $validationArguments = @(
      "--host=$($pgConfig.Host)"
      "--port=$($pgConfig.Port)"
      "--username=$($pgConfig.User)"
      "--dbname=$($pgConfig.Database)"
      '--no-password'
      '--command=SELECT current_database() AS database, NOW() AS restored_at;'
    )

    $validationProcess = Start-Process `
      -FilePath $PsqlPath `
      -ArgumentList $validationArguments `
      -WorkingDirectory $resolvedBackendRoot `
      -RedirectStandardOutput $validationStdoutPath `
      -RedirectStandardError $validationStderrPath `
      -PassThru `
      -Wait

    $validationPerformed = $true
    if ($validationProcess.ExitCode -eq 0) {
      $validationSucceeded = $true
    } else {
      $validationWarning = "psql devolvio codigo $($validationProcess.ExitCode) en la validacion posterior."
    }
  }
  catch {
    $validationWarning = "No fue posible ejecutar la validacion con psql: $($_.Exception.Message)"
  }

  if (Test-Path -LiteralPath $validationStdoutPath) {
    Get-Content -LiteralPath $validationStdoutPath | Add-Content -Path $ctx.LogPath -Encoding UTF8
  }
  if (Test-Path -LiteralPath $validationStderrPath) {
    Get-Content -LiteralPath $validationStderrPath | Add-Content -Path $ctx.LogPath -Encoding UTF8
  }

  $summary.dump_file = $resolvedDumpFile
  $summary.database = $pgConfig.Database
  $summary.host = $pgConfig.Host
  $summary.port = $pgConfig.Port
  $summary.validation_performed = $validationPerformed
  $summary.validation_succeeded = $validationSucceeded
  if ($validationWarning) {
    $summary.warnings = @($validationWarning)
  }
  $summary.exit_code = $restoreProcess.ExitCode
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $true
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  exit 0
}
catch {
  $summary.dump_file = $resolvedDumpFile
  $summary.database = $pgConfig.Database
  $summary.errors = @($_.Exception.Message)
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $false
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  throw
}
finally {
  Restore-PostgresPassword -PreviousValue $previousPassword
  Restore-PostgresSslMode -PreviousValue $previousSslMode
}
