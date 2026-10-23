# Docker and Proxmox LXC installation

These instructions use the [Spotweb3 source](https://github.com/Cyclone47/spotweb3),
including its setup wizard, browser downloader, WebSocket relay and configurable
retrieval scheduler. A prebuilt image is not required; Docker builds from source.

## Readiness

| Deployment | Verification |
| --- | --- |
| Docker, PHP 8.3 + SQLite | Fresh image built; empty-database initialization, setup HTTP response, background relay, scheduler and container health checked. |
| Native Debian 13, PHP 8.4 + SQLite | Installer and repeat installation executed on a clean Debian filesystem; Apache served the setup wizard; relay discovery and scheduler checked. systemd units validated and enabled. |
| Proxmox host provisioning | Script syntax, ShellCheck and dry-run checked. Actual `pct create` and guest boot require a Proxmox host and were not exercised here. |
| Native Debian 12, PHP 8.2 + SQLite | Installer executed on a clean Debian filesystem; Apache served the setup wizard; relay, scheduler, browser assets and systemd unit validation checked. Actual LXC boot was not exercised. |

## Docker

From the repository directory, with Docker Engine/Desktop and Compose available:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 spotweb
```

Open `http://localhost:8080/` and finish the setup wizard. The SQLite database,
configuration and cache live in the persistent `spotweb-data` volume at `/data`.
The relay and retrieval scheduler start automatically. Choose the retrieval
interval in **Admin Center → Overview → Automatic spot retrieval**.

The Compose file builds the local Dockerfile; it does not pull a published
Spotweb image. Rebuild after changing application code:

```sh
docker compose up -d --build
```

`SPOTWEB_RETRIEVE_INTERVAL=900` supplies the initial interval. A value saved in
Admin Center takes precedence. Do not use `docker compose down -v` when you want
to retain the installation's data. The optional PostgreSQL profile requires the
database environment configuration described in `docker-compose.yml`; the checks
above cover the default SQLite setup.

When enabling PostgreSQL, set `SPOTWEB_DB_PASS` to your own password in an ignored
`.env` file and pass it to both services using the commented database configuration.
There is no shared default database password.

## Proxmox: native unprivileged LXC

The installer runs Apache and PHP directly inside Debian. Docker nesting is not
needed. Start with a dedicated **Debian 13, unprivileged** container, 2 CPU cores,
2 GB RAM and a 16 GB root disk; increase disk space as your index/cache grows.
The Proxmox container guide describes [unprivileged containers and their resource
settings](https://github.com/proxmox/pve-docs/blob/master/pct.adoc).

The guest needs internet access to Debian mirrors and Composer package sources.
Both paths below use the same source bundle so they include the local work.

### Create the source bundle on Windows

Run from this checkout:

```powershell
./bin/package-deployment.ps1
scp ./dist/spotweb-install.tar.gz root@YOUR_PROXMOX:/root/
scp ./proxmox/create-lxc.sh root@YOUR_PROXMOX:/root/
```

The archive excludes the root Composer `vendor` directory, Git history, `.env`
files, database configuration, SQLite databases and runtime data. It includes the
browser's bundled WebAssembly assets. Composer installs the locked PHP dependencies
inside the guest.

On Linux, create a bundle from a clean checkout instead:

```sh
git clone https://github.com/Cyclone47/spotweb3.git
cd spotweb3
git archive --format=tar.gz --prefix=./ -o /tmp/spotweb-install.tar.gz HEAD
scp /tmp/spotweb-install.tar.gz root@YOUR_PROXMOX:/root/
scp proxmox/create-lxc.sh root@YOUR_PROXMOX:/root/
```

### Option A: create and install from the Proxmox host

First download a Debian 13 template using the Proxmox **CT Templates** UI, or
inspect the available template names on the node:

```sh
pveam update
pveam available --section system
```

Use your actual downloaded template volume ID, storage, bridge and an unused
guest ID. The example is a template placeholder, not a specific release to download:

```sh
bash /root/create-lxc.sh \
  --id 120 \
  --template 'local:vztmpl/REPLACE_WITH_DOWNLOADED_DEBIAN_13_TEMPLATE.tar.zst' \
  --storage local-lvm \
  --bridge vmbr0 \
  --archive /root/spotweb-install.tar.gz
```

Add `--dry-run` to inspect the creation command without changing the host.
Optional flags: `--hostname spotweb --memory 2048 --cores 2 --disk 16` and
`--ssh-key /root/.ssh/id_ed25519.pub`.

The script checks that the guest ID is unused, creates an unprivileged container
with DHCP, waits for DNS, transfers the source and runs the native installer.
It leaves a partially installed container available for inspection if anything
fails. Without an SSH key, use the Proxmox console or `pct enter 120` to administer
the guest. No SSH password is generated or printed.

### Option B: use an existing fresh Debian container

Create a dedicated Debian 13 LXC in the Proxmox UI and start it. On the Proxmox node:

```sh
pct push 120 /root/spotweb-install.tar.gz /root/spotweb-install.tar.gz
pct exec 120 -- mkdir -p /root/spotweb-source
pct exec 120 -- tar -xzf /root/spotweb-install.tar.gz -C /root/spotweb-source
pct exec 120 -- bash /root/spotweb-source/proxmox/install-lxc.sh
pct exec 120 -- hostname -I
```

Replace `120` with your container ID. The installer must run **inside the guest**;
it refuses to run directly on a Proxmox host. It configures a dedicated Apache
site on port 80 and disables Debian's default site, so use a container dedicated
to Spotweb.

Open `http://CONTAINER_IP/?page=setup` to finish onboarding. The installer does
not embed a default application password or your Usenet credentials.

### HTTPS for browser downloads

Normal browsing and setup work over LAN HTTP. **Download in browser needs HTTPS
when used from another computer**, because the browser's directory picker requires
a [secure context](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
The localhost exception used on your current machine does not apply to a remote
container's LAN IP.

Use your existing HTTPS reverse proxy with a certificate trusted by your browser.
Forward traffic to the guest's port 80, including WebSocket upgrades on
`/nntp-relay-ws`. The native Apache site forwards that path to the relay bound only
to `127.0.0.1:8089`; port 8089 does not need external exposure. Downloaded payloads
are written by the browser to the folder selected on the client computer.

### Services and data

| Item | Location/name |
| --- | --- |
| Application code | `/opt/spotweb` |
| SQLite database and cache | `/var/lib/spotweb` |
| Shared relay/retriever lock directory | `/var/lib/spotweb/tmp` |
| Shared environment | `/etc/spotweb/spotweb.env` |
| Web server | `apache2.service` |
| Persistent WebSocket relay | `spotweb-nntp-relay.service` |
| Scheduler | `spotweb-retriever.timer` and `spotweb-retriever.service` |

```sh
systemctl status apache2 spotweb-nntp-relay spotweb-retriever.timer
journalctl -u spotweb-nntp-relay -u spotweb-retriever --since today
tail -50 /var/lib/spotweb/cache/retriever-last.log
```

The timer checks the saved schedule every five seconds. Actual Usenet retrieval
uses the interval selected in Admin Center, including manual-only mode. The shared
temporary directory allows Apache and systemd services to see the same relay
liveness and connection-limit locks even if Apache uses a private `/tmp`.

For application updates, transfer/extract the new source bundle and run
`proxmox/install-lxc.sh` again. It stops the application services while updating,
installs locked dependencies, upgrades the schema, preserves `/var/lib/spotweb`
and the existing environment file, then restarts the services. Take a Proxmox
backup/snapshot before application/database upgrades. Guest root-disk data is
included in normal Proxmox backups; added bind mounts have separate backup rules.

Browser jobs/checkpoints are stored in the client browser, per website origin,
and are not part of the server database backup.
