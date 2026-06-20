<#
.SYNOPSIS
Builds the current SDL-MCP checkout and installs it as the global sdl-mcp command.

.DESCRIPTION
Use this after changing local code when you want the HTTP server started from your
global sdl-mcp install to use the latest local runtime, native addon, and managed
Watchman packages.

The script installs the local packages globally in dependency order:
1. native platform package
2. native umbrella package
3. Watchman platform package
4. Watchman umbrella package
5. main sdl-mcp package

.PARAMETER SkipNpmInstall
Skip npm install in the repo before building.

.PARAMETER SkipWatchmanStage
Skip downloading/staging Watchman platform package binaries.
Use this only when watchman/npm/win32-x64/vendor/bin/watchman.exe already exists.
#>
[CmdletBinding()]
param(
  [switch]$SkipNpmInstall,
  [switch]$SkipWatchmanStage
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [scriptblock]$Script
  )

  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Script
}

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found on PATH: $Name"
  }
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
  }
}

function Resolve-InstalledWatchmanBinary {
  param([Parameter(Mandatory = $true)][string]$GlobalSdlMcpRoot)

  $resolverScript = @'
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.SDL_MCP_VERIFY_PACKAGE_ROOT;
if (!packageRoot) {
  console.error("SDL_MCP_VERIFY_PACKAGE_ROOT was not set");
  process.exit(1);
}

const modulePath = join(packageRoot, "dist", "indexer", "watchman-binary.js");
if (!existsSync(modulePath)) {
  console.error(`Installed SDL-MCP Watchman resolver was not found at ${modulePath}`);
  process.exit(1);
}

const { resolveWatchmanBinary } = await import(pathToFileURL(modulePath).href);
const result = resolveWatchmanBinary();
if (!result.binaryPath) {
  console.error(result.reason ?? "No managed Watchman binary resolved");
  process.exit(1);
}

console.log(result.binaryPath);
'@

  $previousVerifyRoot = [Environment]::GetEnvironmentVariable("SDL_MCP_VERIFY_PACKAGE_ROOT", "Process")
  $env:SDL_MCP_VERIFY_PACKAGE_ROOT = $GlobalSdlMcpRoot
  try {
    $resolved = & node --input-type=module --eval $resolverScript
    if ($LASTEXITCODE -ne 0) {
      throw "Global sdl-mcp could not resolve its managed Watchman binary."
    }
  } finally {
    if ($null -eq $previousVerifyRoot) {
      Remove-Item Env:\SDL_MCP_VERIFY_PACKAGE_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:SDL_MCP_VERIFY_PACKAGE_ROOT = $previousVerifyRoot
    }
  }

  $binaryPath = ($resolved | Select-Object -Last 1).Trim()
  if (-not $binaryPath) {
    throw "Global sdl-mcp returned an empty managed Watchman binary path."
  }
  return $binaryPath
}

function Stop-ManagedWatchmanBinary {
  param([Parameter(Mandatory = $true)][string]$BinaryPath)

  if (-not (Test-Path $BinaryPath)) {
    return
  }

  Write-Host "Stopping managed Watchman before restaging: $BinaryPath"
  & $BinaryPath --no-pretty --no-spawn shutdown-server *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Watchman shutdown-server exited with $LASTEXITCODE; continuing." -ForegroundColor Yellow
  }
  Start-Sleep -Milliseconds 500
}
$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repoRoot

Assert-Command npm
Assert-Command node

$nativePlatformPackage = Join-Path $repoRoot "native/npm/win32-x64-msvc"
$watchmanPlatformPackage = Join-Path $repoRoot "watchman/npm/win32-x64"
$watchmanBinary = Join-Path $watchmanPlatformPackage "vendor/bin/watchman.exe"

if (-not $SkipNpmInstall) {
  Invoke-Step "Install repo dependencies" {
    Invoke-Native npm install --legacy-peer-deps
  }
}

Invoke-Step "Build runtime JavaScript" {
  Invoke-Native npm run build
}

Invoke-Step "Build native addon" {
  Invoke-Native npm run build:native
}

Invoke-Step "Stage native platform package" {
  $sourceNativeArtifact = Join-Path $repoRoot "native/sdl-mcp-native.node"
  $nativeArtifact = Join-Path $nativePlatformPackage "sdl-mcp-native.win32-x64-msvc.node"
  if (-not (Test-Path $sourceNativeArtifact)) {
    throw "Native build output was not found at $sourceNativeArtifact"
  }
  Copy-Item -LiteralPath $sourceNativeArtifact -Destination $nativeArtifact -Force
  if (-not (Test-Path $nativeArtifact)) {
    throw "Native platform artifact was not staged under $nativePlatformPackage"
  }
}

if (-not $SkipWatchmanStage) {
  Invoke-Step "Stage Watchman platform packages" {
    if (-not (Get-Command unzip -ErrorAction SilentlyContinue)) {
      throw "scripts/prepare-watchman-packages.mjs requires unzip on PATH. Install Git for Windows/MSYS2 unzip, or rerun with -SkipWatchmanStage if $watchmanBinary already exists."
    }

    Stop-ManagedWatchmanBinary -BinaryPath $watchmanBinary
    $globalRootBeforeStage = (npm root -g).Trim()
    Stop-ManagedWatchmanBinary -BinaryPath (Join-Path $globalRootBeforeStage "sdl-mcp-watchman-win32-x64/vendor/bin/watchman.exe")

    Invoke-Native node scripts/prepare-watchman-packages.mjs
  }
}

if (-not (Test-Path $watchmanBinary)) {
  throw "Managed Watchman binary was not found at $watchmanBinary"
}

Invoke-Step "Remove existing global SDL-MCP packages" {
  $globalPackages = @(
    "sdl-mcp",
    "sdl-mcp-native",
    "sdl-mcp-native-win32-x64-msvc",
    "sdl-mcp-watchman",
    "sdl-mcp-watchman-win32-x64"
  )
  Invoke-Native npm uninstall -g @globalPackages
}

Invoke-Step "Install local packages globally" {
  $localPackages = @(
    $nativePlatformPackage,
    (Join-Path $repoRoot "native"),
    $watchmanPlatformPackage,
    (Join-Path $repoRoot "watchman"),
    $repoRoot
  )
  Invoke-Native npm install -g @localPackages
}

Invoke-Step "Verify global sdl-mcp command" {
  Invoke-Native sdl-mcp version
}

Invoke-Step "Verify managed Watchman resolver" {
  $globalRoot = (npm root -g).Trim()
  $globalSdlMcpRoot = Join-Path $globalRoot "sdl-mcp"
  if (-not (Test-Path $globalSdlMcpRoot)) {
    throw "Global sdl-mcp package was not found at $globalSdlMcpRoot"
  }

  $globalWatchman = Resolve-InstalledWatchmanBinary -GlobalSdlMcpRoot $globalSdlMcpRoot
  if (-not (Test-Path $globalWatchman)) {
    throw "Global sdl-mcp resolved a missing managed Watchman binary at $globalWatchman"
  }

  Write-Host "Resolved managed Watchman: $globalWatchman"
  Invoke-Native $globalWatchman --version
  Invoke-Native $globalWatchman --no-pretty get-sockname
}

Write-Host ""
Write-Host "Global sdl-mcp now points at the latest local checkout build." -ForegroundColor Green
