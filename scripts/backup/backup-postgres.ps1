[CmdletBinding()]
param(
  [string]$BackendRoot = '',
  [string]$BackupRootDir = '',
  [string]$LogDir = '',
  [string]$PgDumpPath = 'pg_dump'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_backup_common.ps1')

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
Import-DotEnv -BackendRoot $resolvedBackendRoot

$resolvedBackupRoot = Resolve-BackupRootDir -ExplicitPath $BackupRootDir -BackendRoot $resolvedBackendRoot
$resolvedLogDir = Resolve-LogDir -ExplicitPath $LogDir -BackupRootDir $resolvedBackupRoot
$ctx = New-BackupRunContext -Job 'backup_postgres' -BackendRoot $resolvedBackendRoot -BackupRoot $resolvedBackupRoot -LogRoot $resolvedLogDir
$summary = New-BaseSummary -Context $ctx -Operation 'backup'

if ($PgDumpPath -eq 'pg_dump') {
  $PgDumpPath = Get-ConfigValue -Names @('BACKUP_PG_DUMP_PATH', 'PG_DUMP_PATH') -DefaultValue $PgDumpPath
}

$stdoutPath = Join-Path $resolvedLogDir "backup_postgres_$($ctx.TimestampCompact).stdout.log"
$stderrPath = Join-Path $resolvedLogDir "backup_postgres_$($ctx.TimestampCompact).stderr.log"

$pgConfig = Get-PostgresConfig
$postgresDir = Ensure-Directory -PathValue (Join-Path $resolvedBackupRoot "postgres\$($ctx.DateStamp)")
$backupFile = Join-Path $postgresDir ("postgres_{0}_{1}.dump" -f $pgConfig.Database, $ctx.TimestampCompact)
$manifestPath = Join-Path $postgresDir ("postgres_{0}_{1}.manifest.json" -f $pgConfig.Database, $ctx.TimestampCompact)

Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
  event = 'backup_postgres_started'
  run_id = $ctx.RunId
  job = $ctx.Job
  started_at = $ctx.StartedAt.ToString('o')
  backend_root = $resolvedBackendRoot
  backup_root = $resolvedBackupRoot
  backup_file = $backupFile
  pg_dump = $PgDumpPath
  database = $pgConfig.Database
  host = $pgConfig.Host
  port = $pgConfig.Port
})

$previousPassword = Use-PostgresPassword -Password $pgConfig.Password
$previousSslMode = Set-PostgresSslModeFromConfig -PostgresConfig $pgConfig

try {
  $arguments = @(
    '--format=custom'
    "--host=$($pgConfig.Host)"
    "--port=$($pgConfig.Port)"
    "--username=$($pgConfig.User)"
    "--file=$backupFile"
    $pgConfig.Database
  )

  $process = Start-Process `
    -FilePath $PgDumpPath `
    -ArgumentList $arguments `
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

  if ($process.ExitCode -ne 0) {
    throw "pg_dump finalizo con codigo $($process.ExitCode)."
  }

  if (-not (Test-Path -LiteralPath $backupFile)) {
    throw "pg_dump no genero el archivo esperado: $backupFile"
  }

  $fileInfo = Get-Item -LiteralPath $backupFile
  $manifest = [ordered]@{
    run_id = $ctx.RunId
    backup_type = 'postgres'
    created_at = (Get-Date).ToString('o')
    backend_root = $resolvedBackendRoot
    backup_file = $backupFile
    database = $pgConfig.Database
    host = $pgConfig.Host
    port = $pgConfig.Port
    user = $pgConfig.User
    size_bytes = $fileInfo.Length
    format = 'custom'
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  $summary.database = $pgConfig.Database
  $summary.host = $pgConfig.Host
  $summary.port = $pgConfig.Port
  $summary.backup_file = $backupFile
  $summary.manifest_path = $manifestPath
  $summary.size_bytes = $fileInfo.Length
  $summary.exit_code = $process.ExitCode
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $true
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  exit 0
}
catch {
  $summary.database = $pgConfig.Database
  $summary.backup_file = $backupFile
  $summary.errors = @($_.Exception.Message)
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $false
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  throw
}
finally {
  Restore-PostgresPassword -PreviousValue $previousPassword
  Restore-PostgresSslMode -PreviousValue $previousSslMode
}
