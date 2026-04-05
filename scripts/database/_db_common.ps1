[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Resolve-BackendRoot {
  param([string]$InputRoot)

  if ($InputRoot) {
    return (Resolve-Path $InputRoot).Path
  }

  return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Unquote-EnvValue {
  param([string]$RawValue)

  $value = [string]$RawValue
  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    return $value.Substring(1, $value.Length - 2)
  }

  return $value
}

function Import-DotEnv {
  param([string]$BackendRoot)

  $envPath = Join-Path $BackendRoot '.env'
  if (-not (Test-Path -LiteralPath $envPath)) {
    return
  }

  foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = [string]$line
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      continue
    }

    $trimmed = $trimmed.Trim()
    if ($trimmed.StartsWith('#')) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf('=')
    if ($separatorIndex -lt 1) {
      continue
    }

    $name = $trimmed.Substring(0, $separatorIndex).Trim()
    if (-not $name) {
      continue
    }

    $value = $trimmed.Substring($separatorIndex + 1)
    $value = Unquote-EnvValue -RawValue $value.Trim()

    if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

function Get-ConfigValue {
  param(
    [string[]]$Names,
    [string]$DefaultValue = '',
    [switch]$Required
  )

  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value.Trim()
    }
  }

  if ($Required) {
    throw "Falta configurar una de estas variables: $($Names -join ', ')"
  }

  return $DefaultValue
}

function Get-PsqlExecutable {
  param([string]$ExplicitValue)

  if ($ExplicitValue) {
    return $ExplicitValue
  }

  return Get-ConfigValue -Names @('DB_PSQL_PATH', 'BACKUP_PSQL_PATH', 'PSQL_PATH') -DefaultValue 'psql'
}

function Get-PostgresConfig {
  return [ordered]@{
    Host = Get-ConfigValue -Names @('POSTGRES_HOST', 'PG_HOST') -Required
    Port = Get-ConfigValue -Names @('POSTGRES_PORT', 'PG_PORT') -DefaultValue '5432'
    Database = Get-ConfigValue -Names @('POSTGRES_DB', 'PG_DATABASE') -Required
    User = Get-ConfigValue -Names @('POSTGRES_USER', 'PG_USER') -Required
    Password = Get-ConfigValue -Names @('POSTGRES_PASSWORD', 'PG_PASSWORD') -DefaultValue ''
    Ssl = Get-ConfigValue -Names @('POSTGRES_SSL', 'PG_SSL') -DefaultValue ''
  }
}

function Use-PostgresPassword {
  param([string]$Password)

  $previous = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($Password)) {
    [Environment]::SetEnvironmentVariable('PGPASSWORD', $Password, 'Process')
  }
  return $previous
}

function Restore-PostgresPassword {
  param([string]$PreviousValue)

  [Environment]::SetEnvironmentVariable('PGPASSWORD', $PreviousValue, 'Process')
}

function Use-PostgresSslMode {
  param([string]$SslValue)

  $previous = [Environment]::GetEnvironmentVariable('PGSSLMODE', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($SslValue)) {
    $normalized = $SslValue.Trim().ToLowerInvariant()
    if (@('true', '1', 'yes') -contains $normalized) {
      [Environment]::SetEnvironmentVariable('PGSSLMODE', 'require', 'Process')
    }
  }
  return $previous
}

function Restore-PostgresSslMode {
  param([string]$PreviousValue)

  [Environment]::SetEnvironmentVariable('PGSSLMODE', $PreviousValue, 'Process')
}

function Invoke-SqlFile {
  param(
    [string]$PsqlExecutable,
    [hashtable]$PostgresConfig,
    [string]$SqlFile,
    [string]$WorkingDirectory
  )

  if (-not (Test-Path -LiteralPath $SqlFile)) {
    throw "No se encontro el archivo SQL: $SqlFile"
  }

  $arguments = @(
    '--set=ON_ERROR_STOP=1'
    "--host=$($PostgresConfig.Host)"
    "--port=$($PostgresConfig.Port)"
    "--username=$($PostgresConfig.User)"
    "--dbname=$($PostgresConfig.Database)"
    '--file'
    $SqlFile
  )

  $process = Start-Process `
    -FilePath $PsqlExecutable `
    -ArgumentList $arguments `
    -WorkingDirectory $WorkingDirectory `
    -PassThru `
    -Wait `
    -NoNewWindow

  if ($process.ExitCode -ne 0) {
    throw "psql finalizo con codigo $($process.ExitCode) al ejecutar $SqlFile"
  }
}

function Get-MigrationFiles {
  param([string]$BackendRoot)

  return Get-ChildItem -Path (Join-Path $BackendRoot 'migrations') -Filter *.sql |
    Sort-Object Name
}
