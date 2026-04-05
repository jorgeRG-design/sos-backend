[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath,

  [string]$BackendRoot = '',
  [string]$UploadDir = '',
  [string]$LogDir = '',
  [string]$RobocopyPath = 'robocopy',
  [switch]$OverwriteExisting
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_backup_common.ps1')

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
Import-DotEnv -BackendRoot $resolvedBackendRoot

$resolvedBackupRoot = Resolve-BackupRootDir -ExplicitPath '' -BackendRoot $resolvedBackendRoot
$resolvedLogDir = Resolve-LogDir -ExplicitPath $LogDir -BackupRootDir $resolvedBackupRoot
$ctx = New-BackupRunContext -Job 'restore_uploads' -BackendRoot $resolvedBackendRoot -BackupRoot $resolvedBackupRoot -LogRoot $resolvedLogDir
$summary = New-BaseSummary -Context $ctx -Operation 'restore'

if ($RobocopyPath -eq 'robocopy') {
  $RobocopyPath = Get-ConfigValue -Names @('BACKUP_ROBOCOPY_PATH') -DefaultValue $RobocopyPath
}

$destinationUploadRoot = Resolve-UploadRoot -ExplicitPath $UploadDir -BackendRoot $resolvedBackendRoot
Ensure-Directory -PathValue $destinationUploadRoot | Out-Null

$resolvedBackupPath = [System.IO.Path]::GetFullPath($BackupPath)
if (-not (Test-Path -LiteralPath $resolvedBackupPath)) {
  throw "No se encontro el respaldo de uploads: $resolvedBackupPath"
}

$manifestPath = $null
$sourceFilesDir = $null
if ((Get-Item -LiteralPath $resolvedBackupPath).PSIsContainer) {
  $candidateManifest = Join-Path $resolvedBackupPath 'manifest.json'
  $candidateFiles = Join-Path $resolvedBackupPath 'files'
  if (Test-Path -LiteralPath $candidateManifest) {
    $manifestPath = $candidateManifest
  }
  if (Test-Path -LiteralPath $candidateFiles) {
    $sourceFilesDir = $candidateFiles
  } else {
    $sourceFilesDir = $resolvedBackupPath
  }
} else {
  throw 'El restore de uploads espera una carpeta de respaldo, no un archivo.'
}

if (-not (Test-Path -LiteralPath $sourceFilesDir)) {
  throw "No se encontro la carpeta 'files' del respaldo: $sourceFilesDir"
}

$robocopyLog = Join-Path $resolvedLogDir "restore_uploads_$($ctx.TimestampCompact).robocopy.log"

Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
  event = 'restore_uploads_started'
  run_id = $ctx.RunId
  job = $ctx.Job
  started_at = $ctx.StartedAt.ToString('o')
  backup_path = $resolvedBackupPath
  source_files_dir = $sourceFilesDir
  destination_upload_dir = $destinationUploadRoot
  overwrite_existing = [bool]$OverwriteExisting
})

try {
  $robocopyArguments = @(
    $sourceFilesDir
    $destinationUploadRoot
    '/E'
    '/R:2'
    '/W:2'
    '/COPY:DAT'
    '/DCOPY:DAT'
    '/NP'
    '/TEE'
    "/LOG:$robocopyLog"
  )

  if (-not $OverwriteExisting) {
    $robocopyArguments += '/XC'
    $robocopyArguments += '/XN'
    $robocopyArguments += '/XO'
  }

  $process = Start-Process `
    -FilePath $RobocopyPath `
    -ArgumentList $robocopyArguments `
    -WorkingDirectory $resolvedBackendRoot `
    -PassThru `
    -Wait

  if (Test-Path -LiteralPath $robocopyLog) {
    Get-Content -LiteralPath $robocopyLog | Add-Content -Path $ctx.LogPath -Encoding UTF8
  }

  if ($process.ExitCode -ge 8) {
    throw "robocopy finalizo con codigo $($process.ExitCode)."
  }

  $summary.backup_path = $resolvedBackupPath
  $summary.manifest_path = $manifestPath
  $summary.source_files_dir = $sourceFilesDir
  $summary.destination_upload_dir = $destinationUploadRoot
  $summary.overwrite_existing = [bool]$OverwriteExisting
  $summary.exit_code = $process.ExitCode
  $summary.validation_destination_exists = (Test-Path -LiteralPath $destinationUploadRoot)
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $true
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  exit 0
}
catch {
  $summary.backup_path = $resolvedBackupPath
  $summary.destination_upload_dir = $destinationUploadRoot
  $summary.errors = @($_.Exception.Message)
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $false
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  throw
}
