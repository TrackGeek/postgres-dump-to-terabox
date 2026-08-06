FROM oven/bun:1-debian

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
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

# Chromium is only the jsToken fallback, but a fallback that cannot start is not one.
RUN bunx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json biome.json ./
COPY types ./types
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/tmp /app/secrets

CMD ["bun", "run", "src/index.ts"]
