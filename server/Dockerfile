# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS node-runtime
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9
ARG TARGETARCH
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/wjh183322/CangXia" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.version="0.4.1" \
      org.opencontainers.image.base.digest="sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9"
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV PATH="/opt/cover-runtime/bin:/usr/local/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="/ms-playwright" PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 HOME=/tmp
WORKDIR /opt/cangxia
COPY feasibility/nas-b/cover-runtime.lock /opt/cangxia/cover-runtime.lock
RUN set -eu; test "$TARGETARCH" = amd64; test "$(node -v)" = v24.21.0; \
    apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=- update; \
    apt-get -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=- install -y --no-install-recommends ffmpeg openssl python3.12-venv xvfb; \
    rm -rf /var/lib/apt/lists/*; if [ -d /root/.ssh ]; then rmdir /root/.ssh; fi; \
    python3.12 -m venv /opt/cover-runtime; \
    python -m pip install --no-cache-dir --disable-pip-version-check --only-binary=:all: --require-hashes -r cover-runtime.lock; \
    python -m pip check
COPY server/package*.json ./server/
RUN npm ci --prefix server --ignore-scripts --omit=dev --no-audit --no-fund && rm -rf /tmp/.npm /root/.npm
COPY package.json .
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY electron/ ./electron/
COPY shared/ ./shared/
RUN node --input-type=module <<'JS'
import {writeFileSync,accessSync,constants} from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {validateBuild} from './server/build-info.mjs';
const require=createRequire(new URL('./server/package.json',import.meta.url));
accessSync(require('playwright-core').chromium.executablePath(),constants.X_OK);
new DatabaseSync(':memory:').close();
writeFileSync('build-info.json',JSON.stringify(validateBuild(process.env.SOURCE_REVISION))+'\n',{flag:'wx',mode:0o444});
JS
USER 1000:1000
RUN --mount=type=bind,source=tests/cover-frame-test.py,target=/opt/cangxia/tests/cover-frame-test.py --network=none \
    python /opt/cangxia/tests/cover-frame-test.py && ffmpeg -version >/dev/null && ffprobe -version >/dev/null && command -v Xvfb
EXPOSE 9443
HEALTHCHECK --interval=12s --timeout=5s --start-period=30s CMD ["node","/opt/cangxia/server/health.mjs"]
ENTRYPOINT ["node","/opt/cangxia/server/deployment.mjs"]
