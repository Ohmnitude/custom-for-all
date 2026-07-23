# Custom For All

Static portfolio site with a small Node service for secure inquiry collection.

## Inquiry delivery

The final questionnaire submits to `POST /api/inquiries`. The server:

1. validates the Cloudflare Turnstile token;
2. validates and limits the submitted fields;
3. saves the inquiry to `data/inquiries.sqlite` before attempting email;
4. emails the configured recipient through SMTP; and
5. records the SMTP message ID or delivery error with the inquiry.

The production recipient defaults to `customforall@gmail.com` and can be changed with `INQUIRY_RECIPIENT`.

## Local development

Node 24 or newer is required.

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:8787`. Local development uses Cloudflare's official always-pass Turnstile test keys and Nodemailer's JSON transport, so no real email is sent.

Copy `.env.example` into the production environment and provide real Turnstile and SMTP credentials before deployment. Production startup refuses to run when required credentials are missing.

## Reviewing inquiries

```sh
npm run inquiries
```

Pass a number to change the result limit, for example `npm run inquiries -- 50`.

## Current hosting

The public site is `https://cfa.ohmnitude.net`. Static assets are served directly by Nginx on the Node VPS.

The form service is designed to run in the dedicated container defined in `compose.yaml`. It runs as UID 10001 with a read-only root filesystem, no Linux capabilities, no privilege escalation, bounded resources, and no public port. Nginx proxies only the required API routes to `127.0.0.1:8787` using `deploy/nginx-api-location.conf`.

The container must never mount the Docker socket, Psychurch directories, server credentials, or another application's network. Its dedicated subnet is `172.30.250.0/28`, which does not overlap the Node VPS's existing Docker networks.

Install `deploy/firewall-isolation.sh` and the two systemd units in `deploy/` before enabling the production container. The firewall service rejects traffic from `172.30.250.0/28` to the server's public IP, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `169.254.0.0/16`. The form service starts only after that firewall is active. This blocks the form service from reaching Psychurch services, other containers, private networks, and the provider metadata network while retaining the public HTTPS and SMTP egress needed for Turnstile and email delivery.

## Automatic deployment

Pushes to `main` run `.github/workflows/deploy.yml` on the repository's dedicated Node VPS runner. The runner is an unprivileged user and can only invoke the root-owned `/usr/local/sbin/deploy-custom-for-all` command with a full Git commit ID.

The server fetches that exact public commit directly from GitHub. Static files are installed as a new release and activated with an atomic symlink. Backend source changes are built with a separately installed, root-owned Dockerfile, and the service uses a root-owned copy of `deploy/compose.production.yaml` from `/etc/custom-for-all`. Repository changes therefore cannot weaken the container configuration. The form container must become healthy before the public release is switched. A failed backend deployment restores the previous image and release.

`deploy/server-deploy.sh` is the reviewed source for the server command. Editing it in Git does not alter the installed root-owned copy; server-side deployment logic must be reviewed and installed separately.

The runner service hardening is tracked in `deploy/cfa-runner-service.conf`. It makes the operating system read-only to the runner except for its own work directory and this site's release directories. It also blocks the runner from the VPS itself, private networks, and provider metadata while retaining the local DNS stub and public GitHub access. `deploy/cfa-runner-sudoers` permits privilege escalation only through the fixed deployment command; the command validates its single commit argument before doing any work.
