# Cepheus site API

Small zero-dependency Node service behind `cepheus.codes/api/site/`. It stores the token contract
address (CA), the X profile and the Robinhood Chain network, serves top holders from the Blockscout
explorer API, and has a password-protected admin used by `/admin`.

- Listens on `127.0.0.1:8791` (nginx proxies `location /api/site/`).
- State: `/var/lib/cepheus-site/state.json` (owner `cepheus`, mode 600, atomic writes). The admin
  password is stored only as a salted scrypt hash.
- Sessions live in memory (12 h, HttpOnly + Secure + SameSite=Strict cookie on `/api/site`), so a
  restart signs the admin out.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/site/public` | `{ "ca": string\|null, "x": string\|null }` and nothing else |
| GET | `/api/site/holders?limit=50` | Top holders (1 to 100), cached 60 s. `status` is `ok`, `no_token` or `unavailable` (502) |
| POST | `/api/site/login` | `{ "password": "…" }`, 5 attempts per minute per IP |
| POST | `/api/site/logout` | Ends the session |
| GET/PUT | `/api/site/admin/settings` | `{ ca, x, network, explorerKey? }`; `null` or `""` clears a value |
| POST | `/api/site/admin/password` | `{ "current": "…", "next": "…" }`, signs out other sessions |

| POST | `/api/site/admin/recovery` | Creates 8 new one-time recovery codes (returned once; old ones stop working) |
| POST | `/api/site/reset-password` | `{ "code": "xxxx-xxxx-xxxx", "next": "…" }`, same 5/min/IP limit; consumes the code, replaces the password, signs out every session and signs this one in |

Recovery codes: only salted scrypt hashes are stored (`recovery` in state.json). A code is
checked against every stored hash (padded to 8) without stopping early. The admin settings
response includes `recoveryLeft`.

## Lost password and every recovery code

On the server, as root:

```sh
node /srv/cepheus/site-api/server.mjs --reset-password   # prompts twice, no echo
systemctl restart cepheus-site-api                        # load the new hash
```

Without a terminal (for example from a script), pass the password in the environment instead:
`CEPHEUS_ADMIN_NEW_PASSWORD='…' node /srv/cepheus/site-api/server.mjs --reset-password < /dev/null`.
The state file is written atomically and keeps its `cepheus:cepheus` owner and mode 600.
Restart the service right away: until then the running service still has the old hash and
could overwrite the file on its next save.

Every non-GET request must come from `https://cepheus.codes` or `https://www.cepheus.codes`
(`Origin` header) and use `Content-Type: application/json`.

CA input: `0x` + 40 hex; it is stored in EIP-55 checksum form, and a mixed-case address with a
wrong checksum is rejected. X input: `@handle`, `handle`, or an `x.com`/`twitter.com` profile link,
stored as `https://x.com/<handle>`.

## Networks

Verified values are in `NETWORKS` at the top of `server.mjs` (sources in the comments):
Robinhood Chain mainnet (chain ID 4663) and testnet (46630). The mainnet explorer
(robinhoodchain.blockscout.com) blocks server requests with a Cloudflare challenge, so mainnet
holders need a free Blockscout API key from https://dev.blockscout.com, entered in the admin page
(stored server-side, never returned). The testnet explorer API is open.

## Install / update (as root)

```sh
id cepheus || useradd --system --home /srv/cepheus --shell /usr/sbin/nologin cepheus
install -d -o root -g root -m 755 /srv/cepheus/site-api
install -o root -g root -m 644 server.mjs /srv/cepheus/site-api/server.mjs
install -d -o cepheus -g cepheus -m 700 /var/lib/cepheus-site
install -o root -g root -m 644 cepheus-site-api.service /etc/systemd/system/
# First time only: set the admin password from stdin (only the hash is stored).
runuser -u cepheus -- env STATE_DIR=/var/lib/cepheus-site node /srv/cepheus/site-api/server.mjs --set-password < password.txt
systemctl daemon-reload && systemctl enable --now cepheus-site-api
```

nginx (inside the HTTPS `cepheus.codes` server block):

```nginx
location /api/site/ {
    proxy_pass http://127.0.0.1:8791;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 16k;
}
location = /admin {
    add_header X-Robots-Tag "noindex" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    try_files /admin.html =404;
}
```
