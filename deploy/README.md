# Deployment

Production runs on a shared EC2 box at `32.236.114.49` (Ubuntu 26.04) that also
hosts ~15 other apps. Nothing here is exclusive to this app — stay inside
`/var/www/shraddha-impex` and the ports below.

**Canonical URL: <https://erp.shraddhaimpex.net>**

| Entry point                    | Behaviour                                    |
| ------------------------------ | -------------------------------------------- |
| `https://erp.shraddhaimpex.net`| the portal — nginx serves `frontend/dist`     |
| `http://erp.shraddhaimpex.net` | 301 to HTTPS (certbot-managed)                |
| `:4003`                        | 301 to the canonical URL — legacy entry point |
| `:4000`                        | backend direct, for debugging only            |

The SPA calls the API **same-origin**: the browser requests `/api/v1/...` on
`erp.shraddhaimpex.net` and nginx proxies it to `127.0.0.1:4000`, so CORS never
enters the picture for normal traffic and there is no mixed content.

`:4003` redirects rather than serving a second copy of the app. The JWT lives in
`localStorage`, which is per-origin, so serving the portal on both the IP and the
domain would split logins into two unrelated sessions.

## Layout on the server

```
/var/www/shraddha-impex/        git clone of this repo, branch main
├── backend/.env                secrets — NOT in git, created by hand
├── frontend/dist/              build output, rsynced in by CI
└── ecosystem.config.cjs        PM2 process definition

/etc/nginx/snippets/shraddha-impex-app.conf   <- synced by CI from deploy/nginx/
/etc/nginx/sites-available/shraddha-impex     <- certbot-managed, NEVER synced
/etc/letsencrypt/live/erp.shraddhaimpex.net/  <- certificate
/var/log/pm2/shraddha-backend.{out,error}.log
/var/log/nginx/shraddha-impex.{access,error}.log
```

### Why the nginx config is split in two

`sites-available/shraddha-impex` holds the server blocks, and certbot rewrites
that file every time it issues or renews. Everything the app actually needs —
docroot, SPA fallback, the `/api` and `/socket.io` proxies — lives in the
snippet, which every server block includes.

Deploys sync **the snippet only**. Copying the repo's bootstrap copy of the site
file over the live one would strip the TLS directives and take HTTPS down on
every push.

## TLS

Issued by Let's Encrypt for `erp.shraddhaimpex.net`, expiring **2026-11-08**.
`certbot.timer` is enabled, so renewal is automatic — no cron entry needed.

```bash
sudo certbot certificates              # what is installed and when it expires
sudo certbot renew --dry-run           # prove renewal still works
```

Renewal needs port 80 to stay open and `erp.shraddhaimpex.net` to keep pointing
at this box. If either changes, renewal fails silently until the cert expires.

## CI/CD

- `.github/workflows/ci.yml` — every branch and PR: frontend lint + build,
  backend install + syntax check.
- `.github/workflows/deploy.yml` — every push to `main`: build, rsync, reload,
  health check. Also runnable from the Actions tab (`workflow_dispatch`).

**The frontend is built on the GitHub runner, never on the server.** The box has
3.7 GB of RAM, no swap, and 15 other production apps on it; a Vite build there
risks the kernel OOM killer picking off a neighbour.

### Required GitHub secrets

Settings → Secrets and variables → Actions:

| Secret         | Value                                       |
| -------------- | ------------------------------------------- |
| `EC2_HOST`     | `32.236.114.49`                             |
| `EC2_USER`     | `ubuntu`                                     |
| `EC2_SSH_KEY`  | full contents of `erp-p-2.pem`, BEGIN/END lines included |
| `VITE_API_URL` | `https://erp.shraddhaimpex.net`              |
| `SITE_URL`     | `https://erp.shraddhaimpex.net`              |

`VITE_API_URL` is baked into the bundle at build time — changing it requires a
rebuild, not a restart. It must match the origin the app is served from, or
every API call becomes cross-origin and CORS will reject it.

## Manual operations

```bash
ssh -i erp-p-2.pem ubuntu@32.236.114.49

pm2 logs shraddha-backend --lines 100   # tail the API
pm2 restart shraddha-backend            # restart after an .env change
pm2 list                                # all apps on the box

sudo nginx -t && sudo systemctl reload nginx
tail -f /var/log/nginx/shraddha-impex.error.log
```

Changing a secret means editing `/var/www/shraddha-impex/backend/.env` and then
`pm2 restart shraddha-backend --update-env`. Deploys never overwrite that file.

`FRONTEND_URL` in that file is the CORS and Socket.IO origin allowlist. It must
stay equal to the canonical URL above.

## Known gaps

- **No rate limiting.** `app.js` documents this as deliberate, but on a public
  hostname it leaves `/api/v1/auth/login` open to unlimited password guessing.
- **`JWT_SECRET` is shared with development.** A token minted on a dev machine
  is valid in production. Rotate it here and it stops being true.
- **No HSTS.** TLS works, but nothing tells browsers to refuse plain HTTP on
  return visits. Worth adding once you are confident the cert will keep renewing.
