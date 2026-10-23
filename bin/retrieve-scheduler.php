#!/usr/bin/php
<?php
// One scheduler tick. The entrypoint repeats this every five seconds, so saved
// settings are reloaded immediately and manual requests also work in manual-only mode.
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require_once __DIR__.'/../vendor/autoload.php';
require_once __DIR__.'/../lib/services/Retriever/Services_Retriever_Schedule.php';
chdir(dirname(__DIR__));
$bootstrap = new Bootstrap();
list($settings, $dao) = $bootstrap->boot();
$lock = fopen(Services_Retriever_Schedule::path($dao, 'lock'), 'c+');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) exit;
try {
    $state = Services_Retriever_Schedule::read($dao);
    $state['heartbeat'] = time();
    $state['running'] = false;
    $request = $settings->exists(Services_Retriever_Schedule::REQUEST) ? $settings->get(Services_Retriever_Schedule::REQUEST) : '';
    $due = Services_Retriever_Schedule::due(Services_Retriever_Schedule::interval($settings), $state, $request, time());
    Services_Retriever_Schedule::write($dao, $state);
    if (!$due) exit;
    $server = $settings->get('nntp_hdr');
    if (empty($server['host'])) exit;
    $state['attempted'] = time();
    $state['running'] = true;
    $state['handledRequest'] = $request;
    $state['error'] = null;
    unset($state['finished']);
    Services_Retriever_Schedule::write($dao, $state);
    $log = rtrim($dao->getCachePath(), '/\\').'/retriever-last.log';
    $process = proc_open([PHP_BINARY, __DIR__.'/../retrieve.php'], [
        0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'w'], 2 => ['redirect', 1],
    ], $pipes, dirname(__DIR__));
    if (!is_resource($process)) throw new RuntimeException('Could not start retriever');
    do {
        $processState = proc_get_status($process);
        $state['heartbeat'] = time();
        Services_Retriever_Schedule::write($dao, $state);
        if ($processState['running']) sleep(2);
    } while ($processState['running']);
    proc_close($process);
    $output = (string) file_get_contents($log);
    $state['running'] = false;
    $state['finished'] = time();
    $state['heartbeat'] = time();
    $state['error'] = $processState['exitcode'] !== 0 || preg_match('/crashed|Fatal error|Unable to connect|There is an error/i', $output)
        ? 'Retrieval failed. Check your newsserver settings and the retrieval log.' : null;
    Services_Retriever_Schedule::write($dao, $state);
} catch (Throwable $error) {
    $state['running'] = false;
    $state['finished'] = time();
    $state['heartbeat'] = time();
    $state['error'] = 'Unable to run retrieval. Check the background retriever and newsserver settings.';
    Services_Retriever_Schedule::write($dao, $state);
    error_log('[retrieve-scheduler] Retrieval worker failed ('.get_class($error).')');
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}
