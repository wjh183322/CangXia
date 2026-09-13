param([string]$Repository = 'wjh183322/CangXia')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location -LiteralPath $projectRoot
try {
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    $ghPath = if ($ghCommand) { $ghCommand.Source } else { Join-Path $projectRoot '.test-output/publish-tools/gh/bin/gh.exe' }
    if (!(Test-Path -LiteralPath $ghPath)) { throw '请先安装并登录 GitHub CLI（gh auth login）。' }
    $package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
    $version = $package.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '版本号必须为 X.Y.Z。' }
    $tag = "v$version"
    if ((git status --porcelain)) { throw '请先提交源码，工作目录必须干净。' }
    $head = git rev-parse HEAD
    $tagCommit = git rev-parse "$tag^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0 -or $head -ne $tagCommit) { throw "请先给当前源码创建标签 $tag。" }
    $exe = "release/CangXia-$version-Windows-x64.exe"
    $notes = "docs/releases/v$version.md"
    if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $notes)) { throw '程序文件或版本说明不存在。' }
    & $ghPath api user --jq .login | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI 尚未登录。' }
    $existing = & $ghPath release view $tag --repo $Repository --json url 2>$null
    if ($LASTEXITCODE -eq 0) { throw "Release $tag 已存在，不会覆盖：$existing" }
    $hashFile = "release/SHA256-$version.txt"
    $hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    Set-Content -LiteralPath $hashFile -Value "$hash  CangXia-$version-Windows-x64.exe" -Encoding utf8
    git push origin HEAD $tag
    if ($LASTEXITCODE -ne 0) { throw '源码或标签推送失败。' }
    & $ghPath release create $tag $exe $hashFile --repo $Repository --verify-tag --title "CangXia v$version" --notes-file $notes
    if ($LASTEXITCODE -ne 0) { throw 'Release 发布未完成，请检查 GitHub 上的实际状态后再处理。' }
} finally { Pop-Location }
