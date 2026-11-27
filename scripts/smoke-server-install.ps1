# Disposable Windows runner only. Verify both normal delivery entry points.
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {throw 'Requires a disposable Windows Actions runner.'}
$dir=Join-Path $env:RUNNER_TEMP 'CangXiaSetup'
$setup=(Resolve-Path 'release/server/CangXia-Server-0.4.1-Setup-x64.exe').Path
$p=Start-Process -FilePath $setup -ArgumentList @('/S',"/D=$dir") -Wait -PassThru -WindowStyle Hidden
if ($p.ExitCode -ne 0) {throw 'NSIS installation failed.'}
$installed=(Get-ChildItem -LiteralPath $dir -Filter '*.exe' | Where-Object Name -NotMatch 'unins' | Select-Object -First 1).FullName
$portable=(Resolve-Path 'release/server/CangXia-Server-0.4.1-Windows-x64.exe').Path
foreach ($program in @($installed,$portable)) {
  Get-Process | Where-Object {$_.ProcessName -eq '藏匣服务版'} | Stop-Process -Force
  $p=Start-Process -FilePath $program -PassThru -WindowStyle Hidden
  $window=$null
  for ($i=0;$i -lt 90;$i++) {
    Start-Sleep -Seconds 1
    $window=Get-Process | Where-Object {$_.ProcessName -eq '藏匣服务版' -and $_.MainWindowTitle -match '藏匣|NAS'} | Select-Object -First 1
    if ($window) {break}
  }
  if (!$window) {throw 'Packaged Electron connection window did not appear.'}
  [void]$window.CloseMainWindow()
  if (!$window.WaitForExit(10000)) {$window.Kill()}
}
