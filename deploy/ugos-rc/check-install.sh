#!/usr/bin/env bash
set -euo pipefail
archive="$RUNNER_TEMP/kit.zip"
python3 deploy/ugos-rc/package.py 127.0.0.1 "$archive"
unzip -q "$archive" -d "$RUNNER_TEMP/ugos-check"
cd "$RUNNER_TEMP/ugos-check/cangxia-server"
docker compose config --quiet
trap 'docker compose ps -a; docker compose logs --tail 10; docker compose down' EXIT

# An existing operator file must survive, and the initialization ticket stays unused.
mkdir library
echo untouched > library/sentinel
if docker compose run --rm --no-deps prepare; then exit 1; fi
test "$(cat library/sentinel)" = untouched
test -f install/first-install
rm library/sentinel
# Exercise the supported update from the first public candidate with its own
# database, certificate and device identity already on disk.
previous='ghcr.io/wjh183322/cangxia-server@sha256:aedc12ea59861c7d36b10686719cff2c0fe05df8ca5b595814469bd43642e4a4'
printf 'services:\n  prepare:\n    image: %s\n  server:\n    image: %s\n' "$previous" "$previous" > previous.yaml
docker compose -f compose.yaml -f previous.yaml up -d --wait --wait-timeout 180
test "$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q server)")" = "$previous"
test "$(docker inspect --format '{{.State.ExitCode}}' "$(docker compose ps -aq prepare)")" = 0
test "$(docker compose exec -T server id -u)" = 1000
pin=$(sudo openssl x509 -in config/identity/server.crt -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)
test "$(curl --silent --insecure --pinnedpubkey "sha256//$pin" -o /dev/null -w '%{http_code}' https://127.0.0.1:24448/)" = 401
docker compose exec -T server node /opt/cangxia/server/health.mjs
sudo test -d approved/manifests
test "$(stat -c %u:%a library)" = '1000:700'
test "$(stat -c %u:%a approved)" = '0:750'
if docker compose exec -T server touch /approved/unapproved; then exit 1; fi
before=$(sudo sha256sum config/identity/library-id config/identity/server.crt config/identity/windows-1.json)
docker compose down
docker compose up -d --wait --wait-timeout 180
test "$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q server)")" = "$(docker compose config --images | head -n1)"
test "$before" = "$(sudo sha256sum config/identity/library-id config/identity/server.crt config/identity/windows-1.json)"
docker compose exec -T server node /opt/cangxia/server/health.mjs
echo 'UGOS_KIT_CHECK_PASSED'
