
# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9

ARG TARGETARCH
ARG PROBE_REVISION
ARG PROBE_VERSION
LABEL org.opencontainers.image.source="https://github.com/wjh183322/CangXia" \
      org.opencontainers.image.revision="$PROBE_REVISION" \
      org.opencontainers.image.version="$PROBE_VERSION" \
      org.opencontainers.image.base.name="mcr.microsoft.com/playwright:v1.65.1-noble" \
      org.opencontainers.image.base.digest="sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9"

COPY feasibility/nas-b/cover-runtime.lock /opt/cangxia/feasibility/nas-b/cover-runtime.lock
RUN set -eux; \
    test "$TARGETARCH" = amd64; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg openssl python3.12-venv xvfb; \
    rm -rf /var/lib/apt/lists/*; \
    python3.12 -m venv /opt/cover-runtime; \
    /opt/cover-runtime/bin/python -m pip install --no-cache-dir --disable-pip-version-check \
        --only-binary=:all: --require-hashes -r /opt/cangxia/feasibility/nas-b/cover-runtime.lock; \
    /opt/cover-runtime/bin/python -m pip check; \
    ffmpeg -version >/dev/null; \
    ffprobe -version >/dev/null; \
    openssl version >/dev/null; \
    command -v Xvfb

ENV PATH="/opt/cover-runtime/bin:$PATH" \
    PLAYWRIGHT_BROWSERS_PATH="/ms-playwright" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1
WORKDIR /opt/cangxia/feasibility/nas-b

COPY feasibility/nas-b/package.json feasibility/nas-b/package-lock.json ./
RUN set -eux; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    rm -rf /root/.npm; \
    node --input-type=module -e 'import assert from "node:assert/strict"; import { DatabaseSync } from "node:sqlite"; import { accessSync, constants } from "node:fs"; import { chromium } from "playwright-core"; assert.ok(Number(process.versions.node.split(".")[0]) >= 24); const db = new DatabaseSync(":memory:"); assert.equal(db.prepare("SELECT 1 AS ready").get().ready, 1); db.close(); accessSync(chromium.executablePath(), constants.X_OK);'

COPY electron/ /opt/cangxia/electron/
COPY shared/ /opt/cangxia/shared/
COPY scripts/cover-frame.py /opt/cangxia/scripts/cover-frame.py
COPY feasibility/nas-b/src/ ./src/
COPY feasibility/nas-b/web/ ./web/
COPY feasibility/nas-b/scripts/container-start.mjs feasibility/nas-b/scripts/health.mjs ./scripts/
COPY --chmod=0555 feasibility/nas-b/nas-entrypoint.sh ./
RUN mkdir /probe

USER 1000:1000
RUN --mount=type=bind,source=tests/cover-frame-test.py,target=/opt/cangxia/scripts/cover-frame-test.py \
    --network=none set -eux; \
    python /opt/cangxia/scripts/cover-frame-test.py; \
    fixture="$(mktemp --suffix=.mp4)"; \
    trap 'rm -f "$fixture"' EXIT; \
    ffmpeg -v error -y -f lavfi -i testsrc2=size=96x54:rate=10 -frames:v 2 -c:v libx264 -pix_fmt yuv420p "$fixture"; \
    test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$fixture")" = h264; \
    python -c 'import cv2, sys; cap = cv2.VideoCapture(sys.argv[1], cv2.CAP_FFMPEG); ok, frame = cap.read(); cap.release(); assert ok and frame.shape == (54, 96, 3)' "$fixture"

EXPOSE 8443
HEALTHCHECK --interval=10s --timeout=5s --start-period=35s --retries=3 \
    CMD ["node", "/opt/cangxia/feasibility/nas-b/scripts/health.mjs"]
ENTRYPOINT ["/opt/cangxia/feasibility/nas-b/nas-entrypoint.sh"]
