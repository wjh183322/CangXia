# Run both ordinary end-user entry points on a hosted, disposable Windows runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Requires a disposable Windows Actions runner.' }
. (Join-Path $PSScriptRoot 'windows-shortcut.ps1')

$product = '藏匣服务版'
$version = '0.4.1'
$setup = (Resolve-Path -LiteralPath 'release/server/CangXia-Server-0.4.1-Setup-x64.exe').Path
$portable = (Resolve-Path -LiteralPath 'release/server/CangXia-Server-0.4.1-Windows-x64.exe').Path
$unpacked = (Resolve-Path -LiteralPath "release/server/win-unpacked/$product.exe").Path
$expectedExeHash = (Get-FileHash -LiteralPath $unpacked).Hash
$expectedAsarHash = (Get-FileHash -LiteralPath 'release/server/win-unpacked/resources/app.asar').Hash
$installDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs/cangxia-server'
$installed = Join-Path $installDir "$product.exe"
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$product.lnk"
$appData = [Environment]::GetFolderPath('ApplicationData')
$profile = Join-Path $appData $product
foreach ($fresh in @($installDir,$shortcut,$profile)) {
    if (Test-Path -LiteralPath $fresh) { throw "Expected a fresh runner path: $fresh" }
}

function Get-SmokeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = '$product.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath)
}
function Get-SmokeEvents {
    $file = Join-Path $profile 'diagnostics/events.jsonl'
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $file -Tail 40 -Encoding utf8)) {
            try { ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { }
        }
    }
}
function Test-SmokeLaunch([string]$kind) {
    if (@(Get-SmokeProcesses).Count -or (Test-Path -LiteralPath $profile)) { throw "Expected a new process and empty profile for $kind." }
    $launcher = $null
    $main = $null
    $proof = $null
    $verifiedPath = $null
    try {
        if ($kind -eq 'installed') {
            Start-Process -FilePath $shortcut -WindowStyle Hidden
        } else {
            $launcher = Start-Process -FilePath $portable -PassThru -WindowStyle Hidden
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        do {
            $processes = @(Get-SmokeProcesses)
            $main = if ($kind -eq 'installed') {
                $processes | Where-Object { $_.ExecutablePath -eq $installed -and $_.ParentProcessId -notin $processes.ProcessId } | Select-Object -First 1
            } else {
                $processes | Where-Object { $_.ParentProcessId -eq $launcher.Id -and $_.ExecutablePath -and $_.ExecutablePath -ne $installed } | Select-Object -First 1
            }
            $events = @(Get-SmokeEvents)
            $proof = [ordered]@{
                entry = $kind
                processId = $main.ProcessId
                executable = $main.ExecutablePath
                launcherId = $launcher.Id
                startupVersion = $events | Where-Object event -eq 'startup' | Select-Object -Last 1 -ExpandProperty version
                stages = @($events | Where-Object event -eq 'startup-stage' | Select-Object -Last 6 -ExpandProperty name)
                hasLocalLibrary = Test-Path -LiteralPath (Join-Path $profile 'library.sqlite')
                observedProcesses = @($processes | Select-Object -First 6)
            }
            if ($main) { $verifiedPath = $main.ExecutablePath }
            if ($main -and $proof.startupVersion -eq $version -and 'connection-visible' -in $proof.stages -and !$proof.hasLocalLibrary) { break }
            if ($proof.hasLocalLibrary -or ($launcher -and $launcher.HasExited)) { break }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        $proof | ConvertTo-Json -Depth 4
        if (!$main -or $proof.startupVersion -ne $version -or 'connection-visible' -notin $proof.stages -or $proof.hasLocalLibrary) {
            throw "Missing fresh renderer-confirmed NAS connection gate for $kind."
        }
        if ((Get-Item -LiteralPath $verifiedPath).VersionInfo.ProductName -ne $product -or
            (Get-FileHash -LiteralPath $verifiedPath).Hash -ne $expectedExeHash -or
            (Get-FileHash -LiteralPath (Join-Path (Split-Path -Parent $verifiedPath) 'resources/app.asar')).Hash -ne $expectedAsarHash) {
            throw "$kind did not run the tested product executable and application archive."
        }
    } finally {
        if ($verifiedPath) {
            foreach ($process in @(Get-Process -Name $product -ErrorAction SilentlyContinue | Where-Object Path -eq $verifiedPath)) {
                try { $process.Kill() } catch { if (!$process.HasExited) { throw } }
            }
            $end = [DateTime]::UtcNow.AddSeconds(15)
            while (@(Get-SmokeProcesses | Where-Object ExecutablePath -eq $verifiedPath).Count -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 200 }
            if (@(Get-SmokeProcesses | Where-Object ExecutablePath -eq $verifiedPath).Count) { throw "$kind did not exit." }
        }
        if ($launcher -and !$launcher.WaitForExit(15000)) { $launcher.Kill(); throw 'Portable launcher did not finish.' }
    }
}

$installer = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
if ($installer.ExitCode -ne 0 -or !(Test-Path -LiteralPath $installed -PathType Leaf)) { throw "NSIS installation failed ($($installer.ExitCode))." }
Assert-ShortcutTarget $shortcut $installed
Test-SmokeLaunch 'installed'
# Only archive the fresh profile produced by our verified launch, on the same runner volume.
$archive = Join-Path $appData ('cangxia-confirmed-smoke-' + [Guid]::NewGuid().ToString('N'))
$entry = Get-Item -LiteralPath $profile
if ($entry.FullName -ne [IO.Path]::GetFullPath((Join-Path $appData $product)) -or
    !$entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($archive)) -ne [IO.Path]::GetFullPath($appData) -or (Test-Path -LiteralPath $archive)) {
    throw 'The verified test profile cannot be isolated for the portable launch.'
}
Move-Item -LiteralPath $entry.FullName -Destination $archive
Test-SmokeLaunch 'portable'
