<?php

/** Combine stage progress with worker completion; one stream's 100% is not run completion. */
class Services_Retriever_Status
{
    public static function summarize(array $progress, array $state, array $schedule, $now)
    {
        $attempted = (int) ($schedule['attempted'] ?? 0);
        $finished = empty($schedule['running']) ? (int) ($schedule['finished'] ?? 0) : 0;
        $workerRunning = !empty($schedule['running']) && !empty($schedule['schedulerActive']);
        $run = isset($progress['Run']) && (int) ($progress['Run']['started'] ?? 0) >= $attempted ? $progress['Run'] : null;
        $start = max($attempted, (int) ($run['started'] ?? 0));
        $types = [];
        $running = $workerRunning;
        foreach ($progress as $type => $p) {
            if ($type === 'Run') continue;
            $updated = (int) ($p['updated'] ?? 0);
            $isRunning = ($p['phase'] ?? '') === 'running' && $now - $updated < 180 &&
                (int) ($p['started'] ?? 0) >= $start && $updated > $finished;
            $total = max(0, (int) ($p['last'] ?? 0) - (int) ($p['start'] ?? 0));
            // Rounding a final batch to 100% is misleading until it has committed.
            $pct = $total > 0 ? (int) min(99, max(0, round(((int) ($p['cur'] ?? 0) - (int) ($p['start'] ?? 0)) / $total * 100))) : 0;
            if (($p['phase'] ?? '') === 'done') $pct = 100;
            $types[$type] = ['running' => $isRunning, 'percent' => $pct,
                'processed' => (int) ($p['processed'] ?? 0), 'stage' => $p['stage'] ?? 'history',
                'previewAvailable' => (int) ($p['previewAvailable'] ?? 0),
                'started' => isset($p['started']) ? (int) $p['started'] : null,
                'finished' => isset($p['finished']) ? (int) $p['finished'] : null];
            $running = $running || $isRunning;
        }
        foreach ($state as $s) {
            $since = (int) ($s['nowrunning'] ?? 0);
            if ($since > $finished && $since >= $start && $now - $since < 300) $running = true;
        }
        if ($run) {
            if (in_array($run['phase'] ?? '', ['done', 'error'], true)) {
                $running = false;
            } elseif ($finished >= (int) ($run['updated'] ?? 0)) {
                $run['phase'] = empty($schedule['error']) ? 'done' : 'error';
                $run['stage'] = $run['phase'];
                $running = false;
            } elseif ($workerRunning || $running || $now - (int) ($run['updated'] ?? 0) < 180) {
                $running = true;
            } else {
                $run['phase'] = $run['stage'] = 'stalled';
                $running = false;
            }
            if (!$running) {
                foreach ($types as &$type) $type['running'] = false;
                unset($type);
            }
        }

        return ['running' => $running, 'types' => $types, 'run' => $run];
    }
}
