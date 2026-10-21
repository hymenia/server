![The Hymenia Banner](https://hymenia.dotun.cc/ghbanner.png)

---

# Hymenia Server

The backend for Hymenia, a new open-source BYOC (bring your own client) platform for messaging and VoIP calls.
We are nowhere near finished!

## Quick setup

Run from this folder:

1. Install deps

```bash
pnpm install
```

2. Set env

Copy .env.example to .env and adjust if needed:

```bash
cp .env.example .env
```

Configure passkeys:
Set `WEBAUTHN_RP_ID` to the hostname users open in their browser and set
`WEBAUTHN_ORIGIN` to a comma-separated list of allowed client origins, including
the scheme and port. For a Tauri desktop client, include `tauri://localhost`
and `http://tauri.localhost` so packaged apps can use passkeys on Linux, macOS,
and Windows. Set the browser origin and RP ID for your deployed website as well.

3. Apply schema

The server applies `schema.sql` as a single migration when it starts.
Migration failures stop startup. Applied migrations are checksum-verified,
so do not edit `schema.sql` after deployment.

4. Start server

```bash
pnpm start
```

Check that the server is responding:

```bash
curl -k https://127.0.0.1:9070/health
```

Use `curl http://127.0.0.1:9070/health` when TLS certificate files are not
configured. The server needs PostgreSQL running at the `DATABASE_URL` address
before authenticated API calls can read or write data.

The server listens on all interfaces. From another device, use
`http://<ip>:9070/health`. Allow TCP port 9070 through your 
firewall when needed.

## Checks

Run the server unit tests with `pnpm test`. They use Node's built-in test runner
and do not require a running database.

Attachments are limited to 20 MB, written to `ATTACHMENTS_DIR` when set (or
`server/uploads` by default), and linked to messages in PostgreSQL.

## License

Hymenia Server is free and open source software released under the [MIT License](LICENSE).
