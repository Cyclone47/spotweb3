<?php
// Run with: php tests/integration/nntp-relay-io.php [repository root]
// No provider credentials, database, or running relay are used.
$root = $argv[1] ?? dirname(__DIR__, 2);
require_once $root.'/vendor/autoload.php';
require_once $root.'/lib/page/SpotPage_Abs.php';
require_once $root.'/lib/page/SpotPage_nntprelay.php';
require_once $root.'/lib/services/Nntp/Services_Nntp_RelayUpstream.php';
$source = file_get_contents($root.'/bin/nntp-relay.php');
$start = strpos($source, 'function encodeWsFrame(');
$end = strpos($source, '$serverSocket = @stream_socket_server(');
eval(substr($source, $start, $end - $start));
function check($condition, $message) {
    if (!$condition) throw new RuntimeException($message);
}

// A local certificate exercises real OpenSSL records and both TLS modes.
$key = openssl_pkey_new(['private_key_bits' => 2048]);
$csr = openssl_csr_new(['commonName' => 'localhost'], $key);
$cert = openssl_csr_sign($csr, null, $key, 1);
openssl_x509_export($cert, $certPem);
openssl_pkey_export($key, $keyPem);
$pem = tempnam(sys_get_temp_dir(), 'relay-test-cert-');
file_put_contents($pem, $certPem.$keyPem);

