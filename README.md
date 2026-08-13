<p align="center">
  <img src="https://github.com/TrackGeek.png" height="100px">
</p>

<h1 align="center">
  <samp>Postgres Dump To Terabox</samp>
</h1>

<h4 align="center">
  <samp>Automated PostgreSQL backups to Terabox, with 7-day retention and Discord notifications at every stage.</samp>
</h4>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-99e3a0?style=for-the-badge&logo=bun&logoColor=004b38">
  <img src="https://img.shields.io/badge/TypeScript-99e3a0?style=for-the-badge&logo=typescript&logoColor=004b38">
  <img src="https://img.shields.io/badge/PostgreSQL-99e3a0?style=for-the-badge&logo=postgresql&logoColor=004b38">
  <img src="https://img.shields.io/badge/Docker-99e3a0?style=for-the-badge&logo=docker&logoColor=004b38">
  <br>
  <img src="https://img.shields.io/badge/Playwright-99e3a0?style=for-the-badge&logo=playwright&logoColor=004b38">
  <img src="https://img.shields.io/badge/node--cron-99e3a0?style=for-the-badge&logo=nodedotjs&logoColor=004b38">
  <img src="https://img.shields.io/badge/Discord-99e3a0?style=for-the-badge&logo=discord&logoColor=004b38">
  <img src="https://img.shields.io/badge/Biome-99e3a0?style=for-the-badge&logo=biome&logoColor=004b38">
</p>

## <samp>About</samp>

<samp>

