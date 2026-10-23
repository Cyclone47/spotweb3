#!/usr/bin/php
<?php

/**
 * Spotweb Standalone WebSocket-to-NNTP Relay Daemon (`bin/nntp-relay.php`)
 *
 * Provides a long-lived event-loop WebSocket server for the Spotweb Browser
 * Download Engine outside normal PHP-FPM/Apache request workers.
 *
 * Security invariants enforced:
 * 1. Authenticates every WebSocket connection using short-lived HMAC-SHA256
 *    relay tokens issued by `SpotPage_nntprelay` (`?page=nntprelay&action=descriptor`),
 *    which require `SpotSecurity::spotsec_retrieve_nzb`.
 * 2. Never accepts upstream host/port/TLS parameters from the client; connects
 *    strictly to Spotweb's configured `nntp_nzb` (or fallback `nntp_hdr`) server.
 * 3. Validates upstream TLS certificates (`verify_peer` + `verify_peer_name`).
 * 4. Authenticates to upstream Usenet on the server side (`AUTHINFO USER/PASS`)
 *    without ever exposing NNTP credentials to the browser.
 * 5. Enforces per-user and per-provider concurrent WebSocket connection limits.
 * 6. Restricts client commands strictly to `BODY <message-id>` article fetches
 *    with strict Message-ID sanitization (no CRLF/command injection).
 *
 * Usage:
 *   php bin/nntp-relay.php [--host=127.0.0.1] [--port=8089]
 */

error_reporting(2147483647);
ini_set('memory_limit', '512M');

require_once __DIR__.'/../vendor/autoload.php';
require_once __DIR__.'/../lib/page/SpotPage_Abs.php';
require_once __DIR__.'/../lib/page/SpotPage_nntprelay.php';
require_once __DIR__.'/../lib/services/Nntp/Services_Nntp_ConnectionLimit.php';
require_once __DIR__.'/../lib/services/Nntp/Services_Nntp_RelayUpstream.php';

SpotCommandline::initialize(
    ['host', 'port'],
    ['host' => '127.0.0.1', 'port' => 8089]
);

if (!SpotCommandline::isCommandline()) {
    exit('nntp-relay.php can only be run from the console, it cannot be run from the web browser'.PHP_EOL);
}

$listenHost = SpotCommandline::get('host') ?: '127.0.0.1';
$listenPort = (int) (SpotCommandline::get('port') ?: 8089);

/**
 * Loads fresh Spotweb settings from the database so runtime changes to
 * `nntp_max_connections` or NNTP server credentials take effect on new connections.
 *
 * @return Services_Settings_Container
 */
function loadFreshRelaySettings()
{
    $container = new ReflectionClass(Services_Settings_Container::class);
    foreach (['_instance' => null, '_settings' => [], '_sources' => []] as $propertyName => $value) {
        $property = $container->getProperty($propertyName);
        $property->setAccessible(true);
        $property->setValue(null, $value);
    }
    $bootstrap = new Bootstrap();
    $daoFactory = $bootstrap->getDaoFactory();

    return $bootstrap->getSettings($daoFactory, false);
}

/**
 * Encodes a payload as an RFC 6455 server-to-client WebSocket frame (unmasked).
 *
 * @param string $payload
 * @param int    $opcode  0x01 = text, 0x02 = binary, 0x08 = close, 0x09 = ping, 0x0A = pong
 *
 * @return string
 */
function encodeWsFrame($payload, $opcode = 0x02)
{
    $len = strlen($payload);
    $firstByte = chr(0x80 | ($opcode & 0x0F));

    if ($len <= 125) {
        return $firstByte.chr($len).$payload;
    } elseif ($len <= 65535) {
        return $firstByte.chr(126).pack('n', $len).$payload;
    } else {
        $hi = ($len >> 32) & 0xFFFFFFFF;
        $lo = $len & 0xFFFFFFFF;

        return $firstByte.chr(127).pack('NN', $hi, $lo).$payload;
    }
}

