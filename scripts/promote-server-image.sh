#!/usr/bin/env bash
set -euo pipefail
repo=wjh183322/CangXia
registry=ghcr.io/wjh183322/cangxia-server
pkg=users/wjh183322/packages/container/cangxia-server
[[ "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF_TYPE" == tag && "$GITHUB_REPOSITORY" == "$repo" &&
   "$GITHUB_ACTOR" == wjh183322 && "$GITHUB_TRIGGERING_ACTOR" == wjh183322 ]]
if [[ "$GITHUB_REF_NAME" =~ ^server-candidate-(private|public)-([0-9]+)-([0-9a-f]{40})$ ]]; then
  action=candidate visibility=${BASH_REMATCH[1]} run=${BASH_REMATCH[2]} revision=${BASH_REMATCH[3]}
elif [[ "$GITHUB_REF_NAME" =~ ^server-stable-(private|public)-([0-9]+)-([0-9]+)-([0-9a-f]{64})-([0-9a-f]{40})$ ]]; then
  action=stable visibility=${BASH_REMATCH[1]} run=${BASH_REMATCH[2]} attempt=${BASH_REMATCH[3]} approved="sha256:${BASH_REMATCH[4]}" revision=${BASH_REMATCH[5]}
else echo 'Approval ref has an invalid scope, run, manifest or source.' >&2; exit 1; fi
[[ "$(git rev-parse HEAD)" == "$revision" && "$GITHUB_SHA" == "$revision" ]]
if [[ "$action" == candidate ]]; then
  info=$(gh api "repos/$repo/actions/runs/$run")
  jq -e --arg sha "$revision" --arg repo "$repo" '
   .event=="push" and .conclusion=="success" and .head_sha==$sha and .head_repository.full_name==$repo and
   .head_branch=="codex/server-edition-full" and .path==".github/workflows/server-edition-full.yml"' <<< "$info" >/dev/null
else
  # Commit statuses outlive Actions artifacts/logs. The workflow identity, source,
  # exact candidate run/attempt, distribution scope and registry manifest must all match.
  gh api --paginate --slurp "repos/$repo/commits/$revision/statuses?per_page=100" | jq -e \
   --arg context "cangxia-server/candidate/$run/$attempt/$visibility" --arg d "$approved" \
   --arg url "$GITHUB_SERVER_URL/$repo/actions/runs/$run" '
     [ .[][] | select(.context==$context) ][0] |
     .state=="success" and .description==$d and .target_url==$url and .creator.login=="github-actions[bot]"' >/dev/null
fi
if [[ "$1" == authorize ]]; then
  printf 'action=%s\nvisibility=%s\n' "$action" "$visibility" >> "$GITHUB_OUTPUT"; exit
fi
[[ "$1" == publish ]]
if ! command -v skopeo >/dev/null; then
  apt_sources=(-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-)
  sudo apt-get "${apt_sources[@]}" update
  sudo apt-get "${apt_sources[@]}" install -y skopeo
fi
echo "$GH_TOKEN" | skopeo login -u wjh183322 --password-stdin ghcr.io >/dev/null
version=0.4.1
root=release/server-linux
mkdir -p "$root"
raw_digest() { skopeo inspect --raw "$1" | sha256sum | awk '{print "sha256:"$1}'; }
check() {
  test "$(raw_digest "$1")" = "$digest"
  test "$(skopeo inspect --raw "$1" | jq -er .config.digest)" = "$config"
  skopeo inspect --config "$1" | jq -e --arg sha "$revision" --arg v "$version" '
   .architecture=="amd64" and .os=="linux" and .config.User=="1000:1000" and
   .config.Labels["org.opencontainers.image.source"]=="https://github.com/wjh183322/CangXia" and
   .config.Labels["org.opencontainers.image.revision"]==$sha and .config.Labels["org.opencontainers.image.version"]==$v' >/dev/null
}
check_visibility() {
  gh api "$pkg" | jq -e --arg v "$visibility" '.visibility==$v and .owner.login=="wjh183322" and .name=="cangxia-server"' >/dev/null
}
if [[ "$action" == candidate ]]; then
  metadata="$root/candidate.json"
  jq -e --arg s "$revision" --arg r "$GITHUB_RUN_ID" --arg a "$GITHUB_RUN_ATTEMPT" '
   .version=="0.4.1" and .protocolVersion==1 and .sourceRevision==$s and .run==$r and .attempt==$a' "$metadata" >/dev/null
  tag="$version-rc.$GITHUB_RUN_ID.$GITHUB_RUN_ATTEMPT"
  digest=$(jq -er '.digest|select(test("^sha256:[0-9a-f]{64}$"))' "$metadata")
  config=$(jq -er '.configDigest|select(test("^sha256:[0-9a-f]{64}$"))' "$metadata")
else
  tag="$version-rc.$run.$attempt"
  digest=$approved
  config=$(skopeo inspect --raw "docker://$registry@$digest" | jq -er '.config.digest|select(test("^sha256:[0-9a-f]{64}$"))')
fi
if [[ "$action" == candidate ]]; then
  archive="dir:$root/image"
  check "$archive"
  # A new package has no visibility to inspect. Seed only an empty scratch image,
  # never candidate bytes, then require the requested visibility from the API.
  code=$(curl -sS -o "$RUNNER_TEMP/package.json" -w '%{http_code}' -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/$pkg")
  if [[ "$code" == 404 ]]; then
    mkdir "$RUNNER_TEMP/visibility-bootstrap"
    printf 'FROM scratch\nLABEL purpose="package-visibility-verification"\n' > "$RUNNER_TEMP/visibility-bootstrap/Dockerfile"
    docker build -t cangxia-empty:visibility "$RUNNER_TEMP/visibility-bootstrap"
    skopeo copy docker-daemon:cangxia-empty:visibility "docker://$registry:visibility-bootstrap-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  else [[ "$code" == 200 ]]; fi
  check_visibility
  tags=$(skopeo list-tags "docker://$registry")
  if jq -e --arg t "$tag" '(.Tags // [])|index($t)!=null' <<< "$tags" >/dev/null; then
    check "docker://$registry:$tag"
  else skopeo copy --preserve-digests "$archive" "docker://$registry:$tag"; fi
  check "docker://$registry:$tag"
else
  check_visibility
  check "docker://$registry:$tag"
  check "docker://$registry@$digest"
  tags=$(skopeo list-tags "docker://$registry")
  if jq -e --arg v "$version" '(.Tags // [])|index($v)!=null' <<< "$tags" >/dev/null; then
    check "docker://$registry:$version"
  else skopeo copy --preserve-digests "docker://$registry@$digest" "docker://$registry:$version"; fi
  check "docker://$registry:$version"
  check_visibility
  skopeo copy --preserve-digests "docker://$registry@$digest" "docker://$registry:latest"
  check "docker://$registry:latest"
fi
check_visibility
jq -n --arg s "$revision" --arg v "$visibility" --arg d "$digest" --arg c "$config" --arg t "$tag" --arg action "$action" \
 --arg r "$GITHUB_RUN_ID" --arg a "$GITHUB_RUN_ATTEMPT" '{version:"0.4.1",protocolVersion:1,sourceRevision:$s,visibility:$v,digest:$d,configDigest:$c,tag:$t,action:$action,run:$r,attempt:$a}' > "$root/receipt.json"

printf 'receipt=%s\n' "$(jq -c . "$root/receipt.json")" >> "$GITHUB_OUTPUT"
