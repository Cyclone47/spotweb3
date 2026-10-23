<?php

require_once __DIR__.'/../services/Nntp/Services_Nntp_ClientPool.php';
require_once __DIR__.'/../services/Nntp/Services_Nntp_SpotReader.php';
require_once __DIR__.'/../services/Nntp/Services_Nntp_Encryption.php';
require_once __DIR__.'/../services/Nntp/Services_Nntp_ConnectionLimit.php';

/**
 * Authenticated Spotweb NNTP Relay Endpoint for the Browser Download Engine.
 *
 * Security invariants:
 * - Enforces SpotSecurity::spotsec_retrieve_nzb on every request.
 * - Never exposes NNTP server credentials, hostnames, or raw socket configuration to the browser.
 * - Restricts upstream connections strictly to Spotweb's configured `nntp_nzb` (or `nntp_hdr`) server.
 * - Allows only RFC 3977 `BODY <message-id>` retrieval of validated Message-IDs.
 * - Enforces per-user concurrent connection limits via OS-level non-blocking lock slots.
 */
class SpotPage_nntprelay extends SpotPage_Abs
{
    const MAX_BATCH_SIZE = 32;
    const DEFAULT_BATCH_SIZE = 8;
    const DEFAULT_MAX_CONNECTIONS = 4;
    const HARD_MAX_CONNECTIONS = Services_Nntp_ConnectionLimit::MaxConnections;
    const TOKEN_TTL_SECONDS = 43200; // 12 hours

    private $_params;

    public function __construct(Dao_Factory $daoFactory, Services_Settings_Container $settings, array $currentSession, array $params = [])
    {
        parent::__construct($daoFactory, $settings, $currentSession);
        $this->_params = $params;
    }

    /**
     * Derives the server-local HMAC-SHA256 signing key for browser relay tokens.
     */
    public static function getRelayHmacSecret(Services_Settings_Container $settings)
    {
        $salt = (string) $settings->get('pass_salt');
        if ($salt === '') {
            throw new RuntimeException('Relay signing requires the installation password salt');
        }
        $nntp = $settings->get('nntp_nzb');
        if (empty($nntp['host'])) {
            $nntp = $settings->get('nntp_hdr');
        }
        $hostKey = isset($nntp['host']) ? (string) $nntp['host'] : 'spotweb';

        return hash('sha256', 'spotweb_browser_nntp_relay_v1|'.$salt.'|'.$hostKey, true);
    }

    /**
     * Issues a signed HMAC-SHA256 token bound to a Spotweb user ID and connection cap.
     */
    public static function issueRelayToken(Services_Settings_Container $settings, $userId, $maxConnections = null, $ttl = self::TOKEN_TTL_SECONDS)
    {
        $configured = self::getConfiguredMaxConnections($settings);
        $payload = [
            'uid'     => (int) $userId,
            'exp'     => time() + (int) $ttl,
            'maxConn' => $maxConnections === null ? $configured : min($configured, max(1, (int) $maxConnections)),
            'v'       => 1,
        ];
        $json = json_encode($payload);
        $b64 = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
        $sig = hash_hmac('sha256', $b64, self::getRelayHmacSecret($settings), true);
        $sigB64 = rtrim(strtr(base64_encode($sig), '+/', '-_'), '=');

        return $b64.'.'.$sigB64;
    }

    /**
     * Verifies a signed HMAC-SHA256 relay token.
     *
     * @return array|null Decoded payload or null if invalid/expired.
     */
    public static function verifyRelayToken(Services_Settings_Container $settings, $token)
    {
        if (!is_string($token) || strpos($token, '.') === false) {
            return null;
        }
        list($b64, $sigB64) = explode('.', $token, 2);
        if ($b64 === '' || $sigB64 === '') {
            return null;
        }
        try {
            $secret = self::getRelayHmacSecret($settings);
        } catch (RuntimeException $error) {
            return null;
        }
        $expectedSig = hash_hmac('sha256', $b64, $secret, true);
        $expectedSigB64 = rtrim(strtr(base64_encode($expectedSig), '+/', '-_'), '=');
        if (!hash_equals($expectedSigB64, $sigB64)) {
            return null;
        }
        $json = base64_decode(strtr($b64, '-_', '+/'), true);
        if ($json === false) {
            return null;
        }
        $payload = json_decode($json, true);
        if (!is_array($payload) || empty($payload['exp']) || $payload['exp'] < time()) {
            return null;
        }

        return $payload;
    }

