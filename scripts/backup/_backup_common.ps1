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

function Ensure-Directory {
  param([string]$PathValue)

  if (-not (Test-Path -LiteralPath $PathValue)) {
    New-Item -ItemType Directory -Path $PathValue -Force | Out-Null
  }

  return (Resolve-Path -LiteralPath $PathValue).Path
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

function Resolve-BackupRootDir {
  param(
    [string]$ExplicitPath,
    [string]$BackendRoot
  )

  $candidate = if ($ExplicitPath) {
    $ExplicitPath
  } else {
    Get-ConfigValue -Names @('BACKUP_ROOT_DIR') -DefaultValue (Join-Path $BackendRoot 'runtime_backups')
  }

  return Ensure-Directory -PathValue ([System.IO.Path]::GetFullPath($candidate))
}

function Resolve-LogDir {
  param(
    [string]$ExplicitPath,
    [string]$BackupRootDir
  )

  $candidate = if ($ExplicitPath) {
    $ExplicitPath
  } else {
    Get-ConfigValue -Names @('LOG_DIR') -DefaultValue (Join-Path $BackupRootDir 'logs')
  }

  return Ensure-Directory -PathValue ([System.IO.Path]::GetFullPath($candidate))
}

function Resolve-UploadRoot {
  param(
    [string]$ExplicitPath,
    [string]$BackendRoot
  )

  $candidate = if ($ExplicitPath) {
    $ExplicitPath
  } else {
    Get-ConfigValue -Names @('UPLOAD_DIR') -DefaultValue (Join-Path $BackendRoot 'uploads')
  }

  return [System.IO.Path]::GetFullPath($candidate)
}

function New-BackupRunContext {
  param(
    [string]$Job,
    [string]$BackendRoot,
    [string]$BackupRoot,
    [string]$LogRoot
  )

  $startedAt = Get-Date
  $timestampCompact = $startedAt.ToString('yyyyMMdd_HHmmss')
  $runId = "$Job-$timestampCompact-$([guid]::NewGuid().ToString())"
  $logPath = Join-Path $LogRoot "${Job}_${timestampCompact}.log"

  return [pscustomobject]@{
    Job = $Job
    RunId = $runId
    StartedAt = $startedAt
    TimestampCompact = $timestampCompact
    DateStamp = $startedAt.ToString('yyyyMMdd')
    BackendRoot = $BackendRoot
    BackupRoot = $BackupRoot
    LogRoot = $LogRoot
    LogPath = $logPath
  }
}

function ConvertTo-JsonLine {
  param($Payload)

  return ($Payload | ConvertTo-Json -Compress -Depth 10)
}

function Write-JsonLog {
  param(
    [string]$Path,
    $Payload
  )

  $line = ConvertTo-JsonLine -Payload $Payload
  Add-Content -Path $Path -Value $line -Encoding UTF8
  Write-Output $line
}

function New-BaseSummary {
  param(
    [pscustomobject]$Context,
    [string]$Operation
  )

  return [ordered]@{
    run_id = $Context.RunId
    job = $Context.Job
    operation = $Operation
    started_at = $Context.StartedAt.ToString('o')
    ended_at = $null
    duration_ms = 0
    success = $false
    errors = @()
    warnings = @()
  }
}

function Complete-Summary {
  param(
    [pscustomobject]$Context,
    [hashtable]$Summary,
    [bool]$Success
  )

  $endedAt = Get-Date
  $Summary.ended_at = $endedAt.ToString('o')
  $Summary.duration_ms = [int]($endedAt - $Context.StartedAt).TotalMilliseconds
  $Summary.success = $Success
  return $Summary
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

function Get-PostgresConfig {
  $sslEnabledRaw = Get-ConfigValue -Names @('POSTGRES_SSL', 'PG_SSL') -DefaultValue ''
  $sslEnabled = $false
  if (-not [string]::IsNullOrWhiteSpace($sslEnabledRaw)) {
    $sslEnabled = @('true', '1', 'yes') -contains $sslEnabledRaw.Trim().ToLowerInvariant()
  }

  return [ordered]@{
    Host = Get-ConfigValue -Names @('POSTGRES_HOST', 'PG_HOST') -Required
    Port = Get-ConfigValue -Names @('POSTGRES_PORT', 'PG_PORT') -DefaultValue '5432'
    Database = Get-ConfigValue -Names @('POSTGRES_DB', 'PG_DATABASE') -Required
    User = Get-ConfigValue -Names @('POSTGRES_USER', 'PG_USER') -Required
    Password = Get-ConfigValue -Names @('POSTGRES_PASSWORD', 'PG_PASSWORD') -DefaultValue ''
    SslEnabled = $sslEnabled
  }
}

function Set-PostgresSslModeFromConfig {
  param([hashtable]$PostgresConfig)

  $previous = [Environment]::GetEnvironmentVariable('PGSSLMODE', 'Process')
  if ($PostgresConfig.SslEnabled) {
    [Environment]::SetEnvironmentVariable('PGSSLMODE', 'require', 'Process')
  }
  return $previous
}

function Restore-PostgresSslMode {
  param([string]$PreviousValue)

  [Environment]::SetEnvironmentVariable('PGSSLMODE', $PreviousValue, 'Process')
}

function Test-PathWithin {
  param(
    [string]$ChildPath,
    [string]$ParentPath
  )

  $child = [System.IO.Path]::GetFullPath($ChildPath)
  $parent = [System.IO.Path]::GetFullPath($ParentPath)
  if (-not $parent.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $parent = $parent + [System.IO.Path]::DirectorySeparatorChar
  }

  return $child.StartsWith($parent, [System.StringComparison]::OrdinalIgnoreCase)
}

