# Deployment

Two containers plus Postgres and Redis. Nothing else is required.

## Dokploy (the supported path)

1. **Create the application** — point Dokploy at this repository and choose
   *Docker Compose*, with `docker-compose.prod.yml` as the compose file.

2. **Generate signing keys** locally and copy the inline form:

   ```bash
   ./scripts/gen-keys.sh
   ```

   The script prints `JWT_PRIVATE_KEY=…` and `JWT_PUBLIC_KEY=…` with newlines
   escaped, which is the form Dokploy's environment editor accepts.

3. **Set the environment** in Dokploy's UI. The minimum is:

   | Variable            | Example                          |
   | ------------------- | -------------------------------- |
   | `DOMAIN`            | `watch.example.com`              |
   | `API_DOMAIN`        | `api.watch.example.com`          |
   | `POSTGRES_PASSWORD` | *(generate a long random value)* |
   | `JWT_PRIVATE_KEY`   | *(from `gen-keys.sh`)*           |
   | `JWT_PUBLIC_KEY`    | *(from `gen-keys.sh`)*           |

   Optional but recommended: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `YOUTUBE_API_KEY`, and TURN credentials. See `.env.example` for the full
   list — every variable there is documented with what it does and whether it
   is required.

4. **Point DNS** at the Dokploy host: an `A` record for both `DOMAIN` and
   `API_DOMAIN`. Traefik requests certificates on first request.

5. **Deploy.** Migrations run automatically at boot; there is no separate
   migration step.

### Why two domains

The API and the web client are separate services with different timeout and
caching needs, and the socket path benefits from a proxy configuration that
would be wrong for a page request. Running them on one domain is possible —
route `/api` and `/ws` to the server — but the split is simpler to reason about
and lets each scale independently.

If you do use a single domain, set `COOKIE_DOMAIN` to it and leave
`PUBLIC_API_URL` / `PUBLIC_WS_URL` empty so the client uses same-origin
requests.

## Anywhere else

```bash
cp .env.example .env      # then edit it
./scripts/gen-keys.sh
docker compose -f docker-compose.prod.yml up -d
```

Traefik labels are inert without Traefik, so add a proxy in front. The included
`infra/caddy/Caddyfile` is a working configuration with automatic TLS.

## Scaling out

```bash
docker compose -f docker-compose.prod.yml up -d --scale server=3
```

No sticky-session configuration is needed. Each room's authoritative timeline
is owned by whichever node holds its Redis lease; other nodes serve their own
sockets and forward mutating intents to the owner
([ADR 0010](adr/0010-horizontal-scaling.md)).

Postgres and Redis are single instances in the reference deployment. The
natural next step is managed Postgres with a read replica for the directory
queries.

## Health and rollout

| Endpoint        | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `/health/live`  | The process is running. Touches no dependency — a database blip must not trigger a restart loop. |
| `/health/ready` | Postgres and Redis are reachable **and** the node is not draining. |
| `/metrics`      | Prometheus exposition. Keep it off the public internet.     |

On `SIGTERM` the server flips readiness to 503 *first*, waits for the proxy to
notice, then releases its room leases and closes sockets. A deploy costs
clients one reconnect rather than a dropped room.

### What to alert on

- `ytroom_sync_drift_p95_ms` above 150 for a sustained period — this is the
  product's actual SLO, not a proxy for it.
- `ytroom_ws_slow_clients_total` climbing — clients being dropped for failing
  to drain, usually a sign of an overloaded node.
- `/health/ready` failing on any node for more than a minute.

## Operational notes

**Backups.** Only Postgres holds anything irreplaceable. Redis is entirely
reconstructible — losing it costs at most 30 seconds of room read-only time.

**Secrets rotation.** Replacing `JWT_PRIVATE_KEY` invalidates every access
token immediately; clients recover silently via the refresh cookie, so this is
safe to do during business hours. Replacing it *and* clearing
`refresh_tokens` signs everyone out.

**TURN.** Without a TURN server, users behind symmetric NAT (a real minority on
mobile networks) will join the room, see video, chat — and silently fail to
connect voice. If voice matters, run coturn; the dev compose file has a working
configuration to copy.
