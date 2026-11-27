#!/usr/bin/env bash
set -euo pipefail
image=$1
seed=$(mktemp -d)
container="server-candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf -- "$seed"' EXIT
for name in library config rehearsal empty; do mkdir -m 700 "$seed/$name"; done
mkdir "$seed"/{library,config}/CREATE-NEW-CANGXIA
flags=(--init --read-only --user "$(id -u):$(id -g)" --cap-drop ALL --network none
  --security-opt no-new-privileges:true --security-opt "seccomp=$PWD/feasibility/nas-b/chromium-seccomp.json"
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --shm-size 512m
  -v "$seed/config:/config" -v "$seed/rehearsal:/rehearsal" -e CANGXIA_URL=https://127.0.0.1:9443 -e CANGXIA_REHEARSAL_ROOT=/rehearsal)
start() {
  docker run -d --name "$container" "${flags[@]}" -v "$seed/library:/library" "$image"
  for i in $(seq 1 45); do
    if docker exec "$container" node /opt/cangxia/server/health.mjs >/dev/null 2>&1; then return; fi
    sleep 1
  done
  docker logs "$container"; return 1
}
start
docker exec "$container" node --input-type=module -e '
import assert from "node:assert/strict";import fs from "node:fs";import {ServerClient} from "./electron/server-client.mjs";
const read=n=>JSON.parse(fs.readFileSync("/config/identity/windows-"+n+".json"));
const a=new ServerClient(),b=new ServerClient();
await a.connect(read(1));await a.acquire();assert.equal((await a.query("list-works",{source:"total"})).total,0);
await b.connect(read(2));await assert.rejects(b.acquire());await a.release();await b.acquire();await b.release();'
before=$(sha256sum "$seed/config/identity/"*.json "$seed/config/identity/server.crt" "$seed/library/cangxia-server/identity.json")
docker stop -t 20 "$container"; docker rm "$container"; start
after=$(sha256sum "$seed/config/identity/"*.json "$seed/config/identity/server.crt" "$seed/library/cangxia-server/identity.json")
test "$before" = "$after"
docker stop -t 20 "$container"; docker rm "$container"
if docker run --rm "${flags[@]}" -v "$seed/empty:/library" "$image"; then exit 1; fi
test -z "$(ls -A "$seed/empty")"
cp -a "$seed/library" "$seed/future"
docker run --rm "${flags[@]}" -v "$seed/future:/library" --entrypoint node "$image" --input-type=module -e '
import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync("/library/cangxia-server/library.sqlite");db.exec("PRAGMA user_version=999");db.close();'
before=$(sha256sum "$seed/future/cangxia-server/library.sqlite")
if docker run --rm "${flags[@]}" -v "$seed/future:/library" "$image"; then exit 1; fi
test "$before" = "$(sha256sum "$seed/future/cangxia-server/library.sqlite")"
# All mounted tests and fixture dependencies are outside the image and synthetic.
docker run --rm "${flags[@]}" -v "$seed/library:/library" -v "$PWD/tests/server-edition:/opt/cangxia/tests/server-edition:ro" \
  -v "$PWD/electron/server-ipc.mjs:/opt/cangxia/electron/server-ipc.mjs:ro" -v "$PWD/node_modules:/opt/cangxia/node_modules:ro" \
  -e CANGXIA_TEST_COVER_PYTHON=/opt/cover-runtime/bin/python --entrypoint node "$image" /opt/cangxia/tests/server-edition/container-smoke.mjs
docker run --rm "${flags[@]}" -v "$seed/library:/library" -v "$PWD/tests/server-edition:/opt/cangxia/tests/server-edition:ro" \
  -v "$PWD/node_modules:/opt/cangxia/node_modules:ro" -e CANGXIA_TEST_COVER_PYTHON=/opt/cover-runtime/bin/python \
  --entrypoint node "$image" /opt/cangxia/tests/server-edition/benchmark.mjs 50000