/**
 * Attempts to decode one complete RFC 6455 client-to-server frame from `$buffer`.
 * Returns `null` if more bytes are needed, or `['opcode' => int, 'payload' => string, 'consumed' => int]`.
 *
 * @param string $buffer
 *
 * @return array|null
 */
function decodeWsFrame($buffer)
{
    $bufLen = strlen($buffer);
    if ($bufLen < 2) {
        return null;
    }

    $b0 = ord($buffer[0]);
    $b1 = ord($buffer[1]);
    $opcode = $b0 & 0x0F;
    $masked = ($b1 & 0x80) !== 0;
    $payloadLen = $b1 & 0x7F;
    $offset = 2;

    if ($payloadLen === 126) {
        if ($bufLen < 4) {
            return null;
        }
        $unpacked = unpack('nlen', substr($buffer, 2, 2));
        $payloadLen = $unpacked['len'];
        $offset = 4;
    } elseif ($payloadLen === 127) {
        if ($bufLen < 10) {
            return null;
        }
        $unpacked = unpack('Nhi/Nlo', substr($buffer, 2, 8));
        $payloadLen = ($unpacked['hi'] << 32) | $unpacked['lo'];
        $offset = 10;
    }

    $maskKey = '';
    if ($masked) {
        if ($bufLen < $offset + 4) {
            return null;
        }
        $maskKey = substr($buffer, $offset, 4);
        $offset += 4;
    }

    if ($bufLen < $offset + $payloadLen) {
        return null;
    }

    $payload = substr($buffer, $offset, $payloadLen);
    if ($masked && $payloadLen > 0) {
        $repeatedMask = str_repeat($maskKey, (int) ceil($payloadLen / 4));
        $payload = $payload ^ substr($repeatedMask, 0, $payloadLen);
    }

    return [
        'opcode'   => $opcode,
        'payload'  => $payload,
        'consumed' => $offset + $payloadLen,
    ];
}

/** Flush one bounded slice; a slow peer must never stall other clients. */
function flushRelayOutput($stream, &$bytes)
{
    if ($bytes === '') return true;
    $written = @fwrite($stream, substr($bytes, 0, 262144));
    if ($written === false || feof($stream)) return false;
    $bytes = (string) substr($bytes, $written);
    return true;
}

/**
 * Incrementally parses any complete NNTP responses in `$client['nntpBuffer']`
 * and sends completed binary frames back over the client WebSocket immediately.
 *
 * @param array $client
 * @param bool  $isEof
 *
 * @return bool True if client connection remains healthy, false if it should be closed.
 */