    /**
     * Resolves Spotweb's configured binary NNTP server settings.
     */
    public static function getConfiguredBinaryNntpServer(Services_Settings_Container $settings)
    {
        $nntpBin = $settings->get('nntp_nzb');
        if (empty($nntpBin) || empty($nntpBin['host'])) {
            $nntpBin = $settings->get('nntp_hdr');
        }
        if (empty($nntpBin) || empty($nntpBin['host'])) {
            throw new MissingNntpConfigurationException();
        }
        if (!isset($nntpBin['verifyname'])) {
            $nntpBin['verifyname'] = true;
        }

        return $nntpBin;
    }

    /**
     * Validates that a Message-ID contains no whitespace, angle brackets, or control characters.
     */
    public static function sanitizeAndValidateMessageId($rawId)
    {
        if (!is_string($rawId)) {
            return null;
        }
        $trimmed = trim($rawId);
        if (strlen($trimmed) >= 2 && $trimmed[0] === '<' && substr($trimmed, -1) === '>') {
            $trimmed = substr($trimmed, 1, -1);
        }
        if ($trimmed === '' || strlen($trimmed) > 250) {
            return null;
        }
        if (preg_match('/[\x00-\x20<>\\\\\x7f]/', $trimmed)) {
            return null;
        }

        return $trimmed;
    }

    /**
     * Acquires a non-blocking per-user connection slot lock file.
     *
     * @return resource|null Open file handle holding LOCK_EX, or null if all slots are busy.
     */
    public static function acquireUserConnectionSlot($userId, $maxConnections, $waitSeconds = 0.0)
    {
        return self::acquireConnectionSlot('u'.(int) $userId, $maxConnections, $waitSeconds);
    }

    public static function getWsRelayLockPath()
    {
        return sys_get_temp_dir().DIRECTORY_SEPARATOR.'spotweb_ws_relay.lock';
    }

    public static function isLocalWsRelayRunning()
    {
        $lockPath = self::getWsRelayLockPath();
        if (!file_exists($lockPath)) {
            return false;
        }
        $fp = @fopen($lockPath, 'r');
        if (!is_resource($fp)) {
            return false;
        }
        $canLock = @flock($fp, LOCK_EX | LOCK_NB);
        if ($canLock) {
            @flock($fp, LOCK_UN);
        }
        @fclose($fp);

        return !$canLock;
    }

    public static function getConfiguredMaxConnections(Services_Settings_Container $settings)
    {
        return Services_Nntp_ConnectionLimit::normalize($settings->get(Services_Nntp_ConnectionLimit::SettingName));
    }

    /** Shared by HTTP batches, WebSockets, users and jobs on this relay host. */
    public static function acquireProviderConnectionSlot(array $server, $maxConnections, $waitSeconds = 2.5)
    {
        $key = 'p'.hash('sha256', strtolower($server['host']).'|'.$server['port'].'|'.($server['user'] ?? ''));

        return self::acquireConnectionSlot($key, $maxConnections, $waitSeconds);
    }

    private static function acquireConnectionSlot($key, $maxConnections, $waitSeconds = 2.5)
    {
        $max = min(self::HARD_MAX_CONNECTIONS, max(1, (int) $maxConnections));
        $tmpDir = sys_get_temp_dir();

        // Wait up to 2.5 seconds for a slot to free up when batches overlap slightly
        $deadline = microtime(true) + $waitSeconds;
        do {
            for ($slot = 0; $slot < $max; $slot++) {
                $lockPath = $tmpDir.DIRECTORY_SEPARATOR.sprintf('spotweb_nntprelay_%s_s%d.lock', $key, $slot);
                $fp = @fopen($lockPath, file_exists($lockPath) ? 'r' : 'c+');
                if (is_resource($fp)) {
                    if (@flock($fp, LOCK_EX | LOCK_NB)) {
                        return $fp;
                    }
                    @fclose($fp);
                }
            }
            if ($waitSeconds > 0) usleep(40000); // 40ms
        } while (microtime(true) < $deadline);

        return null;
    }

