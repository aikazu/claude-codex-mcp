# claude-codex-mcp installer for Windows (PowerShell 5.1+ / 7+).
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall
#
# Thin wrapper: finds Node and hands over to scripts/register.mjs, which does
# the JSON editing (with backups) and the `claude mcp add` call.
param(
  [switch]$Uninstall,
  [switch]$DryRun,
  [string]$Name = "codex",
  [string]$AssetDir,
  [string]$Sandbox = "",
  [string]$TaskModel,
  [string]$TaskEffort,
  [string]$ImageModel,
  [string]$ImageEffort
)
$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js 20+ is required (https://nodejs.org). Install it, open a new terminal, and rerun." -ForegroundColor Red
  exit 1
}

$register = Join-Path $PSScriptRoot "register.mjs"
$argsList = @($register, "--name", $Name)
if ($Uninstall) { $argsList += "--uninstall" }
if ($DryRun) { $argsList += "--dry-run" }
if ($AssetDir) { $argsList += @("--asset-dir", $AssetDir) }
if ($Sandbox) { $argsList += @("--sandbox", $Sandbox) }
if ($TaskModel) { $argsList += @("--task-model", $TaskModel) }
if ($TaskEffort) { $argsList += @("--task-effort", $TaskEffort) }
if ($ImageModel) { $argsList += @("--image-model", $ImageModel) }
if ($ImageEffort) { $argsList += @("--image-effort", $ImageEffort) }

# Native tools may write to stderr; under "Stop" Windows PowerShell 5.1 would
# turn that into a terminating error, so relax it for the child process.
$ErrorActionPreference = "Continue"
& $node.Source @argsList
exit $LASTEXITCODE
