#!/bin/sh
set -e

: "${SPOTWEB_DATA_DIR:=/data}"
export SPOTWEB_DATA_DIR
mkdir -p "$SPOTWEB_DATA_DIR/cache"
chown -R www-data:www-data "$SPOTWEB_DATA_DIR"

php /var/www/html/bin/configure-https.php /var/www/html
a2enmod ssl >/dev/null
a2enconf spotweb-https-info >/dev/null
a2ensite spotweb-https >/dev/null

# Keep the one-year server certificate valid without changing the trusted CA.
(
    while sleep 86400; do
        if php /var/www/html/bin/configure-https.php /var/www/html; then
            apache2ctl -k graceful || true
        fi
    done
) &

# Run init as www-data so the SQLite file and cache have the right owner.
su -s /bin/sh www-data -c "php /var/www/html/bin/docker-init.php"

# Built-in WebSocket NNTP Relay daemon (supervised on 127.0.0.1:8089)
(
    while true; do
        su -s /bin/sh www-data -c "php /var/www/html/bin/nntp-relay.php --host=127.0.0.1 --port=8089" || true
        sleep 2
    done
) &

# Read the saved Admin Center interval on every tick. Manual-only still accepts
# Refresh requests. SPOTWEB_RETRIEVE_INTERVAL supplies the initial default.
(
    while true; do
        su -s /bin/sh www-data -c "php /var/www/html/bin/retrieve-scheduler.php" || true
        sleep 5
    done
) &

exec "$@"
