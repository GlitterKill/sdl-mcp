
$sdlScriptSucceeded = $?
$sdlNativeExitCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
if (-not $sdlScriptSucceeded) {
  if ($null -ne $sdlNativeExitCode -and $sdlNativeExitCode -ne 0) { exit $sdlNativeExitCode }
  exit 1
}
$sdlScriptSucceeded = $?
$sdlNativeExitCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
if (-not $sdlScriptSucceeded) {
  if ($null -ne $sdlNativeExitCode -and $sdlNativeExitCode -ne 0) { exit $sdlNativeExitCode }
  exit 1
}