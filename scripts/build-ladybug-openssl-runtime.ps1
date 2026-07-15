$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$contractRoot = Join-Path $repoRoot "ladybug-openssl"
$packageRoot = Join-Path $contractRoot "npm\win32-x64"
$sourcePath = Join-Path $contractRoot "source.json"
$keyPath = Join-Path $contractRoot "keys\openssl-release.asc"
$source = Get-Content $sourcePath -Raw | ConvertFrom-Json
$programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
$programFilesX86 = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { "C:\Program Files (x86)" }
$systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
$tarExe = Join-Path $systemRoot "System32\tar.exe"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sdl-ladybug-openssl-" + [System.Guid]::NewGuid().ToString("N"))
$downloadPath = Join-Path $tempRoot "openssl.tar.gz"
$signaturePath = Join-Path $tempRoot "openssl.tar.gz.asc"
$gpgHome = Join-Path $tempRoot "gnupg"
$installDir = Join-Path $tempRoot "install"
$binDir = Join-Path $packageRoot "bin"

function Get-Sha256([string]$Path) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $hash = $sha256.ComputeHash($stream)
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }

  -join ($hash | ForEach-Object { $_.ToString("x2") })
}

function Find-FirstExisting([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Find-OnPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Convert-ToMsysPath([string]$Path) {
  $normalized = $Path -replace "\\", "/"
  if ($normalized -match "^([A-Za-z]):/(.*)$") {
    return "/" + $matches[1].ToLowerInvariant() + "/" + $matches[2]
  }
  return $normalized
}

function Use-VsDevEnvironment([string]$VsDevCmd) {
  $captureRoot = [System.IO.Path]::GetTempPath()
  $captureId = [System.Guid]::NewGuid().ToString("N")
  $captureScript = Join-Path $captureRoot ("sdl-vsdev-" + $captureId + ".cmd")
  $captureOut = Join-Path $captureRoot ("sdl-vsdev-" + $captureId + ".env")
  $captureLines = @(
    "@echo off",
    ('call "' + $VsDevCmd + '" -arch=x64 -host_arch=x64 >nul'),
    "if errorlevel 1 exit /b %errorlevel%",
    ('set > "' + $captureOut + '"')
  )
  Set-Content -LiteralPath $captureScript -Value $captureLines -Encoding ASCII
  try {
    $process = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", $captureScript) -NoNewWindow -Wait -PassThru
    $vsDevExitCode = $process.ExitCode
    if ($vsDevExitCode -ne 0 -or -not (Test-Path -LiteralPath $captureOut)) { throw "VsDevCmd failed with exit $vsDevExitCode" }
    $lines = Get-Content -LiteralPath $captureOut
    if (-not $lines) { throw "VsDevCmd produced no environment output" }
    foreach ($line in $lines) {
      $index = $line.IndexOf("=")
      if ($index -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $index), $line.Substring($index + 1), "Process") }
    }
  } finally {
    Remove-Item -LiteralPath $captureScript,$captureOut -Force -ErrorAction SilentlyContinue
  }
}
function Convert-ToProcessArgument([string]$Argument) {
  '"' + ($Argument -replace '"', '\"') + '"'
}

