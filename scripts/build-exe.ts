#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function log(message: string): void {
  console.log(`[build-exe] ${message}`);
}

function error(message: string): void {
  console.error(`[build-exe] ERROR: ${message}`);
  process.exit(1);
}

function checkPrerequisites(): void {
  log("Checking prerequisites...");

  const pkgJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

  if (!pkgJson.dependencies) {
    error("No dependencies found in package.json");
  }

  log(`Node version: ${process.version}`);

  try {
    execSync("npm list --depth=0", { stdio: "pipe" });
  } catch (err) {
    error("Dependencies not installed. Run 'npm install' first.");
  }

  log("✅ Prerequisites check passed");
}

function buildTypeScript(): void {
  log("Building TypeScript...");

  try {
    execSync("npm run build", { stdio: "inherit" });
    log("✅ TypeScript build successful");
  } catch (err) {
    error("TypeScript build failed");
  }
}

function buildWithPkg(): void {
  log("Building single executable with pkg...");

  try {
    execSync("npm list pkg", { stdio: "pipe" });
  } catch (err) {
    log("pkg not found, installing...");
    try {
      execSync("npm install --save-dev pkg", { stdio: "inherit" });
    } catch (installErr) {
      error("Failed to install pkg");
    }
  }

  const outputDir = join(__dirname, "../dist/exe");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const pkgJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
  const targets: string[] = [];

  if (process.platform === "win32") {
    targets.push("node18-win-x64");
  } else if (process.platform === "darwin") {
    targets.push("node18-macos-x64", "node18-macos-arm64");
  } else {
    targets.push("node18-linux-x64");
  }

  log(`Building targets: ${targets.join(", ")}`);

  try {
    const pkgCmd = `npx pkg dist/cli/index.js --targets ${targets.join(",")} --output ${outputDir}/sdl-mcp`;
    log(`Running: ${pkgCmd}`);
    execSync(pkgCmd, { stdio: "inherit" });
    log("✅ Single executable built successfully");
  } catch (err) {
    log("⚠️  pkg build encountered issues, trying alternative method...");

    try {
      const altCmd = `npx pkg . --targets ${targets.join(",")} --output ${outputDir}/sdl-mcp`;
      log(`Running: ${altCmd}`);
      execSync(altCmd, { stdio: "inherit" });
      log("✅ Single executable built successfully");
    } catch (altErr) {
      error("Single executable build failed");
    }
  }

  log(`\nExecutable location: ${outputDir}/sdl-mcp${process.platform === "win32" ? ".exe" : ""}`);
}

function buildWithNexe(): void {
  log("Building single executable with nexe (alternative)...");

  try {
    execSync("npm list nexe", { stdio: "pipe" });
  } catch (err) {
    log("nexe not found, installing...");
    try {
      execSync("npm install --save-dev nexe", { stdio: "inherit" });
    } catch (installErr) {
      log("⚠️  Failed to install nexe, skipping...");
      return;
    }
  }

  const outputDir = join(__dirname, "../dist/exe");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const output = join(outputDir, `sdl-mcp${process.platform === "win32" ? ".exe" : ""}`);

  try {
    const nexeCmd = `npx nexe dist/cli/index.js --output ${output}`;
    log(`Running: ${nexeCmd}`);
    execSync(nexeCmd, { stdio: "inherit" });
    log("✅ Single executable built successfully with nexe");
  } catch (err) {
    log("⚠️  nexe build encountered issues");
  }
}

function createInstallerScript(): void {
  log("Creating installation script...");

  const outputDir = join(__dirname, "../dist/exe");
  const installerPath = join(outputDir, "install.sh");

  const scriptContent = `#!/bin/bash
set -e

echo "SDL-MCP Single-Executable Installer"
echo "=================================="

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root or use sudo"
  exit 1
fi

INSTALL_DIR="/usr/local/bin"
BINARY_NAME="sdl-mcp"

if [ -f "${outputDir}/sdl-mcp" ]; then
  cp "${outputDir}/sdl-mcp" "$INSTALL_DIR/$BINARY_NAME"
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  echo "✅ Installed to $INSTALL_DIR/$BINARY_NAME"
else
  echo "❌ Binary not found at ${outputDir}/sdl-mcp"
  exit 1
fi

echo ""
echo "Installation complete!"
echo "Run 'sdl-mcp --help' to verify."
`;

  writeFileSync(installerPath, scriptContent, { mode: 0o755 });
  log(`✅ Installation script created: ${installerPath}`);

  const windowsInstallerPath = join(outputDir, "install.ps1");

  const psScriptContent = `# SDL-MCP Windows Installer
# Run PowerShell as Administrator

Write-Host "SDL-MCP Single-Executable Installer" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan

$InstallDir = "$env:LOCALAPPDATA\\Programs"
$BinaryName = "sdl-mcp.exe"

if (-not (Test-Path "$InstallDir")) {
    New-Item -ItemType Directory -Path "$InstallDir" | Out-Null
}

$BinaryPath = Join-Path $InstallDir $BinaryName

if (Test-Path "${outputDir}\\sdl-mcp.exe") {
    Copy-Item "${outputDir}\\sdl-mcp.exe" -Destination $BinaryPath -Force
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$InstallDir", "User")
        Write-Host "✅ Added to PATH" -ForegroundColor Green
    }
    Write-Host "✅ Installed to $BinaryPath" -ForegroundColor Green
    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host "Run 'sdl-mcp --help' to verify." -ForegroundColor Yellow
} else {
    Write-Host "❌ Binary not found at ${outputDir}\\sdl-mcp.exe" -ForegroundColor Red
    exit 1
}
`;

  writeFileSync(windowsInstallerPath, psScriptContent);
  log(`✅ Windows installer script created: ${windowsInstallerPath}`);
}

function main(): void {
  log("SDL-MCP Single-Executable Build Script");
  log("=====================================");
  log("");

  checkPrerequisites();
  buildTypeScript();

  const buildMethod = process.argv[2] || "pkg";

  if (buildMethod === "nexe") {
    buildWithNexe();
  } else if (buildMethod === "both") {
    buildWithPkg();
    buildWithNexe();
  } else {
    buildWithPkg();
  }

  createInstallerScript();

  log("");
  log("=====================================");
  log("Build process completed!");
  log("");
  log("Next steps:");
  log("  - Test the executable: ./dist/exe/sdl-mcp --help");
  log("  - Run installer script (Linux/Mac: ./dist/exe/install.sh, Windows: ./dist/exe/install.ps1)");
  log("  - Or manually copy to your PATH");
  log("=====================================");
}


try {
  main();
} catch (err) {
  error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
}
