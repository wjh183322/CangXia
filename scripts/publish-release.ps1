param([string]$Repository='wjh183322/CangXia')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Push-Location -LiteralPath $projectRoot
try {
    $ghCommand=Get-Command gh -ErrorAction SilentlyContinue
    $ghPath=if($ghCommand){$ghCommand.Source}else{Join-Path $projectRoot '.test-output/publish-tools/gh/bin/gh.exe'}
    if(!(Test-Path -LiteralPath $ghPath)){throw '请先配置 GitHub CLI。'}
    $package=Get-Content -Raw -LiteralPath package.json | ConvertFrom-Json
    $service=Get-Content -Raw -LiteralPath backup-server/package.json | ConvertFrom-Json
    $version=$package.version
    if($version -notmatch '^\d+\.\d+\.\d+$' -or $service.version -notmatch '^\d+\.\d+\.\d+$'){throw '版本号无效。'}
    if((git branch --show-current) -ne 'codex/backup'){throw '备份版只能从 codex/backup 发布。'}
    if((git status --porcelain)){throw '请先提交全部待发布修改。'}
    $tag="backup-v$version"
    $tagCommit=git rev-parse "$tag^{commit}" 2>$null
    if($LASTEXITCODE -ne 0 -or $tagCommit -ne (git rev-parse HEAD)){throw '版本标签必须对应当前代码。'}
    $names=@("CangXia-Backup-$version-Windows-x64.exe","CangXia-Backup-Server-$($service.version).tar.gz","CangXia-Backup-Deploy-$version.zip")
    $files=@($names | ForEach-Object {Join-Path 'release/backup' $_})
    foreach($file in $files){if(!(Test-Path -LiteralPath $file)){throw "缺少发布文件：$file"}}
    $notes="docs/releases/$tag.md"
    if(!(Test-Path -LiteralPath $notes)){throw '缺少版本说明。'}
    & $ghPath release view $tag --repo $Repository --json url 2>$null | Out-Null
    if($LASTEXITCODE -eq 0){throw '版本已存在，不会覆盖。'}
    $hashFile="release/backup/SHA256-Backup-$version.txt"
    $lines=foreach($file in $files){"$((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant())  $(Split-Path $file -Leaf)"}
    [IO.File]::WriteAllText((Join-Path $projectRoot $hashFile),($lines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
    $files+=$hashFile
    git push origin codex/backup $tag
    if($LASTEXITCODE -ne 0){throw '分支或标签推送失败。'}
    & $ghPath release create $tag @files --repo $Repository --verify-tag --draft --prerelease --title "藏匣备份版 $version 预览" --notes-file $notes
    if($LASTEXITCODE -ne 0){throw '草稿上传未完成，请检查实际状态。'}
    $releases=& $ghPath api "repos/$Repository/releases"
    if($LASTEXITCODE -ne 0){throw '无法检查上传结果。'}
    $release=($releases | ConvertFrom-Json) | Where-Object tag_name -eq $tag
    if(@($release).Count -ne 1 -or !$release.draft -or $release.assets.Count -ne $files.Count){throw '草稿附件数量不符。'}
    foreach($asset in $release.assets){$file=Join-Path 'release/backup' $asset.name;$hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();if($asset.digest -ne "sha256:$hash" -or $asset.size -ne (Get-Item -LiteralPath $file).Length){throw '上传附件校验失败，未发布草稿。'}}
    & $ghPath release edit $tag --repo $Repository --draft=false --prerelease --latest=false
    if($LASTEXITCODE -ne 0){throw '发布未完成。'}
} finally {Pop-Location}