function Run-Logged([string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSeconds = 1200) {
  Write-Host ("> " + $Exe + " " + ($Arguments -join " "))
  $argumentList = ""
  if ($Arguments.Count -gt 0) {
    $argumentList = (($Arguments | ForEach-Object { Convert-ToProcessArgument $_ }) -join " ")
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.Arguments = $argumentList
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $kill = Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", $process.Id, "/T", "/F") -NoNewWindow -Wait -PassThru
    if ($kill.ExitCode -ne 0) { Write-Warning "taskkill.exe failed with exit $($kill.ExitCode) for PID $($process.Id)" }
    throw "$Exe timed out after $TimeoutSeconds seconds"
  }
  if ($process.ExitCode -ne 0) { throw "$Exe failed with exit $($process.ExitCode)" }
}

function Invoke-Captured([string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory) {
  $captureId = [System.Guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ("sdl-capture-" + $captureId + ".out")
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("sdl-capture-" + $captureId + ".err")
  try {
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -NoNewWindow -Wait -PassThru
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = ($stdout + $stderr) }
  } finally {
    Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
  }
}

try {
  New-Item -ItemType Directory -Force -Path $tempRoot, $gpgHome, $installDir, $binDir | Out-Null
  Invoke-WebRequest -Uri $source.sourceUrl -OutFile $downloadPath
  Invoke-WebRequest -Uri $source.signatureUrl -OutFile $signaturePath
  $actualHash = Get-Sha256 $downloadPath
  if ($actualHash -ne $source.sourceSha256) { throw "OpenSSL source hash mismatch: expected $($source.sourceSha256), got $actualHash" }

  $gpg = Find-FirstExisting @((Join-Path $programFiles "Git\usr\bin\gpg.exe"), (Find-OnPath "gpg.exe"))
  $gpgv = Find-FirstExisting @((Join-Path $programFiles "Git\usr\bin\gpgv.exe"), (Find-OnPath "gpgv.exe"))
  if (-not $gpg) { throw "gpg.exe not found" }
  if (-not $gpgv) { throw "gpgv.exe not found" }
  $keyPathArg = Convert-ToMsysPath $keyPath
  $signaturePathArg = Convert-ToMsysPath $signaturePath
  $downloadPathArg = Convert-ToMsysPath $downloadPath
  $keyringPath = Join-Path $tempRoot "openssl-release-keyring.gpg"
  $keyringArg = Convert-ToMsysPath $keyringPath
  $fingerprintOut = Join-Path $tempRoot "key-fingerprints.txt"
  $fingerprintErr = Join-Path $tempRoot "key-fingerprints.err"
  $fingerprintProcess = Start-Process -FilePath $gpg -ArgumentList @("--with-colons", "--show-keys", $keyPathArg) -WorkingDirectory $repoRoot -RedirectStandardOutput $fingerprintOut -RedirectStandardError $fingerprintErr -NoNewWindow -Wait -PassThru
  if ($fingerprintProcess.ExitCode -ne 0) { throw "gpg --show-keys failed with exit $($fingerprintProcess.ExitCode): $(Get-Content $fingerprintErr -Raw)" }
  $fingerprints = Get-Content $fingerprintOut -Raw
  if ($fingerprints -notmatch $source.releaseSignerFingerprint) { throw "Committed key bundle does not contain expected fingerprint $($source.releaseSignerFingerprint)" }
  Run-Logged $gpg @("--batch", "--yes", "--dearmor", "--output", $keyringArg, $keyPathArg) $repoRoot
  Run-Logged $gpgv @("--keyring", $keyringArg, $signaturePathArg, $downloadPathArg) $repoRoot

  $perlOverride = $env:SDL_OPENSSL_PERL
  $nasmOverride = $env:SDL_OPENSSL_NASM
  $vswhere = Find-FirstExisting @((Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"), (Join-Path $programFiles "Microsoft Visual Studio\Installer\vswhere.exe"))
  if (-not $vswhere) { throw "vswhere.exe not found" }
  $vsInstallOutput = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $vsInstall = if ($vsInstallOutput) { $vsInstallOutput.Trim() } else { "" }
  $vsDevCmd = if ($vsInstall) { Join-Path $vsInstall "Common7\Tools\VsDevCmd.bat" } else { $null }
  if (-not $vsDevCmd -or -not (Test-Path -LiteralPath $vsDevCmd)) {
    $vsDevCmd = Find-FirstExisting @(
      (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"),
      (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat"),
      (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat"),
      (Join-Path $programFilesX86 "Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat")
    )
    if ($vsDevCmd) {
      $vsInstall = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $vsDevCmd))
    }
  }
  if (-not $vsInstall -or -not $vsDevCmd) { throw "Visual Studio 2022 with C++ tools was not found" }
  if (-not (Test-Path -LiteralPath $vsDevCmd)) { throw "VsDevCmd.bat not found: $vsDevCmd" }
  Use-VsDevEnvironment $vsDevCmd

  $perl = Find-FirstExisting @($perlOverride, "C:\Strawberry\perl\bin\perl.exe", "C:\Perl64\bin\perl.exe", (Find-OnPath "perl.exe"), "C:\Program Files\Git\usr\bin\perl.exe")
  $nasm = Find-FirstExisting @($nasmOverride, (Find-OnPath "nasm.exe"), "C:\Program Files\NASM\nasm.exe", "C:\ProgramData\chocolatey\bin\nasm.exe")
  $nmake = Find-OnPath "nmake.exe"
  $link = Find-OnPath "link.exe"
  $msvcToolsetVersion = $env:VCToolsVersion
  if (-not $msvcToolsetVersion -and $link) {
    $msvcToolsetVersion = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $link))))
  }
  if (-not $perl) { throw "perl.exe not found" }
  $perlCheck = Invoke-Captured $perl @("-MLocale::Maketext::Simple", "-MIPC::Cmd", "-e", "print qq(ok)") $repoRoot
  if ($perlCheck.ExitCode -ne 0) { throw "perl.exe at $perl is missing modules required by OpenSSL Configure; install Strawberry Perl or put a full Perl first on PATH: $($perlCheck.Output)" }
  if (-not $nasm) { throw "nasm.exe not found" }
  if (-not $nmake) { throw "nmake.exe not found after VsDevCmd" }
  if (-not $link) { throw "link.exe not found after VsDevCmd" }
  $env:PATH = (Split-Path -Parent $perl) + ";" + (Split-Path -Parent $nasm) + ";" + $env:PATH
  $env:NASM = $nasm
  [Environment]::SetEnvironmentVariable("PATH", $env:PATH, "Process")
  [Environment]::SetEnvironmentVariable("NASM", $env:NASM, "Process")

  if (-not (Test-Path -LiteralPath $tarExe)) { throw "Windows tar.exe not found: $tarExe" }
  Run-Logged $tarExe @("-xzf", $downloadPath, "-C", $tempRoot) $repoRoot
  $expectedSourceDir = Join-Path $tempRoot ("openssl-" + $source.opensslVersion)
  if (Test-Path -LiteralPath (Join-Path $expectedSourceDir "Configure")) {
    $sourceDir = $expectedSourceDir
  } else {
    # Release archives are authoritative by checksum/signature, but their
    # top-level folder name can vary by source host. Select the verified
    # extracted OpenSSL tree by its Configure entry point.
    $sourceDir = Get-ChildItem -LiteralPath $tempRoot -Directory |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "Configure") } |
      Sort-Object Name |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $sourceDir) { throw "OpenSSL source directory missing after extraction under: $tempRoot" }
  Run-Logged $perl @("Configure", $source.configureTarget, "shared", "--release", "--prefix=$installDir", "--openssldir=$installDir\ssl") $sourceDir
  Run-Logged $nmake @() $sourceDir
  Run-Logged $nmake @("test") $sourceDir 3600
  Run-Logged $nmake @("install_sw") $sourceDir

  Remove-Item -LiteralPath (Join-Path $binDir "*.dll") -Force -ErrorAction SilentlyContinue
  foreach ($dll in @("libcrypto-3-x64.dll", "libssl-3-x64.dll")) {
    $built = Get-ChildItem -LiteralPath $installDir -Filter $dll -Recurse | Select-Object -First 1
    if (-not $built) { throw "Built DLL not found: $dll" }
    Copy-Item -LiteralPath $built.FullName -Destination (Join-Path $binDir $dll) -Force
  }
  $opensslExe = Join-Path $installDir "bin\openssl.exe"
  if (-not (Test-Path -LiteralPath $opensslExe)) { throw "Built openssl.exe not found: $opensslExe" }
  $opensslVersion = (& $opensslExe version -v).ToString().Trim()

  $gpgVersion = (Invoke-Captured $gpg @("--version") $repoRoot).Output.Split([Environment]::NewLine)[0].Trim()
  $gpgvVersion = (Invoke-Captured $gpgv @("--version") $repoRoot).Output.Split([Environment]::NewLine)[0].Trim()
  $perlVersionOutput = (Invoke-Captured $perl @("-v") $repoRoot).Output
  $perlVersion = (($perlVersionOutput -split [Environment]::NewLine) | Where-Object { $_ -match "This is perl" } | Select-Object -First 1).ToString().Trim()
  $nasmVersion = (Invoke-Captured $nasm @("-v") $repoRoot).Output.Trim()
  $nmakeVersion = (Invoke-Captured $nmake @("/?") $repoRoot).Output.Split([Environment]::NewLine)[0].Trim()
  $linkVersion = (Invoke-Captured $link @("/?") $repoRoot).Output.Split([Environment]::NewLine)[0].Trim()

  $record = [ordered]@{
    sourceSha256 = $actualHash
    signatureVerified = $true
    gpg = $gpgVersion
    gpgPath = $gpg
    gpgv = $gpgvVersion
    gpgvPath = $gpgv
    perl = $perlVersion
    perlPath = $perl
    nasm = $nasmVersion
    nasmPath = $nasm
    nmake = $nmakeVersion
    nmakePath = $nmake
    link = $linkVersion
    linkPath = $link
    msvcToolsetVersion = $msvcToolsetVersion
    opensslVersion = $opensslVersion
    visualStudioPath = $vsInstall
    windowsSdkVersion = $env:WindowsSDKVersion
    configureCommand = "perl Configure $($source.configureTarget) shared --release --prefix=<installDir> --openssldir=<installDir>\ssl"
    buildCommand = "nmake && nmake test && nmake install_sw"
  }
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $contractRoot "build-record.json") -Encoding UTF8
  Write-Host "Staged OpenSSL runtime DLLs in $binDir"
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
