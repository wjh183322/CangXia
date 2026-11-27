#!/usr/bin/env bash
set -euo pipefail
echo '::group::Build runtime and run OpenCV golden'
docker buildx build --platform linux/amd64 --load --provenance=false --sbom=false \
  --build-arg "SOURCE_REVISION=$GITHUB_SHA" -f server/Dockerfile -t "$IMAGE" .
echo '::endgroup::'
echo '::group::Inspect merged filesystem and every post-base layer'
set -euo pipefail
base=$(node --input-type=module -e "import {BASE_IMAGE} from './feasibility/nas-b/scripts/image-inputs.mjs'; console.log(BASE_IMAGE)")
docker pull --platform linux/amd64 "$base"
c=$(docker create "$IMAGE"); trap 'docker rm "$c" >/dev/null' EXIT
docker export "$c" | tar -tf - > "$RUNNER_TEMP/paths"
n=$(node scripts/audit-server-image.mjs "$IMAGE" "$GITHUB_SHA" "$RUNNER_TEMP/paths")
docker image inspect "$IMAGE" > "$RUNNER_TEMP/inspect.json"
docker save "$IMAGE" -o "$RUNNER_TEMP/content.tar"
python3 -B feasibility/nas-b/scripts/audit_image_layers.py "$RUNNER_TEMP/content.tar" "$RUNNER_TEMP/inspect.json" "$IMAGE" "$n"
rm -- "$RUNNER_TEMP/content.tar"
echo '::endgroup::'
echo '::group::Test disposable installation, two credentials, update, Chromium and native media'
bash scripts/test-server-container.sh "$IMAGE"
echo '::endgroup::'
echo '::group::Seal tested image and deployment files'
set -euo pipefail
if ! command -v skopeo >/dev/null; then sudo apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=- update && sudo apt-get install -y skopeo; fi
mkdir -p release/server-linux
cd release/server-linux
skopeo copy --format oci "docker-daemon:$IMAGE" oci-archive:image.tar
config=$(skopeo inspect --raw oci-archive:image.tar | jq -er .config.digest)
test "$config" = "$(docker image inspect --format '{{.Id}}' "$IMAGE")"
digest="sha256:$(skopeo inspect --raw oci-archive:image.tar | sha256sum | cut -d' ' -f1)"
jq -n --arg revision "$GITHUB_SHA" --arg digest "$digest" --arg config "$config" \
  --arg run "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" \
  '{sourceRevision:$revision,version:"0.4.1",protocolVersion:1,digest:$digest,configDigest:$config,run:$run,attempt:$attempt}' > candidate.json
cp ../../server/compose.yaml ../../feasibility/nas-b/chromium-seccomp.{json,LICENSE} ../../docs/server-edition/{release-acceptance,migration-rehearsal}.md .
sha256sum image.tar compose.yaml chromium-seccomp.json > SHA256SUMS
echo '::endgroup::'