Scheduled backup job for the [TrackGeek API](https://github.com/TrackGeek/api) database. Every 12 hours it dumps PostgreSQL, uploads the dump to Terabox in 4 MiB chunks, deletes backups older than 7 days, and reports every stage to a Discord webhook.

It runs as a long-lived container with its own cron scheduler — no host crontab, no external orchestrator. The image ships the PostgreSQL client tools and the Playwright Chromium, so it does not depend on anything installed on the host.

</samp>

## <samp>How It Works</samp>

<samp>

```
cron (0 */12 * * *)
  └─ lock  ──> auth (storageState → ndus + jsToken)
              └─ pg_dump -Fc  ──> chunked upload (4 MiB blocks)
                                   └─ retention (> 7 days)  ──> Discord ✅
```

- **Dump**: `pg_dump --format=custom`, already compressed and restorable with `pg_restore`.
- **Upload**: custom 4 MiB chunked implementation (`precreate` → `superfile2` → `create`). The `uploadFile` helper from `terabox-upload-tool` is not used: it loads the whole file into RAM and sends a single block (`partseq=0`), which corrupts any file above 4 MiB. Only `fetchFileList` and `deleteFiles` come from the library.
- **Token**: the `ndus` cookie comes from a `storageState.json` saved by a manual login. The `jsToken` comes from a `fetch` of the `/main` page with that cookie; Playwright only starts up (headless, rehydrating the same `storageState`) when the HTML format changes. There is never an automated login, so there is never a CAPTCHA.
- **Retention**: the date comes from the timestamp in the file name (`trackgeek-YYYYMMDD-HHmmss.dump`), with `server_mtime` as a fallback. Files that do not match the prefix are ignored.

</samp>

## <samp>Features</samp>

<samp>

**Backup**
- `pg_dump --format=custom` dumps, named `trackgeek-YYYYMMDD-HHmmss.dump`;
- Built-in cron scheduler with an optional run on boot;
- File lock preventing concurrent runs;
- One-off runs via `--once`, without touching the schedule.

**Upload**
- Custom chunked upload in 4 MiB blocks (`precreate` → `superfile2` → `create`);
- Streams from disk instead of buffering the dump in memory;
- Remote directory created on demand.

**Session**
- `ndus` cookie read from a `storageState.json` written by a one-time manual login;
- `jsToken` scraped from the `/main` page over plain `fetch`;
- Headless Playwright only as a fallback when the page HTML changes;
- No automated login, therefore no CAPTCHA.

**Retention**
- Age derived from the timestamp in the file name, `server_mtime` as fallback;
- Files outside the configured prefix are never touched;
- `DRY_RUN` lists what would be deleted without deleting anything.

**Notifications**
- Discord embeds for every stage: started, auth, dumped, uploaded, cleaned, and failures;
- Dump size, duration, and remote path reported per run;
- Private deep link to the backup folder on Terabox;
- Explicit "run `bun run login`" warning when the session expires.

**Safety**
- Cleanup aborts if the freshly uploaded backup is missing from the remote listing;
- Cleanup aborts if it would leave zero backups behind;
- `DATABASE_URL` is never logged, and the `jsToken` is truncated in notifications;
- Share links are never created.

</samp>

## <samp>Tech Stack</samp>

<samp>

| Category           | Technology                                     |
|--------------------|------------------------------------------------|
| Runtime            | Bun                                            |
| Language           | TypeScript 5.7                                 |
| Database Tools     | PostgreSQL 18 client (pg_dump / pg_restore)    |
| Scheduler          | node-cron 4                                    |
| Browser Automation | Playwright 1.59 (Chromium)                     |
| Remote Storage     | Terabox (terabox-upload-tool)                  |
| Notifications      | Discord Webhooks                               |
| Linting            | Biome                                          |
| Containerization   | Docker Compose                                 |

</samp>

## <samp>Project Structure</samp>

<samp>

```
src/
├── index.ts                # Entry point: cron scheduler, --once mode, graceful shutdown
├── pipeline.ts             # Backup pipeline: dump → upload → retention → notify
├── config.ts               # Environment parsing and validation
├── lock.ts                 # File lock preventing concurrent runs
├── logger.ts               # Structured logger and byte/duration formatters
├── database/
│   └── dump.ts             # pg_dump wrapper (custom format) and file name parsing
├── notify/
│   └── discord.ts          # Discord webhook embeds per stage
└── terabox/
    ├── auth.ts             # ndus cookie + jsToken (with Playwright fallback)
    ├── client.ts           # Chunked upload, file listing, deletion
    └── constants.ts        # Endpoints and shared errors
scripts/
└── login.ts                # One-time manual login, saves storageState.json
```

</samp>

## <samp>Run Locally</samp>

<samp>

**Prerequisites:** Docker and Docker Compose. Bun and Chromium are only needed on the host for the one-time Terabox login.

Clone the project

```bash
git clone https://github.com/TrackGeek/postgres-dump-to-terabox.git
```

Go to the project directory

```bash
cd postgres-dump-to-terabox
```

Copy the environment file and fill in the required variables

```bash
cp .env.example .env
```

Build the image

```bash
docker compose build
```

Start the daemon

```bash
docker compose up -d
```

Only `DATABASE_URL` is required — everything else falls back to the defaults listed below. Without `DISCORD_WEBHOOK_URL` the stages only go to the log.

Under Docker, `TMP_DIR` and `TERABOX_STORAGE_STATE` are set by `docker-compose.yaml` and must stay **out** of the `.env`.

If the database runs on the host (dev), use `host.docker.internal` instead of `localhost` — `docker-compose.yaml` already maps that host:

```dotenv
DATABASE_URL='postgres://postgres:postgres@host.docker.internal:20141/trackgeek'
```

</samp>

## <samp>Terabox Login</samp>

<samp>

Run once, on the host:

```bash
bun install
bunx playwright install chromium
bun run login
```

It opens a **visible** Chromium. Log in normally (CAPTCHA included). As soon as the `ndus` cookie shows up, the session is written to `secrets/storageState.json` with `600` permissions and the browser closes itself.

This is the only step that needs a screen, so it stays on the host. The container mounts `./secrets` as **read-only** and merely consumes the session.

Repeat it only when the session expires — the job reports it on Discord with a "run `bun run login` on the server" message when that happens.

</samp>

## <samp>Usage</samp>

<samp>

```bash
docker compose up -d                          # daemon: cron 0 */12 * * * + run on boot
docker compose logs -f                        # follow
docker compose run --rm backup bun run once   # single run, then exit
```

With `DRY_RUN=true` the dump and the upload happen normally, but the cleanup only **lists** what it would delete.

**PostgreSQL version**

`pg_dump` refuses to dump a server **newer** than itself. The image installs the PGDG client, pinned by a build arg in `docker-compose.yaml`:

```yaml
build:
  args:
    POSTGRES_MAJOR: 18
```

If the server moves to a new major, change the number and run `docker compose build`. Older servers keep working — a newer client dumps previous versions fine.

**Without Docker (optional)**

```bash
bun install && bunx playwright install chromium
bun run start   # daemon
bun run once    # single run
```

Here `pg_dump` comes from the host and must be >= the server. If the one on `PATH` is too old, point at another without touching the system:

```dotenv
PG_DUMP_BIN='/opt/homebrew/opt/postgresql@18/bin/pg_dump'
```

</samp>

## <samp>Restoring a Backup</samp>

<samp>

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname='postgres://user:password@host:5432/trackgeek' \
  trackgeek-20260805-030000.dump
```

Without the right `pg_restore` version on the host, use the image itself:

```bash
docker compose run --rm -v "$PWD:/restore" backup \
  pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$DATABASE_URL" /restore/trackgeek-20260805-030000.dump
```

To only check the integrity of the file: `pg_restore --list file.dump`.

</samp>

## <samp>Scripts</samp>

<samp>

| Script            | Description                                      |
|-------------------|--------------------------------------------------|
| `bun start`       | Start the daemon (cron scheduler)                |
| `bun once`        | Run a single backup and exit                     |
| `bun run login`   | Open a visible Chromium to save the Terabox session |
| `bun types`       | Type check with TypeScript                       |
| `bun lint`        | Run Biome linter                                 |
| `bun lint:fix`    | Run Biome linter and apply fixes                 |
| `bun check`       | Run Biome checks                                 |
| `bun check:fix`   | Run Biome checks and apply fixes                 |
| `bun format`      | Check formatting with Biome                      |
| `bun format:fix`  | Format code with Biome                           |

</samp>

## <samp>Environment Variables</samp>

<samp>

| Variable                | Description                                                       |
|-------------------------|-------------------------------------------------------------------|
| `DATABASE_URL`          | PostgreSQL connection string (**required**)                       |
| `DISCORD_WEBHOOK_URL`   | Discord webhook for stage notifications (log only when unset)     |
| `TERABOX_APP_ID`        | Terabox app id (default: `250528`)                                |
| `TERABOX_REMOTE_DIR`    | Remote backup folder (default: `/trackgeek-backups`)              |
| `TERABOX_STORAGE_STATE` | Saved session path (default: `./secrets/storageState.json`)       |
| `BACKUP_PREFIX`         | Dump file name prefix (default: `trackgeek`)                      |
| `RETENTION_DAYS`        | Days to keep remote backups (default: `7`)                        |
| `CRON_SCHEDULE`         | Scheduler expression (default: `0 */12 * * *`)                    |
| `RUN_ON_BOOT`           | Run once right after startup (default: `true`)                    |
| `DRY_RUN`               | List expired backups instead of deleting them (default: `false`)  |
| `TMP_DIR`               | Local directory for dumps and the lock (default: `./tmp`)         |
| `PG_DUMP_BIN`           | Path to the `pg_dump` binary (default: `pg_dump`)                 |
| `TZ`                    | Scheduler timezone (default: `America/Sao_Paulo`)                 |

</samp>

## <samp>Security</samp>

<samp>

The cleanup is aborted (with a Discord warning, deleting nothing) when:

- the freshly uploaded backup does not show up in the remote listing — a sign of a broken session or an incomplete listing;
- the deletion would leave **zero** backups behind.

No stage logs the `DATABASE_URL` (it only travels in the `pg_dump` argv), and the `jsToken` is truncated in notifications.

The `uploaded` and `finished` embeds carry a clickable link to the backup folder on Terabox:

```
https://www.1024terabox.com/main?category=all&path=%2Ftrackgeek-backups
```

That is a deep link into the file manager **of the account itself** — it only opens for whoever is already logged into it. Anyone else lands on the login screen and sees nothing.

The project **never** creates a share link. The library's `generateShortUrl` calls `/share/pset` with `public=1`, `pwd=''`, and `period=0`: public, passwordless, and non-expiring. For a dump carrying the entire database (users, e-mails, Better Auth sessions) that would be a total leak to anyone holding the URL — and in a Discord channel the URL stays in the history forever.

`secrets/`, `tmp/`, and `.env` are in the `.gitignore`.

</samp>

## <samp>Operational Notes</samp>

<samp>

- The image embeds `pg_dump` 18 (PGDG) and the Playwright Chromium; ~1.9 GB. Chromium exists only for the jsToken fallback.
- The library's `fetchFileList` is pinned at `num=100&page=1`. With 2 backups/day and 7 days of retention (~14 files) there is plenty of headroom; a much longer retention would require implementing pagination.
- Terabox has no public API: endpoints and the `jsToken` format can change without notice. The Playwright fallback covers HTML changes, not protocol changes.

</samp>

## <samp>Contributing</samp>

<samp>

Contributions are always welcome!

See `CONTRIBUTING.md` for ways to get started.

Please adhere to this project's `code of conduct`.

</samp>
