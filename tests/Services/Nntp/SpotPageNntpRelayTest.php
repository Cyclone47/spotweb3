<?php

use PHPUnit\Framework\TestCase;

require_once __DIR__.'/../../../lib/services/Settings/Services_Settings_Container.php';
require_once __DIR__.'/../../../lib/page/SpotPage_Abs.php';
require_once __DIR__.'/../../../lib/page/SpotPage_nntprelay.php';

class SpotPageNntpRelayTest extends TestCase
{
    private function createSettings($salt = 'test-passsalt', $host = 'news.example.com')
    {
        return new class($salt, $host) extends Services_Settings_Container {
            private $map;

            public function __construct($salt, $host)
            {
                $this->map = [
                    'pass_salt' => $salt,
                    'passsalt' => 'unused-legacy-setting',
                    'nntp_nzb' => ['host' => $host, 'port' => 563, 'enc' => 'tls'],
                ];
            }

            public function get($name)
            {
                return $this->map[$name] ?? null;
            }
        };
    }

    public function testRelayTokenMintAndVerify()
    {
        $settings = $this->createSettings('test-passsalt', 'news.example.com');
        $token = SpotPage_nntprelay::issueRelayToken($settings, 42, 4, 600);

        $claims = SpotPage_nntprelay::verifyRelayToken($settings, $token);
        $this->assertIsArray($claims);
        $this->assertSame(42, $claims['uid']);
        $this->assertSame(4, $claims['maxConn']);

        // Reject wrong secret
        $otherSettings = $this->createSettings('wrong-passsalt', 'news.example.com');
        $this->assertNull(SpotPage_nntprelay::verifyRelayToken($otherSettings, $token));

        // Reject expired token
        $expiredToken = SpotPage_nntprelay::issueRelayToken($settings, 42, 4, -10);
        $this->assertNull(SpotPage_nntprelay::verifyRelayToken($settings, $expiredToken));

        // Reject tampered payload
        $parts = explode('.', $token);
        $this->assertNull(SpotPage_nntprelay::verifyRelayToken($settings, $parts[0].'.invalid_sig'));
    }

    public function testTokenUsingTheOldEmptySaltCannotBeForged()
    {
        $settings = $this->createSettings();
        $payload = rtrim(strtr(base64_encode(json_encode([
            'uid' => 42, 'maxConn' => 4, 'exp' => time() + 60, 'v' => 1,
        ])), '+/', '-_'), '=');
        $publicKey = hash('sha256', 'spotweb_browser_nntp_relay_v1||news.example.com', true);
        $signature = rtrim(strtr(base64_encode(hash_hmac('sha256', $payload, $publicKey, true)), '+/', '-_'), '=');
        $this->assertNull(SpotPage_nntprelay::verifyRelayToken($settings, $payload.'.'.$signature));
    }

    public function testVerificationFailsClosedWhenInstallationSaltIsMissing()
    {
        $settings = $this->createSettings('');
        $this->assertNull(SpotPage_nntprelay::verifyRelayToken($settings, 'payload.signature'));
    }

    public function testIssuingTokenFailsWhenInstallationSaltIsMissing()
    {
        $this->expectException(RuntimeException::class);
        SpotPage_nntprelay::issueRelayToken($this->createSettings(''), 42);
    }

    public function testSanitizeMessageIdPreventsCommandInjection()
    {
        $this->assertSame(
            'seg1.part1@news.example.com',
            SpotPage_nntprelay::sanitizeAndValidateMessageId('<seg1.part1@news.example.com>')
        );
        $this->assertSame(
            'seg1.part1@news.example.com',
            SpotPage_nntprelay::sanitizeAndValidateMessageId('seg1.part1@news.example.com')
        );

        // Reject CRLF injection, spaces, angle brackets inside ID, empty strings
        $this->assertNull(SpotPage_nntprelay::sanitizeAndValidateMessageId("seg1@example.com\r\nQUIT"));
        $this->assertNull(SpotPage_nntprelay::sanitizeAndValidateMessageId("seg1@example.com\nPOST"));
        $this->assertNull(SpotPage_nntprelay::sanitizeAndValidateMessageId('seg1 @example.com'));
        $this->assertNull(SpotPage_nntprelay::sanitizeAndValidateMessageId('seg1<inject>@example.com'));
        $this->assertNull(SpotPage_nntprelay::sanitizeAndValidateMessageId(''));
    }

