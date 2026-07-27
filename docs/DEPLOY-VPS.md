# Deploying Ledger on an Ubuntu VPS

From a blank Ubuntu 22.04/24.04 server to a running, TLS-terminated Ledger in about twenty
minutes. Everything runs in Docker; nothing is installed on the host except Docker itself.

## What you need before starting

| Thing | Why |
|---|---|
| A VPS with **2 vCPU / 4 GB RAM / 40 GB disk** | The Next.js build is the peak load. 2 GB works only with swap (step 1 adds it anyway). |
| A **domain name** with an A record pointing at the VPS IP | Caddy gets TLS certificates automatically, and Plaid webhooks need a public HTTPS URL. Set this up first — DNS propagation is the slowest step. **No domain yet?** See "Running without a domain" below — a bare IP is not an option, but there is a free workaround. |
| Ports **80 and 443** reachable | Let's Encrypt validation and the app itself. |
| A **Resend API key** (resend.com) | Production refuses to boot without it — notifications silently not sending is worse than not starting. |
| **Plaid credentials** (dashboard.plaid.com) | Optional at first: `AGGREGATOR=fixture` runs the whole product without them. |

## 1. Prepare the server

SSH in as root (or a sudo user) and run:

```bash
# Swap: the Next build peaks past what a small VPS has. Harmless on a big one.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Firewall: SSH + web, nothing else. Postgres/Redis/MinIO are never published to the host.
apt-get update && apt-get install -y ufw
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

## 2. Install Docker

The official repository, not Ubuntu's `docker.io` package — compose v2 comes with it:

```bash
curl -fsSL https://get.docker.com | sh

# Let your own user talk to the daemon — the installer does not do this, and without it every
# docker command fails with "permission denied ... docker.sock". The group lands in new
# sessions; `newgrp docker` opens a subshell where it is active immediately. (Logging out and
# back in works too, and makes it permanent for every future session either way.)
sudo usermod -aG docker $USER
newgrp docker
```

Verify: `docker ps` runs without sudo and without a permission error.

## 3. Get the code

`/opt` is root-owned, so claim the directory first — cloning straight into it fails with
`could not create work tree dir: Permission denied` on any non-root session:

```bash
sudo mkdir -p /opt/ledger && sudo chown $USER:$USER /opt/ledger
git clone https://github.com/ReFxFrank/Ledger.git /opt/ledger
cd /opt/ledger
```

If the repository is private, create a fine-grained personal access token (GitHub → Settings →
Developer settings) with read access to this one repo, and clone with
`git clone https://<token>@github.com/ReFxFrank/Ledger.git /opt/ledger`.

## 4. Configure

```bash
cp .env.example .env
```

Generate the two secrets the app refuses to boot without:

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 48)"
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
```

Generate the web-push keypair (production requires it):

```bash
docker run --rm node:22-alpine npx --yes web-push generate-vapid-keys
```

Then edit `.env` (`nano .env`) and set — everything else can keep its default:

```ini
NODE_ENV=production
LOG_LEVEL=info

# Your domain, https, no trailing slash. Used for auth callbacks, emails, and webhooks.
APP_URL=https://ledger.example.com
NEXT_PUBLIC_APP_URL=https://ledger.example.com
BETTER_AUTH_URL=https://ledger.example.com
# What Caddy answers for and provisions TLS for. Domain only, no scheme.
LEDGER_DOMAIN=ledger.example.com
LEDGER_ACME_EMAIL=you@example.com

# The two generated secrets.
BETTER_AUTH_SECRET=<from above>
ENCRYPTION_KEY=<from above>

# A strong database password — this is what protects the data at the network layer.
POSTGRES_PASSWORD=<openssl rand -base64 24>

# Mail (required in production).
RESEND_API_KEY=re_...
EMAIL_FROM="Ledger <ledger@your-verified-domain.com>"

# Push (required in production) — from the generate-vapid-keys output.
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<same as VAPID_PUBLIC_KEY>

# Bank data. Start with fixture (no credentials needed, full product works),
# switch to plaid when ready.
AGGREGATOR=plaid
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox        # 'production' when you have live access from Plaid

# Object storage credentials (MinIO runs in compose; these just need to be strong).
S3_ACCESS_KEY_ID=<openssl rand -hex 12>
S3_SECRET_ACCESS_KEY=<openssl rand -base64 24>
```

Two notes worth reading before moving on:

- **Back up `ENCRYPTION_KEY` somewhere that is not this server.** Every bank token is sealed
  under it. A database backup without this key is ciphertext; this key without a backup of the
  database opens nothing. Store them separately.
- `DATABASE_URL` and `REDIS_URL` in `.env` can stay pointing at localhost — the production
  compose file overrides them with the in-network container addresses.

## 5. Launch

```bash
cd /opt/ledger
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

First run takes several minutes: it builds the web and worker images, starts Postgres/Redis/
MinIO, runs migrations as a one-shot step (web and worker wait for it), and Caddy fetches TLS
certificates. Watch it:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f --tail 50
```

Then seed the merchant registry — the 141 merchants and their cancellation playbooks. This is
reference data the product needs, **not** demo data (`--merchants-only` creates no user):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm migrate \
  node_modules/.bin/tsx src/seed/demo.ts --merchants-only
```

Open `https://your-domain` — you should see the sign-in screen with a valid certificate.
Create your account; TOTP setup is mandatory and happens immediately after sign-up.