try {
    foreach ([false, 'tls', 'starttls', 'reject-tls'] as $mode) {
        $rejectTls = $mode === 'reject-tls';
        $wireMode = $rejectTls ? 'tls' : $mode;
        $context = stream_context_create(['ssl' => ['local_cert' => $pem]]);
        $listener = stream_socket_server('tcp://127.0.0.1:0', $errno, $error, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $context);
        stream_set_blocking($listener, false);
        $port = (int) substr(strrchr(stream_socket_get_name($listener, false), ':'), 1);
        $clients = [];
        $peers = [];
        $done = [];
        $started = microtime(true);
        for ($i = 0; $i < 4; $i++) {
            $clients[$i] = new Services_Nntp_RelayUpstream([
                'host' => '127.0.0.1', 'port' => $port, 'enc' => $wireMode,
                'verifyname' => $rejectTls, 'user' => 'fixture-user', 'pass' => 'fixture-pass',
            ], 5);
        }
        while (count($done) < 4 && microtime(true) - $started < 6) {
            while ($s = @stream_socket_accept($listener, 0)) {
                stream_set_blocking($s, false);
                $peers[] = ['socket' => $s, 'state' => $wireMode === 'tls' ? 'tls' : 'greeting', 'input' => '', 'output' => ''];
            }
            foreach ($peers as $i => &$peer) {
                if ($peer['state'] === 'tls') {
                    $ok = @stream_socket_enable_crypto($peer['socket'], true, STREAM_CRYPTO_METHOD_TLS_SERVER);
                    if ($ok === true) $peer['state'] = 'greeting';
                }
                if ($peer['state'] === 'greeting' && ($i !== 0 || microtime(true) - $started > 0.4)) {
                    $peer['output'] .= "200 fixture ready\r\n";
                    $peer['state'] = 'commands';
                }
                if ($peer['state'] === 'commands') {
                    $peer['input'] .= (string) @fread($peer['socket'], 8192);
                    while (($nl = strpos($peer['input'], "\n")) !== false) {
                        $line = trim(substr($peer['input'], 0, $nl));
                        $peer['input'] = substr($peer['input'], $nl + 1);
                        if ($line === 'STARTTLS') {
                            fwrite($peer['socket'], "382 negotiate TLS\r\n");
                            $peer['state'] = 'starttls';
                        } elseif ($line === 'AUTHINFO USER fixture-user') {
                            $peer['output'] .= "381 password required\r\n";
                        } elseif ($line === 'AUTHINFO PASS fixture-pass') {
                            $peer['output'] .= "281 authenticated\r\n";
                        } else {
                            throw new RuntimeException('Unexpected authentication command');
                        }
                    }
                }
                if ($peer['state'] === 'starttls') {
                    $ok = @stream_socket_enable_crypto($peer['socket'], true, STREAM_CRYPTO_METHOD_TLS_SERVER);
                    if ($ok === true) $peer['state'] = 'commands';
                }
                if ($peer['output'] !== '') {
                    // Deliberately fragment NNTP response lines.
                    $n = fwrite($peer['socket'], substr($peer['output'], 0, 7));
                    $peer['output'] = substr($peer['output'], $n);
                }
            }
            unset($peer);
            $read = []; $write = []; $except = null;
            foreach ($clients as $i => $client) {
                if (isset($done[$i])) continue;
                $read[] = $client->stream;
                if ($client->wantsWrite()) $write[] = $client->stream;
            }
            stream_select($read, $write, $except, 0, 1000);
            foreach ($clients as $i => $client) {
                if (isset($done[$i])) continue;
                try {
                    $client->tick(in_array($client->stream, $read, true), in_array($client->stream, $write, true));
                } catch (RuntimeException $e) {
                    if (!$rejectTls) throw $e;
                    check($e->getMessage() === 'NNTP TLS negotiation failed', 'Expected certificate rejection');
                    $done[$i] = microtime(true) - $started;
                }
                if ($rejectTls) check(!$client->ready, 'Untrusted certificate accepted');
                if ($client->ready) $done[$i] = microtime(true) - $started;
            }
        }
        check(count($done) === 4, 'All concurrent handshakes must complete');
        if (!$rejectTls) check($done[1] < $done[0], 'Slow greeting must not block other connections');
        foreach ($clients as $client) fclose($client->stream);
        foreach ($peers as $peer) fclose($peer['socket']);
        fclose($listener);
        echo $rejectTls ? "PASS untrusted TLS certificate rejected\n" : 'PASS concurrent '.($mode ?: 'plain').' authentication; slow greeting isolated'.PHP_EOL;
    }

    $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, 0);
    foreach ($pair as $s) stream_set_blocking($s, false);
    $expected = str_repeat('0123456789abcdef', 262144);
    $output = $expected;
    $start = microtime(true);
    for ($i = 0; $i < 30; $i++) check(flushRelayOutput($pair[0], $output), 'Nonblocking write failed');
    check(microtime(true) - $start < 0.5, 'Unread socket blocked the relay');
    check($output !== '', 'Fixture must apply backpressure');
    $received = '';
    while ($output !== '' || strlen($received) < strlen($expected)) {
        check(flushRelayOutput($pair[0], $output), 'Partial write failed');
        $received .= (string) fread($pair[1], 262144);
        check(microtime(true) - $start < 5, 'Partial write test timed out');
    }
    check(hash('sha256', $received) === hash('sha256', $expected), 'Partial write lost or duplicated bytes');
    foreach ($pair as $s) fclose($s);
    echo "PASS slow-reader backpressure and exact partial-write delivery\n";

    $client = ['pendingIds' => ['one@test', 'two@test'], 'nntpState' => 'status', 'nntpBuffer' => '', 'nntpSearchOffset' => 0, 'output' => ''];
    foreach (str_split("222 body\r\nabc\r\n.\r\n430 missing\r\n", 2) as $chunk) {
        $client['nntpBuffer'] .= $chunk;
        check(drainClientNntpBuffer($client), 'Fragmented article parse failed');
    }
    check($client['pendingIds'] === [], 'Fragmented article terminator was lost');
    $frames = [];
    while ($frame = decodeWsFrame($client['output'])) {
        $frames[] = $frame['payload'];
        $client['output'] = substr($client['output'], $frame['consumed']);
    }
    check(implode('', $frames) === SpotPage_nntprelay::encodeBinaryFrames([
        ['status' => 222, 'messageId' => 'one@test', 'body' => "abc\r\n"],
        ['status' => 430, 'messageId' => 'two@test', 'body' => ''],
    ]), 'Relay frame contents changed');
    echo "PASS fragmented article framing and missing article response\n";
} finally {
    unlink($pem);
}
