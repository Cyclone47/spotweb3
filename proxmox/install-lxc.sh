#!/usr/bin/env bash
# Run inside a fresh, dedicated Debian 12/13 LXC as root.
set -Eeuo pipefail

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NO_START=0
DRY_RUN=0
usage() {
    cat <<'EOF'
Usage: bash proxmox/install-lxc.sh [--source DIRECTORY] [--no-start] [--dry-run]
Installs this source tree natively into a dedicated Debian 12/13 container.
Application: /opt/spotweb; persistent database/cache: /var/lib/spotweb.
--no-start installs and enables services without starting them (image testing).
--dry-run prints the plan without changing the system.
EOF
}
while (($#)); do
    case "$1" in
        --source) SOURCE="$(realpath -- "${2:?Missing source directory}")"; shift 2 ;;
        --no-start) NO_START=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done
[[ -f "$SOURCE/index.php" && -f "$SOURCE/composer.lock" && -f "$SOURCE/bin/retrieve-scheduler.php" ]] || {
    echo 'A complete Spotweb source tree is required.' >&2; exit 1;
}
if ((DRY_RUN)); then
    usage
    printf '\nSource: %s\nInstall Apache/PHP/Composer from Debian packages.\nConfigure the localhost WebSocket relay, systemd service and retrieval timer.\nRun first-boot database initialization and open the setup wizard.\n' "$SOURCE"
    exit 0
fi
[[ $EUID == 0 ]] || { echo 'Run as root inside the LXC.' >&2; exit 1; }
[[ ! -d /etc/pve ]] || { echo 'Run install-lxc.sh inside the LXC, not on the Proxmox host.' >&2; exit 1; }
# shellcheck source=/etc/os-release
source /etc/os-release
[[ "$ID" == debian && "$VERSION_ID" =~ ^(12|13)$ ]] || {
    echo 'Supported guest systems: Debian 12 and Debian 13.' >&2; exit 1;
}
if ((!NO_START)); then
    [[ -d /run/systemd/system ]] || { echo 'A running systemd guest is required.' >&2; exit 1; }
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends apache2 libapache2-mod-php php-cli php-common \
    php-curl php-mbstring php-xml php-zip php-gd php-intl php-sqlite3 php-mysql php-pgsql \
    composer ca-certificates locales rsync unzip systemd

# Stop our services before updating code; the persistent data directory is retained.
if ((!NO_START)); then
    systemctl stop spotweb-retriever.timer spotweb-retriever.service spotweb-nntp-relay.service 2>/dev/null || true
    systemctl stop apache2
fi
install -d -m 0755 /opt/spotweb
if [[ "$SOURCE" != /opt/spotweb ]]; then
    rsync -a --exclude='/.git/' --exclude='/vendor/' --exclude='/data/' --exclude='/cache/' \
        --exclude='/dist/' --exclude='.env*' --exclude='.rnd' --exclude='*.sqlite*' \
        --exclude='dbsettings.inc.php' --exclude='ownsettings.php' "$SOURCE/" /opt/spotweb/
fi
cd /opt/spotweb
COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --prefer-dist --no-scripts --no-plugins --classmap-authoritative
composer check-platform-reqs --no-dev
chown -R root:www-data /opt/spotweb
chmod -R u=rwX,g=rX,o=rX /opt/spotweb
install -d -o www-data -g www-data -m 0750 /var/lib/spotweb /var/lib/spotweb/cache /var/lib/spotweb/tmp
install -d -m 0755 /etc/spotweb
if [[ ! -f /etc/spotweb/spotweb.env ]]; then
    cat > /etc/spotweb/spotweb.env <<'EOF'
SPOTWEB_DATA_DIR=/var/lib/spotweb
SPOTWEB_RETRIEVE_INTERVAL=900
TMPDIR=/var/lib/spotweb/tmp
EOF
    chmod 0640 /etc/spotweb/spotweb.env
    chown root:www-data /etc/spotweb/spotweb.env
fi
# Apache may use systemd PrivateTmp. Put all relay/HTTP/retriever locks in one
# shared, service-owned directory instead of their separate /tmp namespaces.
if ! grep -q '^TMPDIR=' /etc/spotweb/spotweb.env; then
    printf '\nTMPDIR=/var/lib/spotweb/tmp\n' >> /etc/spotweb/spotweb.env
fi
# The same environment is used by Apache, initialization, the relay and scheduler.
cat > /etc/apache2/conf-available/spotweb-environment.conf <<'EOF'
PassEnv SPOTWEB_DATA_DIR SPOTWEB_RETRIEVE_INTERVAL TMPDIR
EOF
if ! grep -q '^# Spotweb environment$' /etc/apache2/envvars; then
    cat >> /etc/apache2/envvars <<'EOF'

