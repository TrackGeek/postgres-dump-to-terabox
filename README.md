# postgres-dump-to-terabox

Backup automático do Postgres do TrackGeek para o Terabox, a cada 12 horas, com retenção de 7 dias e notificação no Discord a cada estágio.

## Como funciona

```
cron (0 */12 * * *)
  └─ lock  ──> auth (storageState → ndus + jsToken)
              └─ pg_dump -Fc  ──> upload chunked (blocos de 4 MiB)
                                   └─ retenção (> 7 dias)  ──> Discord ✅
```

- **Dump**: `pg_dump --format=custom` (já comprimido, restaura com `pg_restore`).
- **Upload**: implementação própria em blocos de 4 MiB (`precreate` → `superfile2` → `create`). A `uploadFile` da lib `terabox-upload-tool` não é usada: ela carrega o arquivo inteiro na RAM e manda um único bloco (`partseq=0`), o que corrompe qualquer arquivo acima de 4 MiB. A lib é usada só para `fetchFileList` e `deleteFiles`.
- **Token**: o cookie `ndus` sai do `storageState.json` salvo por um login manual. O `jsToken` sai de um `fetch` da página `/main` com esse cookie; **só** se o HTML mudar de formato é que o Playwright sobe (headless, reidratando o mesmo `storageState`). Nunca há login automatizado, então nunca há CAPTCHA.
- **Retenção**: a data vem do timestamp no nome do arquivo (`trackgeek-YYYYMMDD-HHmmss.dump`), com `server_mtime` como fallback. Arquivos que não seguem o prefixo são ignorados.

## Setup

```bash
bun install
bunx playwright install chromium
```

Crie um `.env` na raiz do projeto:

```dotenv
# DATABASE
DATABASE_URL='postgres://postgres:postgres@localhost:20141/trackgeek'

# DISCORD
DISCORD_WEBHOOK_URL=''

# TERABOX
TERABOX_APP_ID='250528'
TERABOX_REMOTE_DIR='/trackgeek-backups'
TERABOX_STORAGE_STATE='./secrets/storageState.json'

# BACKUP
BACKUP_PREFIX='trackgeek'
RETENTION_DAYS='7'
CRON_SCHEDULE='0 */12 * * *'
RUN_ON_BOOT='true'
DRY_RUN='false'
TMP_DIR='./tmp'
TZ='America/Sao_Paulo'
```

Só `DATABASE_URL` é obrigatório — o resto tem default igual ao mostrado acima. Sem `DISCORD_WEBHOOK_URL` os estágios só vão para o log.

### Login no Terabox (uma vez)

```bash
bun run login
```

Abre um Chromium **visível**. Logue normalmente (CAPTCHA incluso). Assim que o cookie `ndus` aparecer, a sessão é gravada em `secrets/storageState.json` com permissão `600` e o browser fecha sozinho.

Repita só quando a sessão expirar — o job avisa no Discord com "Rodar `bun run login` no servidor" quando isso acontecer.

## Uso

```bash
bun run start   # daemon: cron 0 */12 * * * + execução no boot
bun run once    # uma execução e sai (exit 0/1) — para system cron ou teste
```

Com `DRY_RUN=true` o dump e o upload acontecem normalmente, mas a limpeza só **lista** o que apagaria.

### Rodar como serviço

```bash
pm2 start "bun run start" --name trackgeek-backup
```

Ou, se preferir o cron do sistema em vez do daemon, use `bun run once` no crontab e deixe `RUN_ON_BOOT` fora da jogada:

```cron
0 */12 * * * cd /caminho/postgres-dump-to-terabox && /opt/homebrew/bin/bun run once >> tmp/backup.log 2>&1
```

## Restaurar um backup

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname='postgres://postgres:postgres@localhost:20141/trackgeek' \
  trackgeek-20260805-030000.dump
```

Para só conferir a integridade do arquivo: `pg_restore --list arquivo.dump`.

## Link no Discord

Os embeds de `uploaded` e `finished` trazem um link clicável pra pasta de backups no Terabox:

```
https://www.1024terabox.com/main?category=all&path=%2Ftrackgeek-backups
```

É um deep link pro gerenciador de arquivos **da própria conta** — só abre pra quem já está logado nela. Quem não estiver cai na tela de login e não vê nada.

O projeto **nunca** cria link de compartilhamento. A `generateShortUrl` da lib chama `/share/pset` com `public=1`, `pwd=''` e `period=0`, ou seja: público, sem senha e sem expiração. Num dump que carrega o banco inteiro (usuários, e-mails, sessões do Better Auth), isso seria vazamento total pra qualquer um com a URL — e num canal do Discord a URL fica no histórico pra sempre.

## Guardas de segurança

A limpeza é abortada (com aviso no Discord, sem apagar nada) quando:

- o backup recém-enviado não aparece na listagem remota — sinal de sessão quebrada ou listagem incompleta;
- a remoção deixaria **zero** backups.

Nenhum estágio loga a `DATABASE_URL` (ela só vai no argv do `pg_dump`), e o `jsToken` aparece truncado nas notificações.

## Notas operacionais

- `pg_dump` precisa ser >= a versão major do servidor Postgres.
- `fetchFileList` da lib é fixado em `num=100&page=1`. Com 2 backups/dia e 7 dias de retenção (~14 arquivos) sobra folga; se aumentar muito a retenção, isso vira paginação a implementar.
- O Terabox não tem API pública: endpoints e formato do `jsToken` podem mudar sem aviso. O fallback Playwright cobre mudança de HTML, não mudança de protocolo.
- `secrets/`, `tmp/` e `.env` estão no `.gitignore`.
