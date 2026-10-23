<?php

/** Root-only installation helper; never invoked by the web application. */
if (PHP_SAPI !== 'cli' || !function_exists('posix_geteuid') || posix_geteuid() !== 0) {
    http_response_code(403);
    exit("Run configure-https.php as root from the command line.\n");
}

require_once __DIR__.'/../lib/services/Services_LocalHttps.php';

try {
    $documentRoot = $argv[1] ?? '';
    if (!in_array($documentRoot, ['/opt/spotweb', '/var/www/html'], true)) {
        throw new RuntimeException('Supply the native or Docker application directory.');
    }
    $port = filter_var(getenv('SPOTWEB_HTTPS_PORT') ?: 443, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
    if ($port === false) {
        throw new RuntimeException('SPOTWEB_HTTPS_PORT must be a valid externally published port.');
    }
    $names = ['localhost', 'spotweb', '127.0.0.1', '::1', gethostname()];
    // Fixed command, no request data: include native guest addresses in the certificate.
    exec('hostname -I', $addresses, $status);
    if ($status === 0) {
        $names = array_merge($names, preg_split('/\s+/', trim(implode(' ', $addresses))));
    }
    $names = array_merge($names, explode(',', getenv('SPOTWEB_TLS_NAMES') ?: ''));
    Services_LocalHttps::ensureCertificates('/etc/spotweb/tls', $names);
    $config = Services_LocalHttps::apacheConfig($documentRoot, '/etc/spotweb/tls');
    if (file_put_contents('/etc/apache2/sites-available/spotweb-https.conf', $config) === false ||
        file_put_contents('/etc/apache2/conf-available/spotweb-https-info.conf', "SetEnv SPOTWEB_HTTPS_PORT $port\n") === false) {
        throw new RuntimeException('Cannot write Apache HTTPS configuration.');
    }
    echo "Local HTTPS configured on container port 443 (published port $port).\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'HTTPS configuration failed: '.$error->getMessage()."\n");
    exit(1);
}
