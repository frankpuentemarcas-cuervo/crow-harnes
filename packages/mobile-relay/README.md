# Crow Mobile Relay

Small in-memory WebSocket byte router for Crow's opaque, end-to-end TLS tunnel. The service itself speaks plain HTTP/WebSocket; terminate outer TLS at a trusted reverse proxy and forward WebSocket upgrades to this process. `GET /healthz` is a minimal readiness probe (204, `Cache-Control: no-store`, empty body) for a future isolated service health check; every other HTTP request path/method returns 404. The inner TLS records are forwarded untouched.

## Local use

Requires Node.js 22 for the production Compose profile (the server remains compatible with Node.js 20+ for local tests). From this directory, run `npm ci` followed by `npm test`, or `node src/server.mjs` (`PORT`, default `8080`; `HOST`, default `0.0.0.0`). `package-lock.json` pins the production dependency tree used by the deployment profile.

## Low-resource deployment on the Crow host

The Compose profile adds no host-published port. The relay container has a dedicated internal-only Docker network with a fixed private address for the existing host Nginx TLS proxy. It does not change Pangolin, TLS termination, DNS, firewall rules, or router ports.

1. Copy this package to the server and enter `packages/mobile-relay`.
2. Start the dependency one-shot and relay with `docker compose up -d`. The one-shot runs `npm ci` from the lockfile into a named volume; the runtime waits for it to succeed.
3. Add the Nginx location below to the **existing TLS server block for `crow.frabubu.com`**, then validate and reload that existing Nginx instance using its normal procedure. Do not create another port-443 listener. If Pangolin/Traefik currently owns TLS on port 443, do not install a competing Nginx listener; have the existing owner route this exact location or pause and coordinate first.
4. Verify locally with `docker compose exec mobile-relay node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.status === 204 ? 0 : 1))"`; expect exit code `0` and an empty body.

The runtime is Node 22 Alpine, UID/GID `10001:10001`, read-only root filesystem and source/dependencies, no Linux capabilities, `no-new-privileges`, 0.25 CPU, 128 MiB RAM, and 32 PIDs. The deployed single-user profile configures `MAX_ROUTES=2` and `MAX_DEVICE_STREAMS_PER_ROUTE=4`; the entrypoint rejects malformed or above-maximum overrides. The install one-shot is separately limited and only writes the named dependency volume.

### Nginx WebSocket location

File: `deploy/nginx-crow-frabubu.location.conf`. Include the fragment only inside the already-running TLS server for `crow.frabubu.com`; it preserves that server's existing certificate, hostname, and port. `access_log off` prevents access-log entries from recording the private relay path. The upstream is the relay's fixed private bridge address.

```nginx
location = /v1/tunnel {
    access_log off;

    proxy_pass http://172.30.254.2:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
```

If the dependency lock changes, refresh the volume from the updated lockfile, then recreate the relay:

```sh
docker compose run --rm --no-deps mobile-relay-deps
docker compose up -d --force-recreate mobile-relay
```

The relay's fixed address `172.30.254.2` belongs to its internal-only Docker bridge (`172.30.254.0/28`); it has no published host port and no default route. Do not add a host-published port. Do not forward `/v1/tunnel` into access logs.

## Tunnel contract

Clients upgrade exactly `/v1/tunnel` and send `X-Crow-Route` (canonical base64url for 32 bytes) and `X-Crow-Role` (`gateway` or `device`). Devices also send UUID `X-Crow-Stream`; gateways must not send that header. A route supports one gateway and multiple distinct device streams. The deployed single-user profile caps at 2 routes, 4 streams per route, and 10 active WebSockets globally. The relay implementation's hard ceilings are 16 routes, 8 streams per route, and 144 WebSockets; unsafe overrides are rejected.

Control frames are JSON text. A device causes `{ "type": "open", "streamId": "…" }` to be sent to the gateway. The gateway responds with `accept`, `reject`, or `close`; the device receives `ready` only after `accept`. Binary device frames are prefixed on the gateway leg by ASCII `CHT1`, the 36-byte UUID, then the unchanged TLS bytes. Gateway binary frames must contain that envelope and are stripped before delivery to the matching device.

Frames are limited to 64 KiB, with 40 bytes reserved for the gateway envelope (device-originated TLS payload max 65,496 bytes/frame). Compression is disabled. Per-socket queued output is capped at 128 KiB; pending opens expire after 10 seconds. No route tokens, frame bytes, or credential contents are logged or parsed.