## 6. Verify it is actually healthy

```bash
# The app, through Caddy, with a live database check behind it:
curl -s https://ledger.example.com/api/health
# → {"status":"ok","databaseLatencyMs":...}

# All services up:
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
# postgres, redis, minio, web, worker, caddy — all "running (healthy)";
# migrate and minio-init show "exited (0)", which is correct — they are one-shots.
```

With a public HTTPS `APP_URL`, Plaid webhooks work for real: the adapter registers
`https://your-domain/api/webhooks/plaid` automatically when connections are created, so syncs
become aggregator-initiated instead of manual.

## 7. Updating

```bash
cd /opt/ledger
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run before the new code serves traffic, and every migration is written to be
backwards-compatible with the previous release (see `docs/RUNBOOK.md`), so a plain `git pull`
deploy is safe. Rollback = `git checkout <previous-tag>` and the same command; never roll
migrations back.

## 8. Backups

Nightly dump, kept for 14 days — put this in root's crontab (`crontab -e`):

```
15 3 * * * cd /opt/ledger && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_dump -U ledger -Fc ledger > /var/backups/ledger-$(date +\%F).dump && find /var/backups -name 'ledger-*.dump' -mtime +14 -delete
```

Evidence uploads live in the MinIO volume; mirror them too if users store cancellation
evidence. And repeat the warning from step 4: **a database backup is useless without
`ENCRYPTION_KEY`, and the two must not live in the same place.** A restore drill is in
`docs/RUNBOOK.md` — a backup that has never been restored is a hypothesis.

## Running without a domain

A bare IP does not work: production makes session cookies `Secure`-only and requires an https
`APP_URL` (the boot check enforces it), and certificate authorities do not reliably issue for
naked IPs — so you would get either broken sign-in or a self-signed certificate that browsers
warn about and Plaid refuses to deliver webhooks to.

The workaround is **sslip.io**: public wildcard DNS where `<your-ip>.sslip.io` resolves to your
IP with no signup. It is a real hostname, so Caddy obtains a real certificate for it:

```bash
cd /opt/ledger
IP=$(curl -4 -s ifconfig.me)
sed -i "s|^APP_URL=.*|APP_URL=https://$IP.sslip.io|; s|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=https://$IP.sslip.io|; s|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=https://$IP.sslip.io|" .env
grep -q '^LEDGER_DOMAIN=' .env && sed -i "s|^LEDGER_DOMAIN=.*|LEDGER_DOMAIN=$IP.sslip.io|" .env || echo "LEDGER_DOMAIN=$IP.sslip.io" >> .env
```

Caveats, stated plainly: sslip.io is a third-party convenience with Let's Encrypt rate limits
shared across everyone using it. Caddy falls back to ZeroSSL automatically, so issuance usually
succeeds; if Caddy's logs show both CAs refusing, a free DuckDNS subdomain (two-minute signup,
on the public suffix list, so it gets its own rate limit) is the reliable alternative. Moving to
a real domain later is the same four `.env` lines and one `up -d`.

## Sharing the server with existing sites

If `sudo ss -tlnp | grep -E ':(80|443)\s'` shows an existing web server, Ledger's Caddy cannot
bind and should not try. Use the third overlay, which parks Caddy and publishes the app on
loopback only:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.behind-proxy.yml up -d --build
curl -s http://127.0.0.1:3080/api/health   # → {"status":"ok",...}
```

Then add one vhost to the existing **nginx** (`/etc/nginx/sites-available/ledger`):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name YOUR-DOMAIN-OR-IP.sslip.io;

    # Evidence uploads.
    client_max_body_size 15m;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # The app decides "am I behind https" from this; wrong value = broken sign-in cookies.
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # The first bank connect backfills years of history inside one request.
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ledger /etc/nginx/sites-enabled/ledger
sudo nginx -t && sudo systemctl reload nginx

# TLS: certbot rewrites the vhost above with certificate lines and the https redirect.
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR-DOMAIN-OR-IP.sslip.io --redirect
```

`APP_URL`/`LEDGER_DOMAIN` in `.env` are unchanged — the app never knows which proxy fronts it,
only that `X-Forwarded-Proto` says https. Ledger's own Caddy never runs, so nothing competes
with the existing sites for 80/443, and the only new listener on the host is 127.0.0.1:3080.

## Troubleshooting the first launch

| Symptom | Cause |
|---|---|
| `Environment is not usable: …` in web/worker logs | A required `.env` value is missing — the message names every one at once. Fix, then `up -d` again. |
| Caddy logs show ACME failures | DNS not propagated yet, or port 80/443 blocked at the provider's firewall (some VPS hosts have one outside the machine). |
| Build dies on a small VPS | RAM. Confirm the swapfile from step 1 is active (`free -h`), or build on a bigger box and ship the images. |
| `web` restarts in a loop before `migrate` finished | It waits by design; check `migrate`'s logs — a wrong `POSTGRES_PASSWORD` after first boot is the usual cause, because the database initialised itself with the old one. |
| Site loads without TLS padlock on a subdomain | `LEDGER_DOMAIN` must be exactly the domain in the address bar. |

One honest caveat: this production compose stack is complete and reviewed, but it has not yet
been executed end-to-end on a fresh VPS by the authors — the development machine could not run
Docker. Expect the first launch to be 95% smooth and possibly one papercut; the logs command in
step 5 is your friend, and each container fails loudly with a named reason rather than
silently.