function drainClientNntpBuffer(array &$client, $isEof = false)
{
    $completedFrames = [];

    while (!empty($client['pendingIds'])) {
        if ($client['nntpState'] === 'status') {
            $nlPos = strpos($client['nntpBuffer'], "\n");
            if ($nlPos === false) {
                break;
            }
            $statusLine = rtrim(substr($client['nntpBuffer'], 0, $nlPos), "\r");
            $client['nntpBuffer'] = substr($client['nntpBuffer'], $nlPos + 1);
            $statusCode = (int) substr($statusLine, 0, 3);

            if ($statusCode === 222 || $statusCode === 220) {
                $client['nntpState'] = 'body';
                $client['nntpSearchOffset'] = 0;
            } elseif ($statusCode === 430 || $statusCode === 423) {
                $msgId = array_shift($client['pendingIds']);
                $completedFrames[] = [
                    'status'    => 430,
                    'messageId' => $msgId,
                    'body'      => '',
                ];
            } else {
                return false;
            }
        }

        if ($client['nntpState'] === 'body') {
            $bufLen = strlen($client['nntpBuffer']);
            if ($bufLen < 3 && !$isEof) {
                break;
            }

            if (strncmp($client['nntpBuffer'], ".\r\n", 3) === 0) {
                $client['nntpBuffer'] = substr($client['nntpBuffer'], 3);
                $msgId = array_shift($client['pendingIds']);
                $completedFrames[] = [
                    'status'    => 222,
                    'messageId' => $msgId,
                    'body'      => '',
                ];
                $client['nntpState'] = 'status';
                $client['nntpSearchOffset'] = 0;
                continue;
            }
            if (strncmp($client['nntpBuffer'], ".\n", 2) === 0) {
                $client['nntpBuffer'] = substr($client['nntpBuffer'], 2);
                $msgId = array_shift($client['pendingIds']);
                $completedFrames[] = [
                    'status'    => 222,
                    'messageId' => $msgId,
                    'body'      => '',
                ];
                $client['nntpState'] = 'status';
                $client['nntpSearchOffset'] = 0;
                continue;
            }

            $searchOffset = $client['nntpSearchOffset'];
            $termPos = strpos($client['nntpBuffer'], "\r\n.\r\n", $searchOffset);
            $termLen = 5;
            if ($termPos === false) {
                $termPos = strpos($client['nntpBuffer'], "\n.\n", $searchOffset);
                $termLen = 3;
            }

            if ($termPos !== false) {
                $rawBody = substr($client['nntpBuffer'], 0, $termPos + ($termLen === 5 ? 2 : 1));
                $client['nntpBuffer'] = substr($client['nntpBuffer'], $termPos + $termLen);
                $msgId = array_shift($client['pendingIds']);
                $completedFrames[] = [
                    'status'    => 222,
                    'messageId' => $msgId,
                    'body'      => $rawBody,
                ];
                $client['nntpState'] = 'status';
                $client['nntpSearchOffset'] = 0;
                continue;
            }

            $client['nntpSearchOffset'] = max(0, $bufLen - 6);
            break;
        }
    }

    if (!empty($completedFrames)) {
        $binaryBatch = SpotPage_nntprelay::encodeBinaryFrames($completedFrames);
        $client['output'] .= encodeWsFrame($binaryBatch, 0x02);
    }

    return true;
}

$serverSocket = @stream_socket_server(
    "tcp://{$listenHost}:{$listenPort}",
    $errno,
    $errstr,
    STREAM_SERVER_BIND | STREAM_SERVER_LISTEN
);

if (!is_resource($serverSocket)) {
    fwrite(STDERR, "[nntp-relay] Failed to bind tcp://{$listenHost}:{$listenPort}: [{$errno}] {$errstr}\n");
    exit(1);
}

// Acquire daemon liveness lock so SpotPage_nntprelay knows the WebSocket relay is active
$daemonLockFp = @fopen(SpotPage_nntprelay::getWsRelayLockPath(), 'c+');
if (is_resource($daemonLockFp)) {
    @flock($daemonLockFp, LOCK_EX | LOCK_NB);
    @ftruncate($daemonLockFp, 0);
    @fwrite($daemonLockFp, (string) getmypid());
    @fflush($daemonLockFp);
}

stream_set_blocking($serverSocket, false);
echo "[nntp-relay] Listening on ws://{$listenHost}:{$listenPort}\n";

/** @var array<int, array> $clients */
$clients = [];
/** @var array<int, int> $userConnectionCounts */
$userConnectionCounts = [];

function closeClient(&$clients, &$userConnectionCounts, $clientId)
{
    if (!isset($clients[$clientId])) {
        return;
    }
    $client = $clients[$clientId];
    if (!empty($client['userId']) && isset($userConnectionCounts[$client['userId']])) {
        $userConnectionCounts[$client['userId']] = max(0, $userConnectionCounts[$client['userId']] - 1);
    }
    if (!empty($client['nntpSocket']) && is_resource($client['nntpSocket'])) {
        @fwrite($client['nntpSocket'], "QUIT\r\n");
        @fclose($client['nntpSocket']);
    }
    if (!empty($client['providerSlot'])) {
        SpotPage_nntprelay::releaseUserConnectionSlot($client['providerSlot']);
    }
    if (!empty($client['socket']) && is_resource($client['socket'])) {
        @fclose($client['socket']);
    }
    unset($clients[$clientId]);
}

