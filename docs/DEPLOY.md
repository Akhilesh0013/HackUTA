# Deploying Genesis (Vultr + GoDaddy + MongoDB Atlas)

The result is the call page and dashboard on your own domain over HTTPS, with the FaceTime bridge running as a service. Do the steps in this order: Caddy can only get a certificate once the domain points at the server.

## 1. Create the server (Vultr)

1. In Vultr, deploy a **Cloud Compute** instance with **Ubuntu 24.04**. 1 vCPU and 2 GB RAM is enough.
2. Add your SSH key while creating it.
3. Copy the server's public IPv4 address.

## 2. Point the domain at it (GoDaddy)

1. Claim the domain with the hackathon code, then open **DNS** for it in GoDaddy.
2. Add an **A** record. Name: `@` (or a subdomain such as `genesis`). Value: the Vultr IPv4. TTL: 600 seconds.
3. Wait until `dig +short <your domain>` returns the Vultr IP. This usually takes a few minutes.

## 3. Run the setup script

On the server, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/Akhilesh0013/HackUTA/main/deploy/setup.sh -o setup.sh
DOMAIN=<your domain> bash setup.sh
```

The script:
- installs Node 22, Caddy, git and ufw
- clones the repo to `/opt/genesis` and runs it as a `genesis` system user
- creates `/opt/genesis/.env` (readable only by that user) with a random `DASHBOARD_TOKEN`
- starts `genesis-web`, and `genesis-bridge` once LiveKit keys are present
- sets up HTTPS through Caddy, and opens only ports 22, 80 and 443

It prints the call page URL and the dashboard URL with its token. Keep that dashboard link private: it shows call logs.

## 4. Add the keys

Edit `/opt/genesis/.env`:

```
GEMINI_API_KEY=...
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
MONGODB_URI=mongodb+srv://...      # optional, see step 5
```

Then run `DOMAIN=<your domain> bash setup.sh` again. It restarts the app and turns on the bridge now that LiveKit keys are there.

## 5. MongoDB Atlas (optional)

1. Create a free cluster in Atlas, and a database user with read/write access.
2. Under **Network Access**, allow the Vultr server's IP. Don't use 0.0.0.0/0.
3. Copy the connection string into `MONGODB_URI`. Optionally set `MONGODB_DB` (default `genesis`).

Every call is still written to the files under `/opt/genesis/data`, which curation reads. MongoDB gets a copy in the `observations`, `sessions` (one document per call) and `consent` collections. If Atlas is down, calls keep working, and the server logs one warning a minute.

## Checks

- `https://<your domain>/call.html` loads, and the browser asks for the camera.
- `https://<your domain>/dashboard.html` says **Locked**. With `?token=...` it shows data.
- `journalctl -u genesis-web -f` shows `call_start` when you place a call.
- `journalctl -u genesis-bridge -f` shows `Watching for calls…`.

## Updating

Push to `main`, then run `DOMAIN=<your domain> bash setup.sh` on the server again.
