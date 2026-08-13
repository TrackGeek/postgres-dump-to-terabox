# No browser lives in this image: the pipeline talks to Terabox over plain fetch, and
# the one step that needs a real browser (`bun run login`) runs on a workstation and
# leaves nothing behind but secrets/storageState.json.
FROM oven/bun:1-slim

ENV DEBIAN_FRONTEND=noninteractive \
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
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --production drops playwright (a devDependency, for the login script only) along with
# the rest of the toolchain.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY types ./types
COPY src ./src

RUN mkdir -p /app/tmp /app/secrets

CMD ["bun", "run", "src/index.ts"]