    public static function releaseUserConnectionSlot($fp)
    {
        if (is_resource($fp)) {
            @flock($fp, LOCK_UN);
            @fclose($fp);
        }
    }

    public function render()
    {
        $this->sendExpireHeaders(true);

        // Enforce Spotweb NZB retrieval permission
        $this->_spotSec->fatalPermCheck(SpotSecurity::spotsec_retrieve_nzb, '');

        $action = isset($this->_params['action']) ? $this->_params['action'] : 'descriptor';

        // Release PHP session lock immediately so parallel browser worker connections do not serialize
        if (session_status() === PHP_SESSION_ACTIVE) {
            @session_write_close();
        }

        switch ($action) {
            case 'descriptor':
                $this->renderDescriptor();
                break;

            case 'renew':
                $this->renderRenewToken();
                break;

            case 'batch':
                $this->renderBatchFetch();
                break;

            default:
                $this->sendJsonError(400, 'INVALID_ACTION', 'Unsupported nntprelay action');
                break;
        }
    }

    private function sendJsonError($httpStatus, $code, $message)
    {
        http_response_code((int) $httpStatus);
        $this->sendContentTypeHeader('json');
        echo json_encode([
            'ok'    => false,
            'code'  => $code,
            'error' => $message,
        ]);
    }

    /**
     * Fetches the spot NZB XML, marks the spot as downloaded, and returns the relay connection descriptor.
     */
    private function renderDescriptor()
    {
        try {
            $messageId = isset($this->_params['messageid']) ? $this->_params['messageid'] : '';
            $messageIds = isset($this->_params['messageids']) ? $this->_params['messageids'] : null;
            $resolvedIds = Services_Actions_DownloadNzb::resolveMessageIds($messageId, $messageIds);
            if (!is_array($resolvedIds)) {
                $resolvedIds = $resolvedIds !== '' ? [$resolvedIds] : [];
            }
            if (empty($resolvedIds)) {
                $this->sendJsonError(400, 'MISSING_MESSAGEID', 'No spot messageid specified');

                return;
            }

            $svcBinSpotReading = new Services_Nntp_SpotReader(Services_Nntp_ClientPool::pool($this->_settings, 'bin'));
            $svcTextSpotReading = new Services_Nntp_SpotReader(Services_Nntp_ClientPool::pool($this->_settings, 'hdr'));
            $svcProvNzb = new Services_Providers_Nzb($this->_daoFactory->getCacheDao(), $svcBinSpotReading);
            $svcProvSpot = new Services_Providers_FullSpot($this->_daoFactory->getSpotDao(), $svcTextSpotReading);

            $nzbList = [];
            $primaryTitle = 'Spotweb Download';
            $lastFullSpot = null;

            foreach ($resolvedIds as $thisMsgId) {
                $fullSpot = $svcProvSpot->fetchFullSpot($thisMsgId, $this->_currentSession['user']['userid']);
                if (!empty($fullSpot['nzb'])) {
                    $nzbXml = $svcProvNzb->fetchNzb($fullSpot);
                    if (!empty($nzbXml)) {
                        $nzbList[] = [
                            'spot' => $fullSpot,
                            'nzb'  => $nzbXml,
                        ];
                        if ($lastFullSpot === null && !empty($fullSpot['title'])) {
                            $primaryTitle = $fullSpot['title'];
                        }
                        $lastFullSpot = $fullSpot;
                    }
                }
            }

            if (empty($nzbList)) {
                $this->sendJsonError(404, 'EMPTY_NZB', 'Could not retrieve NZB for the requested spot(s)');

                return;
            }

            if (count($nzbList) === 1) {
                $combinedNzbXml = $nzbList[0]['nzb'];
            } else {
                $primaryTitle = sprintf('%s (+%d)', $primaryTitle, count($nzbList) - 1);
                $combinedNzbXml = $this->mergeNzbXmlList($nzbList, $primaryTitle);
            }

            // Record in user's download history if enabled
            if (!empty($this->_currentSession['user']['prefs']['keep_downloadlist'])) {
                if ($this->_spotSec->allowed(SpotSecurity::spotsec_keep_own_downloadlist, '')) {
                    $spotStateListDao = $this->_daoFactory->getSpotStateListDao();
                    foreach ($resolvedIds as $thisMsgId) {
                        $spotStateListDao->addToDownloadList($thisMsgId, $this->_currentSession['user']['userid']);
                    }
                }
            }

            $maxConn = self::getConfiguredMaxConnections($this->_settings);
            $token = self::issueRelayToken($this->_settings, $this->_currentSession['user']['userid'], $maxConn);

            $wsUrl = getenv('SPOTWEB_NNTP_RELAY_WS_URL');
            if (empty($wsUrl) && $this->_settings->exists('nntp_relay_ws_url')) {
                $wsUrl = $this->_settings->get('nntp_relay_ws_url');
            }
            if (empty($wsUrl) && self::isLocalWsRelayRunning()) {
                $wsUrl = 'nntp-relay-ws';
            }

            $mode = !empty($wsUrl) ? 'ws' : 'http';

            $this->sendContentTypeHeader('json');
            echo json_encode([
                'ok'         => true,
                'title'      => $primaryTitle,
                'messageIds' => $resolvedIds,
                'nzbXml'     => $combinedNzbXml,
                'relay'      => [
                    'mode'           => $mode,
                    'wsUrl'          => !empty($wsUrl) ? $wsUrl : null,
                    'httpBatchUrl'   => '?page=nntprelay&action=batch',
                    'renewUrl'       => '?page=nntprelay&action=renew',
                    'token'          => $token,
                    'maxConnections' => $maxConn,
                    'batchSize'      => self::DEFAULT_BATCH_SIZE,
                ],
            ]);
        } catch (Exception $x) {
            $this->sendJsonError(500, 'DESCRIPTOR_FAILED', $x->getMessage());
        }
    }

