<?php
// Opt-in real-provider diagnostic. Reads only the supplied article IDs and discards bodies.
// php nntp-provider-benchmark.php /path/to/ids.json [connections=8] [seconds=10] [root]
$root = $argv[4] ?? dirname(__DIR__, 2);
chdir($root);
require $root.'/vendor/autoload.php';
require $root.'/lib/page/SpotPage_Abs.php';
require $root.'/lib/page/SpotPage_nntprelay.php';
require $root.'/lib/services/Nntp/Services_Nntp_RelayUpstream.php';
$bootstrap = new Bootstrap();
$settings = $bootstrap->getSettings($bootstrap->getDaoFactory(), false);
$server = SpotPage_nntprelay::getConfiguredBinaryNntpServer($settings);
$limit = SpotPage_nntprelay::getConfiguredMaxConnections($settings);
$count = min($limit, max(1, (int) ($argv[2] ?? 8)));
$seconds = min(30, max(1, (int) ($argv[3] ?? 10)));
$ids = json_decode(file_get_contents($argv[1]), true);
if (!$ids) throw new RuntimeException('No article IDs supplied');
foreach ($ids as &$id) {
    $id = SpotPage_nntprelay::sanitizeAndValidateMessageId($id);
    if ($id === null) throw new RuntimeException('Invalid article ID');
}
unset($id);
$clients = []; $slots = []; $next = 0; $bytes = 0; $articles = 0; $missing = 0;
$start = microtime(true); $dataStart = null;
try {
    for ($i = 0; $i < $count; $i++) {
        $slot = SpotPage_nntprelay::acquireProviderConnectionSlot($server, $limit, 0);
        if (!$slot) throw new RuntimeException('Provider slots busy; stop browser downloads before benchmarking');
        $slots[] = $slot;
        $clients[] = ['up' => new Services_Nntp_RelayUpstream($server), 'input' => '', 'output' => '', 'body' => false, 'offset' => 0, 'pending' => 0];
    }
    while (microtime(true) - $start < $seconds + 20 && ($dataStart === null || microtime(true) - $dataStart < $seconds)) {
        $read = []; $write = []; $except = null;
        foreach ($clients as &$c) {
            $s = $c['up']->stream; $read[] = $s;
            if ($c['up']->ready) {
                if ($dataStart === null) $dataStart = microtime(true);
                while ($c['pending'] < 8) {
                    $c['output'] .= 'BODY <'.$ids[$next++ % count($ids)].">\r\n";
                    $c['pending']++;
                }
                if ($c['output'] !== '') $write[] = $s;
            } elseif ($c['up']->wantsWrite()) $write[] = $s;
        }
        unset($c);
        stream_select($read, $write, $except, 0, 10000);
        foreach ($clients as &$c) {
            $s = $c['up']->stream;
            if (!$c['up']->ready) {
                $c['up']->tick(in_array($s, $read, true), in_array($s, $write, true));
                continue;
            }
            if (in_array($s, $write, true) && $c['output'] !== '') {
                $n = fwrite($s, $c['output']);
                if ($n === false) throw new RuntimeException('Provider write failed');
                $c['output'] = substr($c['output'], $n);
            }
            if (!in_array($s, $read, true)) continue;
            $budget = 1048576;
            while ($budget > 0) {
                $chunk = fread($s, 262144);
                if ($chunk === false || ($chunk === '' && feof($s))) throw new RuntimeException('Provider closed connection');
                if ($chunk === '') break;
                $budget -= strlen($chunk); $c['input'] .= $chunk;
            }
            while (true) {
                if (!$c['body']) {
                    $nl = strpos($c['input'], "\n");
                    if ($nl === false) break;
                    $code = (int) substr($c['input'], 0, 3);
                    $c['input'] = substr($c['input'], $nl + 1);
                    if ($code === 430 || $code === 423) { $missing++; $c['pending']--; continue; }
                    if ($code !== 222) throw new RuntimeException('Unexpected provider status '.$code);
                    $c['body'] = true; $c['offset'] = 0;
                }
                $end = strpos($c['input'], "\r\n.\r\n", $c['offset']);
                if ($end === false) { $c['offset'] = max(0, strlen($c['input']) - 4); break; }
                $bytes += $end + 2; $articles++; $c['pending']--;
                $c['input'] = substr($c['input'], $end + 5); $c['body'] = false;
            }
        }
        unset($c);
    }
    $elapsed = $dataStart === null ? 0 : microtime(true) - $dataStart;
    echo json_encode(['connections' => $count, 'seconds' => round($elapsed, 2), 'articleMBps' => $elapsed ? round($bytes / $elapsed / 1000000, 2) : 0, 'articles' => $articles, 'missing' => $missing]), PHP_EOL;
} finally {
    foreach ($clients as $c) if (is_resource($c['up']->stream)) fclose($c['up']->stream);
    foreach ($slots as $slot) SpotPage_nntprelay::releaseUserConnectionSlot($slot);
}
