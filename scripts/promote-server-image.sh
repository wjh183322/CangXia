#!/usr/bin/env bash
# Run interactively on an owner-controlled Linux workstation, never in build CI.
set -euo pipefail
repo=wjh183322/CangXia
registry=ghcr.io/wjh183322/cangxia-server
[[ $# == 3 && -t 0 ]] || { echo 'Usage: promote-server-image.sh candidate|stable SUCCESSFUL_RUN_ID FULL_REVISION (interactive terminal required)'; exit 2; }
action=$1 run=$2 revision=$3
[[ "$action" == candidate || "$action" == stable ]]
[[ "$run" =~ ^[0-9]+$ && "$revision" =~ ^[0-9a-f]{40}$ ]]
[[ "$(gh api user --jq .login)" == wjh183322 ]]
runInfo=$(gh api "repos/$repo/actions/runs/$run")
jq -e --arg sha "$revision" --arg repo "$repo" '
  .conclusion=="success" and .head_branch=="codex/server-edition-full" and .head_sha==$sha and
  .head_repository.full_name==$repo and .path==".github/workflows/server-edition-full.yml"
' <<< "$runInfo" >/dev/null
work=$(mktemp -d); trap 'rm -rf -- "$work"' EXIT
gh run download "$run" --repo "$repo" --name "server-linux-$revision" --dir "$work"
cd "$work"
sha256sum -c SHA256SUMS
version=$(jq -er '.version | select(.=="0.4.1")' candidate.json)
attempt=$(jq -er .run_attempt <<< "$runInfo")
jq -e --arg sha "$revision" --arg id "$run" --arg a "$attempt" '.sourceRevision==$sha and .run==$id and .attempt==$a and .protocolVersion==1' candidate.json >/dev/null
tag="$version-rc.$run.$attempt"
digest=$(jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' candidate.json)
raw_digest() { skopeo inspect --raw "$1" | sha256sum | awk '{print "sha256:"$1}'; }
check() {
  test "$(raw_digest "$1")" = "$digest"
  skopeo inspect --config "$1" | jq -e --arg sha "$revision" --arg v "$version" '
    .architecture=="amd64" and .os=="linux" and .config.User=="1000:1000" and
    .config.Labels["org.opencontainers.image.source"]=="https://github.com/wjh183322/CangXia" and
    .config.Labels["org.opencontainers.image.revision"]==$sha and .config.Labels["org.opencontainers.image.version"]==$v' >/dev/null
}
check oci-archive:image.tar
# Authentication and network failures cannot be treated as proof that a tag is unused.
tags=$(skopeo list-tags "docker://$registry" 2>registry-error) || {
  if grep -Eiq 'NAME_UNKNOWN|name unknown' registry-error; then tags='{"Tags":[]}'; else cat registry-error >&2; exit 1; fi
}
exists() { jq -e --arg tag "$1" '(.Tags // []) | index($tag)!=null' <<< "$tags" >/dev/null; }
if [[ "$action" == candidate ]]; then
  target="$tag"
  if exists "$tag"; then check "docker://$registry:$tag"; echo 'Matching candidate already exists.'; exit 0; fi
else
  check "docker://$registry:$tag"
  if exists "$version"; then check "docker://$registry:$version"; fi
  old=absent; if exists latest; then old=$(raw_digest "docker://$registry:latest"); fi
  target="$version and latest (previous $old)"
fi
printf '%s\n' "Repository: $registry" "Targets: $target" "Source: $revision" "Manifest: $digest"
printf 'Type exactly: %s %s %s\n' "$action" "$revision" "$digest"
IFS= read -r confirmation
[[ "$confirmation" == "$action $revision $digest" ]]
if [[ "$action" == candidate ]]; then
  skopeo copy --preserve-digests oci-archive:image.tar "docker://$registry:$tag"
  check "docker://$registry:$tag"
else
  check "docker://$registry@$digest"
  skopeo copy --preserve-digests "docker://$registry@$digest" "docker://$registry:$version"
  check "docker://$registry:$version"
  skopeo copy --preserve-digests "docker://$registry@$digest" "docker://$registry:latest"
  check "docker://$registry:latest"
fi