    private function renderRenewToken()
    {
        $maxConn = self::getConfiguredMaxConnections($this->_settings);
        $token = self::issueRelayToken($this->_settings, $this->_currentSession['user']['userid'], $maxConn);
        $this->sendContentTypeHeader('json');
        echo json_encode([
            'ok'    => true,
            'token' => $token,
        ]);
    }

    /**
     * Merges multiple NZB XML documents into a single NZB XML document.
     */
    private function mergeNzbXmlList(array $nzbList, $title)
    {
        $domOutput = new DOMDocument('1.0', 'utf-8');
        $domOutput->formatOutput = false;

        $nzbRoot = $domOutput->createElement('nzb');
        $nzbRoot->setAttribute('xmlns', 'http://www.newzbin.com/DTD/2003/nzb');
        $head = $domOutput->createElement('head');
        $metaTitle = $domOutput->createElement('meta', htmlspecialchars($title, ENT_XML1, 'UTF-8'));
        $metaTitle->setAttribute('type', 'title');
        $head->appendChild($metaTitle);
        $nzbRoot->appendChild($head);

        foreach ($nzbList as $item) {
            $domNzb = new DOMDocument();
            if (@$domNzb->loadXML($item['nzb'])) {
                foreach ($domNzb->getElementsByTagName('file') as $fileNode) {
                    $nzbRoot->appendChild($domOutput->importNode($fileNode, true));
                }
            }
        }
        $domOutput->appendChild($nzbRoot);

        return $domOutput->saveXML();
    }

    /**
     * Fast-path HTTP batch handler authenticated via signed HMAC relay token (`X-Spotweb-Relay-Token` or JSON `token`).
     * Avoids redundant SQLite/DB `sessions` table write contention (`UPDATE sessions SET hitcount = ...`)
     * on every article batch request when a valid signed relay token is already present.
     *
     * @return bool True if handled, false to fall back to full session initialization.
     */
    public static function tryRenderFastBatch(Services_Settings_Container $settings)
    {
        $rawBody = file_get_contents('php://input');
        $reqJson = json_decode((string) $rawBody, true);
        if (!is_array($reqJson)) {
            return false;
        }
        $token = '';
        if (!empty($_SERVER['HTTP_X_SPOTWEB_RELAY_TOKEN'])) {
            $token = (string) $_SERVER['HTTP_X_SPOTWEB_RELAY_TOKEN'];
        } elseif (!empty($reqJson['token'])) {
            $token = (string) $reqJson['token'];
        }
        if ($token === '') {
            return false;
        }
        $tokenPayload = self::verifyRelayToken($settings, $token);
        if ($tokenPayload === null) {
            return false;
        }
        if (session_status() === PHP_SESSION_ACTIVE) {
            @session_write_close();
        }
        self::executeBatchFetchStatic($settings, $reqJson, (int) $tokenPayload['uid'], (int) $tokenPayload['maxConn']);

        return true;
    }