while (true) {
    $readSockets = [$serverSocket];
    $writeSockets = [];
    foreach ($clients as $c) {
        $readSockets[] = $c['socket'];
        if ($c['output'] !== '') $writeSockets[] = $c['socket'];
        if ($c['upstream'] !== null && !$c['handshaked']) {
            $readSockets[] = $c['nntpSocket'];
            if ($c['upstream']->wantsWrite()) $writeSockets[] = $c['nntpSocket'];
        } elseif ($c['handshaked'] && is_resource($c['nntpSocket'])) {
            // Apply backpressure before buffering more article data for a slow browser.
            if (!empty($c['pendingIds']) && strlen($c['output']) < 4194304) {
                $readSockets[] = $c['nntpSocket'];
            }
            if ($c['nntpOutput'] !== '') $writeSockets[] = $c['nntpSocket'];
        }
    }
    $exceptSockets = null;

    $ready = @stream_select($readSockets, $writeSockets, $exceptSockets, 0, 50000);
    if ($ready === false) {
        continue;
    }

    if (in_array($serverSocket, $readSockets, true)) {
        while (($newSock = @stream_socket_accept($serverSocket, 0)) !== false) {
            if (is_resource($newSock)) {
                stream_set_blocking($newSock, false);
                if (function_exists('socket_import_stream')) {
                    $tcpSocket = @socket_import_stream($newSock);
                    if ($tcpSocket !== false) @socket_set_option($tcpSocket, SOL_TCP, TCP_NODELAY, 1);
                }
                $id = (int) $newSock;
                $clients[$id] = [
                    'id'               => $id,
                    'socket'           => $newSock,
                    'handshaked'       => false,
                    'buffer'           => '',
                    'output'           => '',
                    'nntpOutput'       => '',
                    'upstream'         => null,
                    'upgradeResponse'  => '',
                    'acceptedAt'       => microtime(true),
                    'userId'           => null,
                    'maxConns'         => 4,
                    'nntpSocket'       => null,
                    'nntpBuffer'       => '',
                    'nntpState'        => 'status',
                    'nntpSearchOffset' => 0,
                    'pendingIds'       => [],
                    'providerSlot'     => null,
                ];
            }
        }
    }

    foreach (array_keys($clients) as $clientId) {
        if (!isset($clients[$clientId])) {
            continue;
        }
        $client = &$clients[$clientId];

        if (!$client['handshaked'] && microtime(true) - $client['acceptedAt'] > 20) {
            unset($client);
            closeClient($clients, $userConnectionCounts, $clientId);
            continue;
        }
        if (in_array($client['socket'], $writeSockets, true) &&
            !flushRelayOutput($client['socket'], $client['output'])) {
            unset($client);
            closeClient($clients, $userConnectionCounts, $clientId);
            continue;
        }
        if ($client['upstream'] !== null && !$client['handshaked']) {
            try {
                $client['upstream']->tick(
                    in_array($client['nntpSocket'], $readSockets, true),
                    in_array($client['nntpSocket'], $writeSockets, true)
                );
                if ($client['upstream']->ready) {
                    $client['output'] .= $client['upgradeResponse'];
                    $client['handshaked'] = true;
                }
            } catch (Exception $e) {
                // Never log credentials or signed URL tokens.
                error_log('[nntp-relay] '.$e->getMessage());
                @fwrite($client['socket'], "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }
        }
        if ($client['handshaked'] && in_array($client['nntpSocket'], $writeSockets, true) &&
            !flushRelayOutput($client['nntpSocket'], $client['nntpOutput'])) {
            unset($client);
            closeClient($clients, $userConnectionCounts, $clientId);
            continue;
        }

        // 1. Read incoming data from upstream NNTP socket (if ready in stream_select)
        if (
            $client['handshaked'] &&
            is_resource($client['nntpSocket']) &&
            in_array($client['nntpSocket'], $readSockets, true)
        ) {
            $nntpEof = false;
            // TLS can return a short record with more decrypted data available.
            // Drain until EAGAIN, with a fairness budget instead of stopping on a short read.
            $readBudget = 1048576;
            while ($readBudget > 0) {
                $nntpChunk = @fread($client['nntpSocket'], 262144);
                if ($nntpChunk === false || $nntpChunk === '') {
                    if ($nntpChunk === false || feof($client['nntpSocket'])) {
                        $nntpEof = true;
                    }
                    break;
                }
                $client['nntpBuffer'] .= $nntpChunk;
                $readBudget -= strlen($nntpChunk);
            }

            if (strlen($client['nntpBuffer']) > 16777216 || !drainClientNntpBuffer($client, $nntpEof)) {
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }
            if ($nntpEof && !empty($client['pendingIds'])) {
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }
        }

        // 2. Read incoming WebSocket frames / HTTP Upgrade from browser client
        if (!in_array($client['socket'], $readSockets, true)) {
            unset($client);
            continue;
        }

        $chunk = @fread($client['socket'], 65536);
        if ($chunk === false || $chunk === '') {
            if (feof($client['socket']) || $chunk === false) {
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
            } else {
                unset($client);
            }
            continue;
        }

        $client['buffer'] .= $chunk;

        // Perform RFC 6455 HTTP Upgrade + Token Verification
        if (!$client['handshaked'] && $client['upstream'] === null) {
            $headerEnd = strpos($client['buffer'], "\r\n\r\n");
            if ($headerEnd === false) {
                if (strlen($client['buffer']) > 8192) {
                    unset($client);
                    closeClient($clients, $userConnectionCounts, $clientId);
                } else {
                    unset($client);
                }
                continue;
            }

            $rawHeaders = substr($client['buffer'], 0, $headerEnd);
            $client['buffer'] = substr($client['buffer'], $headerEnd + 4);

            $lines = explode("\r\n", $rawHeaders);
            $requestLine = array_shift($lines);
            if (!preg_match('#^GET\s+(\S+)\s+HTTP/1\.[01]$#i', $requestLine, $reqMatch)) {
                @fwrite($client['socket'], "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }

            $requestUri = $reqMatch[1];
            $queryStr = parse_url($requestUri, PHP_URL_QUERY) ?: '';
            parse_str($queryStr, $queryParams);
            $token = isset($queryParams['token']) ? (string) $queryParams['token'] : '';

            $headers = [];
            foreach ($lines as $line) {
                $colonPos = strpos($line, ':');
                if ($colonPos !== false) {
                    $k = strtolower(trim(substr($line, 0, $colonPos)));
                    $v = trim(substr($line, $colonPos + 1));
                    $headers[$k] = $v;
                }
            }

            if (empty($headers['sec-websocket-key'])) {
                @fwrite($client['socket'], "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }

            try {
                $settings = loadFreshRelaySettings();
            } catch (Exception $e) {
                @fwrite($client['socket'], "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\nSettings unavailable");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }

            // Verify signed relay token against Spotweb settings
            $claims = SpotPage_nntprelay::verifyRelayToken($settings, $token);
            if ($claims === null) {
                @fwrite($client['socket'], "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nInvalid or expired relay token");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }

            $userId = (int) $claims['uid'];
            $configuredMax = SpotPage_nntprelay::getConfiguredMaxConnections($settings);
            $maxConns = min($configuredMax, isset($claims['maxConn']) ? (int) $claims['maxConn'] : 4);
            $currentConns = isset($userConnectionCounts[$userId]) ? $userConnectionCounts[$userId] : 0;

            if ($currentConns >= $maxConns) {
                @fwrite($client['socket'], "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\nPer-user connection limit reached");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }

            // Connect to upstream NNTP server now
            try {
                $nntpConfig = SpotPage_nntprelay::getConfiguredBinaryNntpServer($settings);
                $client['providerSlot'] = SpotPage_nntprelay::acquireProviderConnectionSlot($nntpConfig, $configuredMax, 0);
                if ($client['providerSlot'] === null) {
                    @fwrite($client['socket'], "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\nProvider download connection limit reached");
                    unset($client);
                    closeClient($clients, $userConnectionCounts, $clientId);
                    continue;
                }
                $client['upstream'] = new Services_Nntp_RelayUpstream($nntpConfig, 15);
                $client['nntpSocket'] = $client['upstream']->stream;
            } catch (Exception $e) {
                @fwrite($client['socket'], "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream NNTP error");
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
                continue;
            }

            $acceptKey = base64_encode(sha1($headers['sec-websocket-key'].'258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
            $upgradeResponse = "HTTP/1.1 101 Switching Protocols\r\n"
                ."Upgrade: websocket\r\n"
                ."Connection: Upgrade\r\n"
                ."Sec-WebSocket-Accept: {$acceptKey}\r\n\r\n";

            $client['upgradeResponse'] = $upgradeResponse;
            $client['userId'] = $userId;
            $client['maxConns'] = $maxConns;
            $userConnectionCounts[$userId] = $currentConns + 1;
        }

        if (!$client['handshaked']) {
            if (strlen($client['buffer']) > 65536) {
                unset($client);
                closeClient($clients, $userConnectionCounts, $clientId);
            } else {
                unset($client);
            }
            continue;
        }

        // Process WebSocket frames from client
        $clientClosed = false;
        while (($frame = decodeWsFrame($client['buffer'])) !== null) {
            $client['buffer'] = substr($client['buffer'], $frame['consumed']);
            $opcode = $frame['opcode'];
            $payload = $frame['payload'];

            if ($opcode === 0x08) {
                // Close frame
                $clientClosed = true;
                break;
            } elseif ($opcode === 0x09) {
                // Ping -> Pong
                $client['output'] .= encodeWsFrame($payload, 0x0A);
                continue;
            } elseif ($opcode === 0x01 || $opcode === 0x02) {
                // Parse either pipelined `BODY <id>\r\n` lines or JSON `{"messageIds":[...]}`
                $messageIds = [];
                $trimmed = trim($payload);

                if (strlen($trimmed) > 0 && $trimmed[0] === '{') {
                    $decoded = @json_decode($trimmed, true);
                    if (is_array($decoded) && !empty($decoded['messageIds']) && is_array($decoded['messageIds'])) {
                        foreach ($decoded['messageIds'] as $rawId) {
                            $cleanId = SpotPage_nntprelay::sanitizeAndValidateMessageId($rawId);
                            if ($cleanId !== null) {
                                $messageIds[] = $cleanId;
                            }
                        }
                    }
                } else {
                    $cmdLines = preg_split('/\r?\n/', $trimmed);
                    foreach ($cmdLines as $cmdLine) {
                        $cmdLine = trim($cmdLine);
                        if ($cmdLine === '') {
                            continue;
                        }
                        if (preg_match('/^BODY\s+<([^>]+)>$/i', $cmdLine, $m)) {
                            $cleanId = SpotPage_nntprelay::sanitizeAndValidateMessageId($m[1]);
                            if ($cleanId !== null) {
                                $messageIds[] = $cleanId;
                            }
                        }
                    }
                }

                if (empty($messageIds) || count($messageIds) > SpotPage_nntprelay::MAX_BATCH_SIZE) {
                    continue;
                }
                if (count($client['pendingIds']) + count($messageIds) > 64) {
                    $clientClosed = true;
                    break;
                }

                $pipelineCmds = '';
                foreach ($messageIds as $msgId) {
                    $pipelineCmds .= 'BODY <'.$msgId.">\r\n";
                    $client['pendingIds'][] = $msgId;
                }

                $client['nntpOutput'] .= $pipelineCmds;
            }
        }

        unset($client);
        if ($clientClosed) {
            closeClient($clients, $userConnectionCounts, $clientId);
        }
    }
}
