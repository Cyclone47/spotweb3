<?php

/** Installation-time certificate generation. No secrets or commands come from HTTP. */
class Services_LocalHttps
{
    public static function ensureCertificates($directory, array $names)
    {
        $names = array_values(array_unique(array_filter(array_map('trim', $names))));
        $sans = [];
        foreach ($names as $name) {
            if (filter_var($name, FILTER_VALIDATE_IP)) {
                $sans[] = 'IP:'.$name;
            } elseif (preg_match('/\A[a-zA-Z0-9][a-zA-Z0-9.-]*\z/', $name)) {
                $sans[] = 'DNS:'.$name;
            } else {
                throw new InvalidArgumentException('Invalid certificate hostname or IP address.');
            }
        }
        sort($sans);
        if (!$sans) {
            throw new InvalidArgumentException('At least one certificate hostname is required.');
        }
        $oldMask = umask(0077);
        $lock = null;
        try {
            if (!is_dir($directory) && !mkdir($directory, 0755, true)) {
                throw new RuntimeException('Cannot create certificate directory.');
            }
            chmod($directory, 0755);
            $lock = fopen($directory.'/.lock', 'c');
            if (!$lock || !flock($lock, LOCK_EX)) {
                throw new RuntimeException('Cannot lock certificate directory.');
            }
            $config = "[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=".implode(',', $sans)."\n";
            self::write($directory.'/openssl.cnf', $config, 0600);
            $options = ['config' => $directory.'/openssl.cnf', 'digest_alg' => 'sha256', 'private_key_bits' => 2048];
            $caFile = $directory.'/ca.crt';
            $caKeyFile = $directory.'/ca.key';
            if (is_file($caFile) !== is_file($caKeyFile)) {
                throw new RuntimeException('Incomplete local certificate authority. Restore its certificate and key from backup.');
            }
            if (!is_file($caFile)) {
                $caKey = openssl_pkey_new($options);
                $caCsr = openssl_csr_new(['commonName' => 'Spotweb3 local CA '.bin2hex(random_bytes(4))], $caKey, $options);
                $ca = openssl_csr_sign($caCsr, null, $caKey, 3650, $options + ['x509_extensions' => 'ca'], random_int(1, PHP_INT_MAX));
                if (!$ca || !openssl_pkey_export($caKey, $keyPem) || !openssl_x509_export($ca, $certPem)) {
                    throw new RuntimeException('Cannot generate local certificate authority.');
                }
                self::write($caKeyFile, $keyPem, 0600);
                self::write($caFile, $certPem, 0644);
            }
            $ca = openssl_x509_read(file_get_contents($caFile));
            $caKey = openssl_pkey_get_private(file_get_contents($caKeyFile));
            if (!$ca || !$caKey || !openssl_x509_check_private_key($ca, $caKey)) {
                throw new RuntimeException('Invalid local certificate authority.');
            }
            chmod($caKeyFile, 0600);
            $serverFile = $directory.'/server.crt';
            $serverKeyFile = $directory.'/server.key';
            $signature = hash('sha256', implode(',', $sans));
            $oldCertificate = is_file($serverFile) ? openssl_x509_parse(file_get_contents($serverFile)) : false;
            if ($oldCertificate && ($oldCertificate['validTo_time_t'] ?? 0) > time() + 30 * 86400 &&
                is_file($serverKeyFile) && @file_get_contents($directory.'/names.sha256') === $signature &&
                openssl_x509_check_private_key(file_get_contents($serverFile), file_get_contents($serverKeyFile)) &&
                openssl_x509_verify(file_get_contents($serverFile), openssl_pkey_get_public($ca)) === 1) {
                chmod($serverKeyFile, 0600);

                return;
            }
            $serverKey = openssl_pkey_new($options);
            $csr = openssl_csr_new(['commonName' => 'Spotweb3'], $serverKey, $options);
            $cert = openssl_csr_sign($csr, $ca, $caKey, 365, $options + ['x509_extensions' => 'server'], random_int(1, PHP_INT_MAX));
            if (!$cert || !openssl_pkey_export($serverKey, $keyPem) || !openssl_x509_export($cert, $certPem)) {
                throw new RuntimeException('Cannot generate HTTPS server certificate.');
            }
            self::write($serverKeyFile, $keyPem, 0600);
            self::write($serverFile, $certPem, 0644);
            self::write($directory.'/names.sha256', $signature, 0600);
        } finally {
            if (is_resource($lock)) {
                fclose($lock);
            }
            umask($oldMask);
        }
    }

    private static function write($path, $contents, $mode)
    {
        if (file_put_contents($path, $contents, LOCK_EX) === false || !chmod($path, $mode)) {
            throw new RuntimeException('Cannot write certificate material.');
        }
    }

    public static function apacheConfig($documentRoot, $directory)
    {
        // Called by the root-only CLI with fixed installation paths.
        if (!in_array($documentRoot, ['/opt/spotweb', '/var/www/html'], true) || $directory !== '/etc/spotweb/tls') {
            throw new InvalidArgumentException('Unexpected installation path.');
        }

        return <<<CONF
<VirtualHost *:443>
    ServerName spotweb
    DocumentRoot $documentRoot
    SSLEngine on
    SSLProtocol -all +TLSv1.2 +TLSv1.3
    SSLCertificateFile $directory/server.crt
    SSLCertificateKeyFile $directory/server.key
    <Directory $documentRoot>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
    <DirectoryMatch "^$documentRoot/(bin|docker|proxmox|tests|vendor|lib|docs|\\.git)(/|$)">
        Require all denied
    </DirectoryMatch>
    <FilesMatch "^(composer\\.(json|lock)|.*\\.(sqlite|sqlite3|env|key)|ownsettings\\.php|dbsettings\\.inc\\.php)$">
        Require all denied
    </FilesMatch>
    ProxyPass /nntp-relay-ws ws://127.0.0.1:8089/
    ProxyPassReverse /nntp-relay-ws ws://127.0.0.1:8089/
</VirtualHost>

CONF;
    }
}
