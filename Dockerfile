# Chromium and every system lib it needs already live in this image, so the build never
# downloads a browser nor runs `playwright install --with-deps` — the two slowest steps,
# and the ones that hurt most in CI, where the arm64 build runs under QEMU emulation.
# Keep this tag pinned to the exact "playwright" version in package.json: the browsers
# baked in are the ones that release expects.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# The base image ships Node, not Bun. `bunx` is the same binary under another name.
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    TMP_DIR=/app/tmp \
    TERABOX_STORAGE_STATE=/app/secrets/storageState.json

# PostgreSQL client tools come from PGDG: the distro package lags behind the server
# major, and pg_dump refuses to dump a server newer than itself.
ARG POSTGRES_MAJOR=18
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg tzdata \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${POSTGRES_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# A bumped playwright package expects a Chromium revision this image does not carry, and
# the failure would otherwise surface at 3 a.m. in a cron run. Fail here instead.
RUN set -eu; \
    location="$(bunx playwright install chromium --dry-run | awk '/Install location/ { print $3; exit }')"; \
    test -d "$location" \
      || { echo "Missing $location: the playwright package and the base image tag drifted apart."; exit 1; }

COPY tsconfig.json biome.json ./
COPY types ./types
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/tmp /app/secrets

CMD ["bun", "run", "src/index.ts"]
