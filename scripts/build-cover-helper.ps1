param([string]$Python = "python")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$venv = Join-Path $root '.test-output/cover-build-venv'
if (!(Test-Path "$venv/Scripts/python.exe")) { & $Python -m venv $venv; if ($LASTEXITCODE) { throw 'Create build environment failed' } }
& "$venv/Scripts/python.exe" -m pip install -r scripts/cover-requirements.txt
if ($LASTEXITCODE) { throw 'Install cover dependencies failed' }
& "$venv/Scripts/python.exe" -m PyInstaller --noconfirm --onedir --name CangXiaCover --distpath .test-output/cover-helper-dist --workpath .test-output/cover-helper-build --specpath .test-output scripts/cover-frame.py
if ($LASTEXITCODE) { throw 'Build cover helper failed' }
# Keep the dependency notices with the distributed helper.
$notices = '.test-output/cover-helper-dist/CangXiaCover/licenses'
New-Item -ItemType Directory -Force $notices | Out-Null
Get-ChildItem "$venv/Lib/site-packages/cv2" -File -Filter 'LICENSE*' | Copy-Item -Destination $notices -Force
Get-ChildItem "$venv/Lib/site-packages" -Directory -Filter '*.dist-info' | ForEach-Object {
    $packageNotices = Join-Path $notices $_.Name
    New-Item -ItemType Directory -Force $packageNotices | Out-Null
    Get-ChildItem $_.FullName -File | Where-Object { $_.Name -match 'LICENSE|COPYING|NOTICE|METADATA' } | Copy-Item -Destination $packageNotices
    if (Test-Path (Join-Path $_.FullName 'licenses')) { Copy-Item (Join-Path $_.FullName 'licenses') $packageNotices -Recurse -Force }
}
