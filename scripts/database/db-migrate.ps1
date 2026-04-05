[CmdletBinding()]
param(
  [string]$BackendRoot = '',
  [string]$PsqlPath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_db_common.ps1')

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
Import-DotEnv -BackendRoot $resolvedBackendRoot

$psql = Get-PsqlExecutable -ExplicitValue $PsqlPath
$pgConfig = Get-PostgresConfig
$previousPassword = Use-PostgresPassword -Password $pgConfig.Password
$previousSslMode = Use-PostgresSslMode -SslValue $pgConfig.Ssl

try {
  foreach ($migration in Get-MigrationFiles -BackendRoot $resolvedBackendRoot) {
    Write-Output "Aplicando migracion: $($migration.Name)"
    Invoke-SqlFile `
      -PsqlExecutable $psql `
      -PostgresConfig $pgConfig `
      -SqlFile $migration.FullName `
      -WorkingDirectory $resolvedBackendRoot
  }

  Write-Output 'Migraciones ejecutadas correctamente.'
  exit 0
}
finally {
  Restore-PostgresPassword -PreviousValue $previousPassword
  Restore-PostgresSslMode -PreviousValue $previousSslMode
}

