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
    $names=@("CangXia-Backup-$version-Windows-x64.exe","CangXia-Backup-Deploy-$version.zip")
    $files=@($names | ForEach-Object {Join-Path 'release/backup' $_})
    foreach($file in $files){if(!(Test-Path -LiteralPath $file)){throw "缺少发布文件：$file"}}
    $releases=& $ghPath api "repos/$Repository/releases"
    if($LASTEXITCODE -ne 0){throw '无法检查 Release。'}
    $release=($releases | ConvertFrom-Json) | Where-Object tag_name -eq $tag
    if(@($release).Count -ne 1 -or !$release.draft){throw '请先推送备份版标签，等待服务构建流程创建并上传到草稿；已发布版本不会覆盖。'}
    $serverName="CangXia-Backup-Server-$($service.version).tar.gz"
    $serverAsset=$release.assets | Where-Object name -eq $serverName
    if(!$serverAsset){throw '服务镜像还未上传完成，请等待 CI。'}
    & $ghPath release download $tag --repo $Repository --pattern SHA256-server.txt --dir release/backup/server-check --clobber
    if($LASTEXITCODE -ne 0){throw '无法获取 CI 镜像校验值。'}
    $serverLine=Get-Content -LiteralPath release/backup/server-check/SHA256-server.txt | Where-Object {($_ -split '\s+')[-1] -like "*$serverName"}
    $serverHash=($serverLine -split '\s+')[0]
    if($serverHash -notmatch '^[a-f0-9]{64}$' -or $serverAsset.digest -ne "sha256:$serverHash"){throw 'CI 镜像和上传附件的 SHA256 不一致。'}
    $hashFile="release/backup/SHA256-Backup-$version.txt"
    $lines=@(foreach($file in $files){"$((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant())  $(Split-Path $file -Leaf)"})
    $lines+="$serverHash  $serverName"
    [IO.File]::WriteAllText((Join-Path $projectRoot $hashFile),($lines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
    $files+=$hashFile
    & $ghPath release upload $tag @files --repo $Repository
    if($LASTEXITCODE -ne 0){throw '附件上传未完成，请检查草稿。'}
    $releases=& $ghPath api "repos/$Repository/releases"
    if($LASTEXITCODE -ne 0){throw '无法检查上传结果。'}
    $release=($releases | ConvertFrom-Json) | Where-Object tag_name -eq $tag
    foreach($file in $files){$asset=$release.assets | Where-Object name -eq (Split-Path $file -Leaf);$hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();if(!$asset -or $asset.digest -ne "sha256:$hash" -or $asset.size -ne (Get-Item -LiteralPath $file).Length){throw '上传附件校验失败，未发布草稿。'}}
    & $ghPath release edit $tag --repo $Repository --draft=false --prerelease --latest=false
    if($LASTEXITCODE -ne 0){throw '发布未完成。'}
} finally {Pop-Location}
