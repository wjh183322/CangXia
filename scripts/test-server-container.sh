#!/usr/bin/env bash
set -euo pipefail
export CANGXIA_IMAGE=$1 CANGXIA_DEPLOYED_DIGEST=$2
seed=$(mktemp -d)
export CANGXIA_LIBRARY="$seed/library" CANGXIA_CONFIG="$seed/config" CANGXIA_REHEARSAL="$seed/rehearsal" CANGXIA_APPROVED="$seed/approved"
export CANGXIA_UID=$(id -u) CANGXIA_GID=$(id -g) CANGXIA_SOURCE_UID=42 CANGXIA_PORT=19443 CANGXIA_URL=https://127.0.0.1:19443
mkdir "$seed/project"
cp server/compose.yaml feasibility/nas-b/chromium-seccomp.json "$seed/project/"
compose=(docker compose --project-name "cangxia-smoke-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --project-directory "$seed/project" -f "$seed/project/compose.yaml")
trap '"${compose[@]}" down --timeout 5 >/dev/null 2>&1 || true; sudo rm -rf -- "$seed"' EXIT
for name in library config rehearsal empty old; do mkdir -m 700 "$seed/$name"; done
mkdir "$seed"/{library,config}/CREATE-NEW-CANGXIA
mkdir -p "$CANGXIA_APPROVED"/{sources,manifests,restores}
sudo chown -R "0:$CANGXIA_GID" "$CANGXIA_APPROVED"; sudo chmod -R 750 "$CANGXIA_APPROVED"
"${compose[@]}" config --quiet
up() {
  if ! "${compose[@]}" up -d --pull never --force-recreate --wait --wait-timeout 80; then "${compose[@]}" logs; return 1; fi
}
fixture=/opt/cangxia/tests/server-edition/compose-fixture.mjs
fixture_run() {
  "${compose[@]}" run --rm --no-deps -T -v "$PWD/tests/server-edition:/opt/cangxia/tests/server-edition:ro" --entrypoint node server "$fixture" "$1"
}
refuse() {
  local code=0
  timeout 40s "${compose[@]}" run --rm --no-deps -T server >"$seed/refusal" 2>&1 || code=$?
  cat "$seed/refusal"
  test "$code" = 1
}
up
node tests/server-edition/compose-fixture.mjs empty "$CANGXIA_LIBRARY" "$CANGXIA_CONFIG/identity"
"${compose[@]}" exec -T server node --input-type=module -e '
import fs from "node:fs";import assert from "node:assert/strict";
for(const path of ["/approved","/approved/sources","/approved/restores","/approved/manifests"])
 assert.throws(()=>fs.writeFileSync(path+"/forbidden","test"),e=>e.code==="EROFS"||e.code==="EACCES");
for(const path of ["/rehearsal/targets","/rehearsal/reports"]){fs.writeFileSync(path+"/probe","test");fs.unlinkSync(path+"/probe");}'
"${compose[@]}" down --timeout 20
fixture_run seed
up
node tests/server-edition/compose-fixture.mjs populated "$CANGXIA_LIBRARY" "$CANGXIA_CONFIG/identity"
before=$(sha256sum "$seed/config/identity/"*.json "$seed/config/identity/server.crt" "$seed/library/cangxia-server/identity.json")
up
node tests/server-edition/compose-fixture.mjs populated "$CANGXIA_LIBRARY" "$CANGXIA_CONFIG/identity"
test "$before" = "$(sha256sum "$seed/config/identity/"*.json "$seed/config/identity/server.crt" "$seed/library/cangxia-server/identity.json")"
"${compose[@]}" down --timeout 20
export CANGXIA_LIBRARY="$seed/empty"; refuse; test -z "$(ls -A "$seed/empty")"
export CANGXIA_LIBRARY="$seed/old"; fixture_run old
old_bytes=$(sha256sum "$seed/old/cangxia-server/library.sqlite" "$seed/old/cangxia-server/media/fixture.png")
refuse; grep -q migration-required "$seed/refusal"
test "$old_bytes" = "$(sha256sum "$seed/old/cangxia-server/library.sqlite" "$seed/old/cangxia-server/media/fixture.png")"
test -z "$(ls -A "$seed/old/cangxia-server/snapshots")"
fixture_run upgrade
export CANGXIA_LIBRARY="$seed/library"
# The browser/native tests run with synthetic inputs in a separate temporary library.
mkdir -m 700 "$seed/browser"
export CANGXIA_LIBRARY="$seed/browser"
# Reuse the existing library identity in this disposable test copy.
cp -a "$seed/library/cangxia-server" "$seed/browser/"
"${compose[@]}" run --rm --no-deps -T -v "$PWD/tests/server-edition:/opt/cangxia/tests/server-edition:ro" \
  -v "$PWD/electron/server-ipc.mjs:/opt/cangxia/electron/server-ipc.mjs:ro" -v "$PWD/node_modules:/opt/cangxia/node_modules:ro" \
  -e CANGXIA_TEST_COVER_PYTHON=/opt/cover-runtime/bin/python --entrypoint node server /opt/cangxia/tests/server-edition/container-smoke.mjs
"${compose[@]}" run --rm --no-deps -T -v "$PWD/tests/server-edition:/opt/cangxia/tests/server-edition:ro" \
  -v "$PWD/node_modules:/opt/cangxia/node_modules:ro" -e CANGXIA_TEST_COVER_PYTHON=/opt/cover-runtime/bin/python \
  --entrypoint node server /opt/cangxia/tests/server-edition/benchmark.mjs 50000
