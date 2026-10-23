FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --ignore-platform-reqs --prefer-dist

FROM php:8.3-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpng-dev libjpeg-dev libfreetype6-dev libzip-dev libpq-dev libicu-dev libxml2-dev locales \
 && docker-php-ext-configure gd --with-jpeg --with-freetype \
 && docker-php-ext-install -j"$(nproc)" gd zip gettext intl pdo_mysql pdo_pgsql sockets \
 && printf 'nl_NL.UTF-8 UTF-8\nde_DE.UTF-8 UTF-8\nfr_FR.UTF-8 UTF-8\ntr_TR.UTF-8 UTF-8\nen_US.UTF-8 UTF-8\n' > /etc/locale.gen \
 && locale-gen \
 && a2enmod rewrite proxy proxy_http proxy_wstunnel \
 && printf 'ProxyPass /nntp-relay-ws ws://127.0.0.1:8089/\nProxyPassReverse /nntp-relay-ws ws://127.0.0.1:8089/\n' > /etc/apache2/conf-available/spotweb-nntp-relay.conf \
 && a2enconf spotweb-nntp-relay \
 && rm -rf /var/lib/apt/lists/*

ENV SPOTWEB_DATA_DIR=/data
WORKDIR /var/www/html
COPY . .
COPY --from=vendor /app/vendor ./vendor
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
RUN composer dump-autoload --classmap-authoritative --no-dev \
 && rm /usr/local/bin/composer \
 && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && printf 'memory_limit=512M\nexpose_php=Off\n' > "$PHP_INI_DIR/conf.d/spotweb.ini" \
 && sed -ri 's!AllowOverride None!AllowOverride All!' /etc/apache2/apache2.conf \
 && mkdir -p /data && chown -R www-data:www-data /data

VOLUME /data /etc/spotweb/tls
EXPOSE 80 443
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/spotweb-entrypoint
ENTRYPOINT ["spotweb-entrypoint"]
CMD ["apache2-foreground"]
HEALTHCHECK --interval=60s --timeout=5s CMD curl -fs http://127.0.0.1/ >/dev/null || exit 1
