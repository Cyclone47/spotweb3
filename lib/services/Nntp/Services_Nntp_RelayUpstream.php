<?php

/** Nonblocking TCP/TLS and NNTP authentication for the WebSocket relay. */
class Services_Nntp_RelayUpstream
{
    public $stream;
    public $ready = false;
    private $server;
    private $encryption;
    private $state = 'connect';
    private $output = '';
    private $input = '';
    private $deadline;
    private $nextCryptoAttempt = 0;
    private $afterTls = 'greeting';

    public function __construct(array $server, $timeout = 15)
    {
        $this->server = $server;
        $this->encryption = Services_Nntp_Encryption::normalize($server['enc'] ?? false);
        if ($this->encryption === null) {
            throw new RuntimeException('Invalid NNTP encryption configuration');
        }
        $verify = array_key_exists('verifyname', $server) ? (bool) $server['verifyname'] : true;
        $context = stream_context_create([
            'socket' => ['tcp_nodelay' => true],
            'ssl' => [
                'verify_peer' => $verify, 'verify_peer_name' => $verify,
                'peer_name' => $server['host'],
                'crypto_method' => Services_Nntp_Encryption::cryptoMethod(),
            ],
        ]);
        $this->stream = @stream_socket_client(
            'tcp://'.$server['host'].':'.(int) $server['port'], $errno, $error, $timeout,
            STREAM_CLIENT_CONNECT | STREAM_CLIENT_ASYNC_CONNECT, $context
        );
        if (!is_resource($this->stream)) {
            throw new RuntimeException('Unable to connect to NNTP server');
        }
        stream_set_blocking($this->stream, false);
        $this->deadline = microtime(true) + $timeout;
    }

    public function wantsWrite()
    {
        return $this->state === 'connect' || $this->output !== '' ||
            ($this->state === 'tls' && microtime(true) >= $this->nextCryptoAttempt);
    }

    public function tick($readable, $writable)
    {
        if ($this->ready) return;
        if (microtime(true) > $this->deadline) {
            throw new RuntimeException('NNTP connection setup timed out');
        }
        if ($this->state === 'connect') {
            if (!$writable && !$readable) return;
            if (@stream_socket_get_name($this->stream, true) === false) {
                throw new RuntimeException('NNTP connection failed');
            }
            $this->state = $this->encryption === Services_Nntp_Encryption::ImplicitTls ? 'tls' : 'greeting';
        }
        if ($this->state === 'tls') {
            if ((!$readable && !$writable) || microtime(true) < $this->nextCryptoAttempt) return;
            $result = @stream_socket_enable_crypto($this->stream, true, Services_Nntp_Encryption::cryptoMethod());
            if ($result === false) throw new RuntimeException('NNTP TLS negotiation failed');
            if ($result === 0) {
                $this->nextCryptoAttempt = microtime(true) + 0.01;
                return;
            }
            $this->state = $this->afterTls;
            if ($this->state === 'auth') $this->authenticate();
            return;
        }
        if ($this->output !== '') {
            if (!$writable) return;
            $written = @fwrite($this->stream, $this->output);
            if ($written === false || feof($this->stream)) throw new RuntimeException('NNTP write failed');
            $this->output = (string) substr($this->output, $written);
            if ($this->output !== '') return;
        }
        if (!$readable) return;
        $bytes = @fread($this->stream, 8192);
        if ($bytes === false || ($bytes === '' && feof($this->stream))) {
            throw new RuntimeException('NNTP connection closed during authentication');
        }
        $this->input .= $bytes;
        if (strlen($this->input) > 8192) throw new RuntimeException('Invalid NNTP greeting');
        $end = strpos($this->input, "\n");
        if ($end === false) return;
        $code = (int) substr($this->input, 0, 3);
        $this->input = substr($this->input, $end + 1);
        if ($this->state === 'greeting' && ($code === 200 || $code === 201)) {
            if ($this->encryption === Services_Nntp_Encryption::StartTls) {
                $this->output = "STARTTLS\r\n";
                $this->state = 'starttls';
            } else {
                $this->authenticate();
            }
        } elseif ($this->state === 'starttls' && $code === 382) {
            $this->state = 'tls';
            $this->afterTls = 'auth';
        } elseif ($this->state === 'user' && $code === 381) {
            $this->output = 'AUTHINFO PASS '.($this->server['pass'] ?? '')."\r\n";
            $this->state = 'pass';
        } elseif (($this->state === 'user' || $this->state === 'pass') && $code === 281) {
            $this->ready = true;
        } else {
            throw new RuntimeException('NNTP authentication or greeting rejected ('.$code.')');
        }
    }

    private function authenticate()
    {
        if (empty($this->server['user'])) {
            $this->ready = true;
        } else {
            $this->output = 'AUTHINFO USER '.$this->server['user']."\r\n";
            $this->state = 'user';
        }
    }
}