    public function testBinaryFrameEncodingFormat()
    {
        $msgId = 'seg1@test.local';
        $body = "=ybegin line=128 size=4 name=test.bin\r\nABCD\r\n=yend size=4 crc32=12345678\r\n";

        $frame = SpotPage_nntprelay::encodeBinaryFrames([
            [
                'status'    => 222,
                'messageId' => $msgId,
                'body'      => $body,
            ],
        ]);
        $header = unpack('nstatus/nidLen/NbodyLen', substr($frame, 0, 8));

        $this->assertSame(222, $header['status']);
        $this->assertSame(strlen($msgId), $header['idLen']);
        $this->assertSame(strlen($body), $header['bodyLen']);
        $this->assertSame($msgId, substr($frame, 8, $header['idLen']));
        $this->assertSame($body, substr($frame, 8 + $header['idLen']));
    }

    public function testPerUserConcurrencySlotEnforcement()
    {
        $userId = 999123;
        $maxConns = 2;

        $slot1 = SpotPage_nntprelay::acquireUserConnectionSlot($userId, $maxConns);
        $this->assertIsResource($slot1);

        $slot2 = SpotPage_nntprelay::acquireUserConnectionSlot($userId, $maxConns);
        $this->assertIsResource($slot2);

        // 3rd concurrent slot must be rejected
        $slot3 = SpotPage_nntprelay::acquireUserConnectionSlot($userId, $maxConns);
        $this->assertNull($slot3);

        // Releasing 1st slot allows acquiring a slot again
        SpotPage_nntprelay::releaseUserConnectionSlot($slot1);
        $slot4 = SpotPage_nntprelay::acquireUserConnectionSlot($userId, $maxConns);
        $this->assertIsResource($slot4);

        SpotPage_nntprelay::releaseUserConnectionSlot($slot2);
        SpotPage_nntprelay::releaseUserConnectionSlot($slot4);
    }

    public function testFetchNntpBodiesPreservesDotStuffingForTheBrowserDecoder()
    {
        $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
        $this->assertIsArray($pair);

        list($clientSock, $serverSock) = $pair;

        // Pre-fill simulated upstream NNTP server responses for 2 pipelined BODY commands:
        // 1. 222 article with a dot-stuffed line "..leading-dot"
        // 2. 430 missing article
        $upstreamResponse =
            "222 0 <seg1@example.com> body\r\n" .
            "=ybegin line=128 size=12 name=file.bin\r\n" .
            "..leading-dot\r\n" .
            "...two-payload-dots\r\n" .
            "=yend size=12\r\n" .
            ".\r\n" .
            "430 No such article <seg2@example.com>\r\n";

        fwrite($serverSock, $upstreamResponse);

        $frames = SpotPage_nntprelay::fetchNntpBodiesOnStream(
            $clientSock,
            ['seg1@example.com', 'seg2@example.com']
        );
        $batchBinary = SpotPage_nntprelay::encodeBinaryFrames($frames);

        $sentCommands = fread($serverSock, 4096);
        $this->assertSame("BODY <seg1@example.com>\r\nBODY <seg2@example.com>\r\n", $sentCommands);

        fclose($clientSock);
        fclose($serverSock);

        // Parse frame 1
        $hdr1 = unpack('nstatus/nidLen/NbodyLen', substr($batchBinary, 0, 8));
        $this->assertSame(222, $hdr1['status']);
        $id1 = substr($batchBinary, 8, $hdr1['idLen']);
        $body1 = substr($batchBinary, 8 + $hdr1['idLen'], $hdr1['bodyLen']);
        $this->assertSame('seg1@example.com', $id1);
        $this->assertSame(
            "=ybegin line=128 size=12 name=file.bin\r\n..leading-dot\r\n...two-payload-dots\r\n=yend size=12\r\n",
            $body1
        );

        // Parse frame 2
        $offset2 = 8 + $hdr1['idLen'] + $hdr1['bodyLen'];
        $hdr2 = unpack('nstatus/nidLen/NbodyLen', substr($batchBinary, $offset2, 8));
        $this->assertSame(430, $hdr2['status']);
        $id2 = substr($batchBinary, $offset2 + 8, $hdr2['idLen']);
        $this->assertSame('seg2@example.com', $id2);
        $this->assertSame(0, $hdr2['bodyLen']);
    }

    public function testProviderConnectionSlotRespectsConfiguredMaxConnections()
    {
        $server = ['host' => 'news.limit-test.example', 'port' => 563, 'user' => 'testuser'];
        $locks = [];
        for ($i = 0; $i < 12; $i++) {
            $lock = SpotPage_nntprelay::acquireProviderConnectionSlot($server, 12, 0.0);
            $this->assertNotNull($lock, "Slot {$i} should be acquired within maxConnections=12");
            $locks[] = $lock;
        }

        $extraLock = SpotPage_nntprelay::acquireProviderConnectionSlot($server, 12, 0.0);
        $this->assertNull($extraLock, '13th concurrent slot should be rejected when maxConnections=12');

        foreach ($locks as $lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
