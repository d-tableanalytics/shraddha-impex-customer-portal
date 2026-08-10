# Deployment

Production runs on a shared EC2 box at `32.236.114.49` (Ubuntu 26.04) that also
hosts ~15 other apps. Nothing here is exclusive to this app — stay inside
`/var/www/shraddha-impex` and the ports below.

| Piece    | Port   | Served by                                    |
| -------- | ------ | -------------------------------------------- |
| Frontend | `4003` | nginx, static from `frontend/dist`           |
| Backend  | `4000` | PM2 process `shraddha-backend` (`server.js`) |

The SPA calls the API **same-origin**: the browser requests `/api/v1/...` on
`:4003` and nginx proxies it to `:4000`, so CORS never enters the picture for
normal traffic. `:4000` is also directly reachable for debugging
(`curl http://32.236.114.49:4000/health`).

## Layout on the server

```
/var/www/shraddha-impex/        git clone of this repo, branch main
├── backend/.env                secrets — NOT in git, created by hand
├── frontend/dist/              build output, rsynced in by CI
└── ecosystem.config.cjs        PM2 process definition
/etc/nginx/sites-available/shraddha-impex   copy of deploy/nginx/shraddha-impex.conf
/var/log/pm2/shraddha-backend.{out,error}.log
```

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
| `VITE_API_URL` | `http://32.236.114.49:4003`                  |

`VITE_API_URL` is baked into the bundle at build time — changing it requires a
rebuild, not a restart.

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

## Known gaps

- **No HTTPS.** Traffic on `:4003` is plaintext, including the login POST that
  carries the password and the JWT that comes back. Point a DNS name at the box
  and run certbot before real customers use it.
- **No rate limiting.** `app.js` documents this as deliberate, but it leaves
  `/api/v1/auth/login` open to unlimited password guessing on a public port.
- **`JWT_SECRET` is shared with development.** A token minted on a dev machine
  is valid in production. Rotate it here and it stops being true.
