<?php

require_once __DIR__.'/../lib/services/Services_LocalHttps.php';

function check($condition, $message)
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$directory = sys_get_temp_dir().'/spotweb-https-test-'.bin2hex(random_bytes(8));
try {
    $names = ['localhost', 'spotweb', '192.0.2.10', '::1'];
    Services_LocalHttps::ensureCertificates($directory, $names);
    $ca = file_get_contents($directory.'/ca.crt');
    $certificate = file_get_contents($directory.'/server.crt');
    $details = openssl_x509_parse($certificate);
    check(openssl_x509_verify($certificate, openssl_pkey_get_public($ca)) === 1, 'Server must be signed by its installation CA');
    check(openssl_x509_check_private_key($certificate, file_get_contents($directory.'/server.key')), 'Server key must match');
    check($details['extensions']['basicConstraints'] === 'CA:FALSE', 'Server must not be a CA');
    check(strpos($details['extensions']['subjectAltName'], 'IP Address:192.0.2.10') !== false, 'LAN IP SAN missing');
    check(strpos($details['extensions']['subjectAltName'], 'DNS:localhost') !== false, 'Hostname SAN missing');
    check(strpos($ca, 'PRIVATE KEY') === false, 'Public download must not contain a private key');
    if (DIRECTORY_SEPARATOR === '/') {
        check((fileperms($directory.'/ca.key') & 0777) === 0600, 'CA private key permissions');
        check((fileperms($directory.'/server.key') & 0777) === 0600, 'Server private key permissions');
    }
    Services_LocalHttps::ensureCertificates($directory, array_reverse($names));
    check(file_get_contents($directory.'/ca.crt') === $ca, 'Restart must preserve CA trust');
    check(file_get_contents($directory.'/server.crt') === $certificate, 'Unchanged names must preserve server certificate');
    Services_LocalHttps::ensureCertificates($directory, array_merge($names, ['192.0.2.20']));
    check(file_get_contents($directory.'/ca.crt') === $ca, 'New IP must preserve CA trust');
    check(file_get_contents($directory.'/server.crt') !== $certificate, 'New IP must regenerate server certificate');
    check(openssl_x509_verify(file_get_contents($directory.'/server.crt'), openssl_pkey_get_public($ca)) === 1, 'Renewed certificate must keep its CA');
    $options = ['config' => $directory.'/openssl.cnf', 'digest_alg' => 'sha256'];
    $serverKey = openssl_pkey_get_private(file_get_contents($directory.'/server.key'));
    $csr = openssl_csr_new(['commonName' => 'Spotweb3'], $serverKey, $options);
    $shortCertificate = openssl_csr_sign($csr, $ca, file_get_contents($directory.'/ca.key'), 2, $options + ['x509_extensions' => 'server'], 2);
    openssl_x509_export($shortCertificate, $shortPem);
    file_put_contents($directory.'/server.crt', $shortPem);
    Services_LocalHttps::ensureCertificates($directory, array_merge($names, ['192.0.2.20']));
    $renewed = openssl_x509_parse(file_get_contents($directory.'/server.crt'));
    check($renewed['validTo_time_t'] > time() + 300 * 86400, 'Expiring certificate must be renewed');
    check(file_get_contents($directory.'/ca.crt') === $ca, 'Scheduled renewal must preserve client trust');
    try {
        Services_LocalHttps::ensureCertificates($directory, ["localhost\n[ca]\nbasicConstraints=CA:TRUE"]);
        throw new RuntimeException('Invalid certificate hostname accepted');
    } catch (InvalidArgumentException $expected) {
        // Input must not be able to inject OpenSSL configuration.
    }
    unlink($directory.'/ca.key');
    try {
        Services_LocalHttps::ensureCertificates($directory, $names);
        throw new RuntimeException('Missing CA key silently replaced trust');
    } catch (RuntimeException $expected) {
        check(strpos($expected->getMessage(), 'Incomplete local certificate authority') !== false, 'Incomplete CA should fail closed');
    }
    echo "Local HTTPS certificate tests passed.\n";
} finally {
    foreach (glob($directory.'/*') ?: [] as $file) {
        unlink($file);
    }
    if (is_dir($directory)) {
        if (is_file($directory.'/.lock')) {
            unlink($directory.'/.lock');
        }
        rmdir($directory);
    }
}