# Spotweb environment
set -a
. /etc/spotweb/spotweb.env
set +a
EOF
fi
for sapi in apache2 cli; do
    php_version="$(php -r 'echo PHP_MAJOR_VERSION,".",PHP_MINOR_VERSION;')"
    cat > "/etc/php/$php_version/$sapi/conf.d/99-spotweb.ini" <<'EOF'
memory_limit=512M
expose_php=Off
EOF
done
for locale in en_US nl_NL de_DE fr_FR tr_TR; do
    sed -i "s/^# *\(${locale}\.UTF-8 UTF-8\)/\1/" /etc/locale.gen
done
locale-gen
cat > /etc/apache2/sites-available/spotweb.conf <<'EOF'
<VirtualHost *:80>
    ServerName spotweb
    DocumentRoot /opt/spotweb
    <Directory /opt/spotweb>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
    <DirectoryMatch "^/opt/spotweb/(bin|docker|proxmox|tests|vendor|lib|docs|\.git)(/|$)">
        Require all denied
    </DirectoryMatch>
    <FilesMatch "^(composer\.(json|lock)|.*\.(sqlite|sqlite3|env)|ownsettings\.php|dbsettings\.inc\.php)$">
        Require all denied
    </FilesMatch>
    ProxyPass /nntp-relay-ws ws://127.0.0.1:8089/
    ProxyPassReverse /nntp-relay-ws ws://127.0.0.1:8089/
    ErrorLog ${APACHE_LOG_DIR}/spotweb-error.log
    CustomLog ${APACHE_LOG_DIR}/spotweb-access.log combined
</VirtualHost>
EOF
a2enmod rewrite proxy proxy_http proxy_wstunnel
a2enconf spotweb-environment
a2dissite 000-default
a2ensite spotweb
php /opt/spotweb/bin/configure-https.php /opt/spotweb
a2enmod ssl
a2enconf spotweb-https-info
a2ensite spotweb-https
cat > /etc/systemd/system/spotweb-https-renew.service <<'EOF'
[Unit]
Description=Renew the Spotweb local HTTPS server certificate
After=apache2.service

[Service]
Type=oneshot
ExecStart=/usr/bin/php /opt/spotweb/bin/configure-https.php /opt/spotweb
ExecStartPost=/usr/sbin/apache2ctl -k graceful
UMask=0077
EOF
cat > /etc/systemd/system/spotweb-https-renew.timer <<'EOF'
[Unit]
Description=Check the Spotweb HTTPS certificate daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/spotweb-nntp-relay.service <<'EOF'
[Unit]
Description=Spotweb WebSocket to NNTP relay
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
EnvironmentFile=/etc/spotweb/spotweb.env
WorkingDirectory=/opt/spotweb
ExecStart=/usr/bin/php /opt/spotweb/bin/nntp-relay.php --host=127.0.0.1 --port=8089
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/spotweb-retriever.service <<'EOF'
[Unit]
Description=Spotweb retrieval scheduler tick
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=www-data
Group=www-data
EnvironmentFile=/etc/spotweb/spotweb.env
WorkingDirectory=/opt/spotweb
ExecStart=/usr/bin/php /opt/spotweb/bin/retrieve-scheduler.php
TimeoutStartSec=infinity
NoNewPrivileges=true
ProtectSystem=full
EOF
cat > /etc/systemd/system/spotweb-retriever.timer <<'EOF'
[Unit]
Description=Check the Spotweb retrieval schedule every five seconds

[Timer]
OnBootSec=15s
OnUnitInactiveSec=5s
AccuracySec=1s
Unit=spotweb-retriever.service

[Install]
WantedBy=timers.target
EOF
set -a
# shellcheck source=/dev/null
source /etc/spotweb/spotweb.env
set +a
runuser -u www-data --preserve-environment -- php /opt/spotweb/bin/docker-init.php
apache2ctl configtest
systemd-analyze verify /etc/systemd/system/spotweb-nntp-relay.service \
    /etc/systemd/system/spotweb-retriever.service /etc/systemd/system/spotweb-retriever.timer \
    /etc/systemd/system/spotweb-https-renew.service /etc/systemd/system/spotweb-https-renew.timer
systemctl enable apache2 spotweb-nntp-relay.service spotweb-retriever.timer spotweb-https-renew.timer
if ((!NO_START)); then
    systemctl daemon-reload
    systemctl restart apache2 spotweb-nntp-relay.service
    systemctl start spotweb-retriever.timer
    systemctl start spotweb-https-renew.timer
    systemctl is-active --quiet apache2 spotweb-nntp-relay.service spotweb-retriever.timer
fi
printf '\nInstalled Spotweb. Open http://<container-IP>/?page=setup to configure it.\n'
printf 'Persistent data: /var/lib/spotweb\nSchedule: Admin Center > Automatic spot retrieval\n'
printf 'HTTPS is available on port 443. The setup wizard explains the local certificate and checks browser download support.\n'