    private static function sendStaticJsonError($httpStatus, $code, $message)
    {
        http_response_code((int) $httpStatus);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok'    => false,
            'code'  => $code,
            'error' => $message,
        ]);
    }

    private static function executeBatchFetchStatic(Services_Settings_Container $settings, array $reqJson, $userId, $tokenMaxConn)
    {
        if (empty($reqJson['messageIds']) || !is_array($reqJson['messageIds'])) {
            self::sendStaticJsonError(400, 'INVALID_BATCH_REQUEST', 'Request must include a messageIds array');

            return;
        }
        if (count($reqJson['messageIds']) > self::MAX_BATCH_SIZE) {
            self::sendStaticJsonError(400, 'BATCH_TOO_LARGE', 'Batch size exceeds maximum of '.self::MAX_BATCH_SIZE);

            return;
        }
        $cleanIds = [];
        foreach ($reqJson['messageIds'] as $rawId) {
            $clean = self::sanitizeAndValidateMessageId($rawId);
            if ($clean === null) {
                self::sendStaticJsonError(400, 'INVALID_MESSAGE_ID', 'Invalid NNTP Message-ID format');

                return;
            }
            $cleanIds[] = $clean;
        }

        $configuredMax = self::getConfiguredMaxConnections($settings);
        $maxConn = min($configuredMax, max(1, (int) $tokenMaxConn));

        $slotLock = self::acquireUserConnectionSlot($userId, $maxConn, 2.5);
        if ($slotLock === null) {
            self::sendStaticJsonError(429, 'TOO_MANY_CONNECTIONS', 'Per-user concurrent NNTP connection limit reached');

            return;
        }

        $providerSlot = null;
        try {
            $server = self::getConfiguredBinaryNntpServer($settings);
            $providerSlot = self::acquireProviderConnectionSlot($server, $configuredMax);
            if ($providerSlot === null) {
                self::sendStaticJsonError(429, 'PROVIDER_CONNECTION_LIMIT', 'All download connections are busy; waiting for a free connection');

                return;
            }
            $frames = self::fetchNntpBodiesBatch($server, $cleanIds);

            header('Content-Type: application/octet-stream');
            header('X-Content-Type-Options: nosniff');

            echo self::encodeBinaryFrames($frames);
        } catch (MissingNntpConfigurationException $e) {
            self::sendStaticJsonError(503, 'NNTP_NOT_CONFIGURED', 'Spotweb NNTP server is not configured');
        } catch (Exception $e) {
            self::sendStaticJsonError(502, 'NNTP_UPSTREAM_ERROR', $e->getMessage());
        } finally {
            self::releaseUserConnectionSlot($providerSlot);
            self::releaseUserConnectionSlot($slotLock);
        }
    }

    /**
     * Bounded-batch HTTP binary NNTP BODY fetcher.
     *
     * Request JSON: { "messageIds": ["part1@...", "part2@..."], "token": "..." }
     * Response body: Binary framing matching SpotwebNntpClient.decodeBinaryBatchFrames:
     *   For each messageId:
     *     [status: uint16 BE][idLen: uint16 BE][bodyLen: uint32 BE][idBytes][bodyBytes]
     */
    private function renderBatchFetch()
    {
        $rawBody = isset($this->_params['rawBody'])
            ? $this->_params['rawBody']
            : file_get_contents('php://input');
        $reqJson = json_decode((string) $rawBody, true);
        if (!is_array($reqJson) || empty($reqJson['messageIds']) || !is_array($reqJson['messageIds'])) {
            $this->sendJsonError(400, 'INVALID_BATCH_REQUEST', 'Request must include a messageIds array');

            return;
        }

        if (count($reqJson['messageIds']) > self::MAX_BATCH_SIZE) {
            $this->sendJsonError(400, 'BATCH_TOO_LARGE', 'Batch size exceeds maximum of '.self::MAX_BATCH_SIZE);

            return;
        }

        // Validate optional relay token if supplied
        $userId = (int) $this->_currentSession['user']['userid'];
        $maxConn = self::getConfiguredMaxConnections($this->_settings);
        if (!empty($reqJson['token'])) {
            $tokenPayload = self::verifyRelayToken($this->_settings, (string) $reqJson['token']);
            if ($tokenPayload === null) {
                $this->sendJsonError(401, 'INVALID_RELAY_TOKEN', 'Relay token is invalid or expired');

                return;
            }
            $userId = (int) $tokenPayload['uid'];
            $maxConn = min($maxConn, max(1, (int) $tokenPayload['maxConn']));
        }

        // Validate all Message-IDs before touching the network
        $cleanIds = [];
        foreach ($reqJson['messageIds'] as $rawId) {
            $clean = self::sanitizeAndValidateMessageId($rawId);
            if ($clean === null) {
                $this->sendJsonError(400, 'INVALID_MESSAGE_ID', 'Invalid NNTP Message-ID format');

                return;
            }
            $cleanIds[] = $clean;
        }

        // Enforce per-user concurrent upstream NNTP connection limit
        $slotLock = self::acquireUserConnectionSlot($userId, $maxConn, 2.5);
        if ($slotLock === null) {
            $this->sendJsonError(429, 'TOO_MANY_CONNECTIONS', 'Per-user concurrent NNTP connection limit reached');

            return;
        }

        $providerSlot = null;
        try {
            $server = self::getConfiguredBinaryNntpServer($this->_settings);
            $providerSlot = self::acquireProviderConnectionSlot($server, self::getConfiguredMaxConnections($this->_settings));
            if ($providerSlot === null) {
                $this->sendJsonError(429, 'PROVIDER_CONNECTION_LIMIT', 'All download connections are busy; waiting for a free connection');
                return;
            }
            $frames = self::fetchNntpBodiesBatch($server, $cleanIds);

            header('Content-Type: application/octet-stream');
            header('X-Content-Type-Options: nosniff');

            echo self::encodeBinaryFrames($frames);
        } catch (MissingNntpConfigurationException $e) {
            $this->sendJsonError(503, 'NNTP_NOT_CONFIGURED', 'Spotweb NNTP server is not configured');
        } catch (Exception $e) {
            $this->sendJsonError(502, 'NNTP_UPSTREAM_ERROR', $e->getMessage());
        } finally {
            self::releaseUserConnectionSlot($providerSlot);
            self::releaseUserConnectionSlot($slotLock);
        }
    }

    /**
     * Encodes an array of NNTP body frames into binary batch format:
     *   [status: uint16 BE][idLen: uint16 BE][bodyLen: uint32 BE][idBytes][bodyBytes]
     *
     * @param array<int, array{status: int, messageId: string, body: string}> $frames
     *
     * @return string
     */
    public static function encodeBinaryFrames(array $frames)
    {
        $chunks = [];
        foreach ($frames as $frame) {
            $idBytes = (string) $frame['messageId'];
            $bodyBytes = (string) $frame['body'];
            $chunks[] = pack('nnN', (int) $frame['status'], strlen($idBytes), strlen($bodyBytes));
            $chunks[] = $idBytes;
            if ($bodyBytes !== '') {
                $chunks[] = $bodyBytes;
            }
        }

        return implode('', $chunks);
    }

    /**
     * Opens, TLS-upgrades, and authenticates a socket to the configured NNTP server.
     *
     * @param array $server  Spotweb NNTP server config (`host`, `port`, `enc`, `user`, `pass`, `verifyname`)
     * @param int   $timeout Socket timeout in seconds
     *
     * @return resource
     */
    public static function openAuthenticatedNntpSocket(array $server, $timeout = 20)
    {
        $enc = Services_Nntp_Encryption::normalize(isset($server['enc']) ? $server['enc'] : false);
        if ($enc === null) {
            throw new NntpException('Invalid NNTP encryption configuration', -1);
        }
        $cryptoMethod = Services_Nntp_Encryption::cryptoMethod();
        $verifyName = array_key_exists('verifyname', $server) ? (bool) $server['verifyname'] : true;

        $context = stream_context_create([
            'ssl' => [
                'verify_peer'      => $verifyName,
                'verify_peer_name' => $verifyName,
                'peer_name'        => $server['host'],
                'crypto_method'    => $cryptoMethod,
            ],
        ]);

        $scheme = ($enc === Services_Nntp_Encryption::ImplicitTls) ? 'tls' : 'tcp';
        $target = $scheme.'://'.$server['host'].':'.(int) $server['port'];
        $errno = 0;
        $errstr = '';
        $stream = @stream_socket_client($target, $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $context);
        if (!is_resource($stream)) {
            throw new NntpException('Failed to connect to NNTP server: '.$errstr, $errno);
        }

        stream_set_timeout($stream, $timeout);

        try {
            // Read greeting (200 or 201)
            $greeting = self::readSingleLine($stream);
            $greetCode = (int) substr($greeting, 0, 3);
            if ($greetCode !== 200 && $greetCode !== 201) {
                throw new NntpException('Unexpected NNTP greeting: '.$greeting, $greetCode);
            }

            // Upgrade via STARTTLS if configured
            if ($enc === Services_Nntp_Encryption::StartTls) {
                self::writeAll($stream, "STARTTLS\r\n");
                $tlsResp = self::readSingleLine($stream);
                if ((int) substr($tlsResp, 0, 3) !== 382) {
                    throw new NntpException('STARTTLS rejected by NNTP server: '.$tlsResp, -1);
                }
                if (@stream_socket_enable_crypto($stream, true, $cryptoMethod) !== true) {
                    throw new NntpException('Unable to negotiate STARTTLS with NNTP server', -1);
                }
            }

            // Authenticate if configured
            if (!empty($server['user'])) {
                self::writeAll($stream, 'AUTHINFO USER '.$server['user']."\r\n");
                $userResp = self::readSingleLine($stream);
                $uCode = (int) substr($userResp, 0, 3);
                if ($uCode === 381) {
                    self::writeAll($stream, 'AUTHINFO PASS '.(isset($server['pass']) ? $server['pass'] : '')."\r\n");
                    $passResp = self::readSingleLine($stream);
                    $pCode = (int) substr($passResp, 0, 3);
                    if ($pCode !== 281) {
                        throw new NntpException('NNTP authentication failed', $pCode);
                    }
                } elseif ($uCode !== 281) {
                    throw new NntpException('NNTP authentication rejected', $uCode);
                }
            }

            return $stream;
        } catch (Exception $e) {
            @fclose($stream);

            throw $e;
        }
    }

    /**
     * Pipelines `BODY <message-id>` requests on an already-connected NNTP stream.
     *
     * @param resource $stream
     * @param array    $messageIds
     *
     * @return array<int, array{status: int, messageId: string, body: string}>
     */
    public static function fetchNntpBodiesOnStream($stream, array $messageIds)
    {
        if (empty($messageIds)) {
            return [];
        }

        // Pipeline all BODY <message-id> commands in a single write
        $pipelineCmds = '';
        foreach ($messageIds as $msgId) {
            $pipelineCmds .= 'BODY <'.$msgId.">\r\n";
        }
        self::writeAll($stream, $pipelineCmds);

        // Read each response in order
        $buffer = '';
        $results = [];
        foreach ($messageIds as $msgId) {
            $statusLine = self::readBufferedLine($stream, $buffer);
            $statusCode = (int) substr($statusLine, 0, 3);

            if ($statusCode === 222 || $statusCode === 220) {
                $rawBody = self::readDotTerminatedBody($stream, $buffer);
                $results[] = [
                    'status'    => 222,
                    'messageId' => $msgId,
                    'body'      => $rawBody,
                ];
            } elseif ($statusCode === 430 || $statusCode === 423) {
                $results[] = [
                    'status'    => 430,
                    'messageId' => $msgId,
                    'body'      => '',
                ];
            } else {
                throw new NntpException('Unexpected NNTP BODY response: '.$statusLine, $statusCode);
            }
        }

        return $results;
    }

    /**
     * Connects to the configured NNTP server and pipelines `BODY <message-id>` requests,
     * preserving raw binary yEnc payloads without line-array allocation overhead.
     *
     * @param array $server Spotweb NNTP server config (`host`, `port`, `enc`, `user`, `pass`, `verifyname`)
     * @param array $messageIds Validated Message-IDs (without angle brackets)
     * @param int   $timeout Socket timeout in seconds
     * @return array<int, array{status: int, messageId: string, body: string}>
     */
    public static function fetchNntpBodiesBatch(array $server, array $messageIds, $timeout = 20)
    {
        if (empty($messageIds)) {
            return [];
        }

        $stream = self::openAuthenticatedNntpSocket($server, $timeout);

        try {
            $results = self::fetchNntpBodiesOnStream($stream, $messageIds);
            @fwrite($stream, "QUIT\r\n");

            return $results;
        } finally {
            @fclose($stream);
        }
    }

    private static function writeAll($stream, $data)
    {
        $len = strlen($data);
        $offset = 0;
        while ($offset < $len) {
            $written = @fwrite($stream, substr($data, $offset));
            if ($written === false || $written === 0) {
                throw new NntpException('NNTP socket write failed', -1);
            }
            $offset += $written;
        }
    }

    private static function readSingleLine($stream)
    {
        $line = @fgets($stream, 4096);
        if ($line === false) {
            throw new NntpException('NNTP socket read failed or timed out', -1);
        }

        return rtrim($line, "\r\n");
    }

    private static function readBufferedLine($stream, &$buffer)
    {
        while (($pos = strpos($buffer, "\n")) === false) {
            $chunk = @fread($stream, 65536);
            if ($chunk === false || ($chunk === '' && feof($stream))) {
                throw new NntpException('NNTP connection closed while waiting for status line', -1);
            }
            if ($chunk === '') {
                $meta = stream_get_meta_data($stream);
                if (!empty($meta['timed_out'])) {
                    throw new NntpException('NNTP read timed out while waiting for status line', -1);
                }
            }
            $buffer .= $chunk;
        }
        $line = substr($buffer, 0, $pos);
        $buffer = substr($buffer, $pos + 1);

        return rtrim($line, "\r");
    }

    /**
     * Reads an RFC 3977 multiline response block up to `\r\n.\r\n` (or leading `.\r\n`)
     * and preserves dot-stuffing for the browser yEnc decoder. Removing it here
     * as well as in the decoder corrupts legitimate payload lines starting '..'.
     */
    public static function readDotTerminatedBody($stream, &$buffer)
    {
        // Check if empty body (`.\r\n` or `.\n` right at start of buffer)
        while (strlen($buffer) < 5) {
            if (strpos($buffer, ".\r\n") === 0) {
                $buffer = substr($buffer, 3);

                return '';
            }
            if (strpos($buffer, ".\n") === 0) {
                $buffer = substr($buffer, 2);

                return '';
            }
            $chunk = @fread($stream, 65536);
            if ($chunk === false || ($chunk === '' && feof($stream))) {
                break;
            }
            if ($chunk === '') {
                $meta = stream_get_meta_data($stream);
                if (!empty($meta['timed_out'])) {
                    throw new NntpException('NNTP read timed out during multiline body', -1);
                }
            }
            $buffer .= $chunk;
        }

        if (strpos($buffer, ".\r\n") === 0) {
            $buffer = substr($buffer, 3);

            return '';
        }
        if (strpos($buffer, ".\n") === 0) {
            $buffer = substr($buffer, 2);

            return '';
        }

        $searchOffset = 0;
        while (true) {
            $termPos = strpos($buffer, "\r\n.\r\n", $searchOffset);
            $termLen = 5;
            if ($termPos === false) {
                $termPos = strpos($buffer, "\n.\n", $searchOffset);
                $termLen = 3;
            }
            if ($termPos !== false) {
                $rawBody = substr($buffer, 0, $termPos + ($termLen === 5 ? 2 : 1));
                $buffer = substr($buffer, $termPos + $termLen);

                return $rawBody;
            }

            $searchOffset = max(0, strlen($buffer) - 6);
            $chunk = @fread($stream, 65536);
            if ($chunk === false || ($chunk === '' && feof($stream))) {
                throw new NntpException('NNTP connection closed before multiline body terminator', -1);
            }
            if ($chunk === '') {
                $meta = stream_get_meta_data($stream);
                if (!empty($meta['timed_out'])) {
                    throw new NntpException('NNTP read timed out during multiline body', -1);
                }
            }
            $buffer .= $chunk;
        }
    }
}
