[CmdletBinding()]
param(
  [string]$BackendRoot = '',
  [string]$BackupRootDir = '',
  [string]$UploadDir = '',
  [string]$LogDir = '',
  [string]$RobocopyPath = 'robocopy'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_backup_common.ps1')

$resolvedBackendRoot = Resolve-BackendRoot -InputRoot $BackendRoot
Import-DotEnv -BackendRoot $resolvedBackendRoot

$resolvedBackupRoot = Resolve-BackupRootDir -ExplicitPath $BackupRootDir -BackendRoot $resolvedBackendRoot
$resolvedLogDir = Resolve-LogDir -ExplicitPath $LogDir -BackupRootDir $resolvedBackupRoot
$ctx = New-BackupRunContext -Job 'backup_uploads' -BackendRoot $resolvedBackendRoot -BackupRoot $resolvedBackupRoot -LogRoot $resolvedLogDir
$summary = New-BaseSummary -Context $ctx -Operation 'backup'

if ($RobocopyPath -eq 'robocopy') {
  $RobocopyPath = Get-ConfigValue -Names @('BACKUP_ROBOCOPY_PATH') -DefaultValue $RobocopyPath
}

$sourceUploadRoot = Resolve-UploadRoot -ExplicitPath $UploadDir -BackendRoot $resolvedBackendRoot
if (-not (Test-Path -LiteralPath $sourceUploadRoot)) {
  throw "No se encontro la carpeta de uploads a respaldar: $sourceUploadRoot"
}

$uploadsRoot = Ensure-Directory -PathValue (Join-Path $resolvedBackupRoot "uploads\$($ctx.DateStamp)")
$backupFolder = Ensure-Directory -PathValue (Join-Path $uploadsRoot "uploads_$($ctx.TimestampCompact)")
$backupFilesDir = Ensure-Directory -PathValue (Join-Path $backupFolder 'files')
$manifestPath = Join-Path $backupFolder 'manifest.json'
$robocopyLog = Join-Path $resolvedLogDir "backup_uploads_$($ctx.TimestampCompact).robocopy.log"

if (Test-PathWithin -ChildPath $backupFolder -ParentPath $sourceUploadRoot) {
  throw "BACKUP_ROOT_DIR no debe ubicarse dentro de UPLOAD_DIR, para evitar recursion durante el respaldo."
}

Write-JsonLog -Path $ctx.LogPath -Payload ([ordered]@{
  event = 'backup_uploads_started'
  run_id = $ctx.RunId
  job = $ctx.Job
  started_at = $ctx.StartedAt.ToString('o')
  source_upload_dir = $sourceUploadRoot
  backup_folder = $backupFolder
  robocopy = $RobocopyPath
})

try {
  $robocopyArguments = @(
    $sourceUploadRoot
    $backupFilesDir
    '/E'
    '/R:2'
    '/W:2'
    '/COPY:DAT'
    '/DCOPY:DAT'
    '/NP'
    '/TEE'
    "/LOG:$robocopyLog"
  )

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

  $fileCount = (Get-ChildItem -LiteralPath $backupFilesDir -Recurse -File | Measure-Object).Count
  $totalBytes = (Get-ChildItem -LiteralPath $backupFilesDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $totalBytes) {
    $totalBytes = 0
  }

  $manifest = [ordered]@{
    run_id = $ctx.RunId
    backup_type = 'uploads'
    created_at = (Get-Date).ToString('o')
    source_upload_dir = $sourceUploadRoot
    backup_folder = $backupFolder
    files_dir = $backupFilesDir
    file_count = $fileCount
    total_bytes = [int64]$totalBytes
    robocopy_exit_code = $process.ExitCode
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  $summary.source_upload_dir = $sourceUploadRoot
  $summary.backup_folder = $backupFolder
  $summary.files_dir = $backupFilesDir
  $summary.manifest_path = $manifestPath
  $summary.file_count = $fileCount
  $summary.total_bytes = [int64]$totalBytes
  $summary.exit_code = $process.ExitCode
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $true
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  exit 0
}
catch {
  $summary.source_upload_dir = $sourceUploadRoot
  $summary.backup_folder = $backupFolder
  $summary.errors = @($_.Exception.Message)
  $summary = Complete-Summary -Context $ctx -Summary $summary -Success $false
  Write-JsonLog -Path $ctx.LogPath -Payload $summary
  throw
}
