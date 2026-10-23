<?php

require_once __DIR__.'/../services/Retriever/Services_Retriever_Schedule.php';

/**
 * JSON status of the spot retriever, polled by the menu bar sync indicator.
 */
class SpotPage_syncstatus extends SpotPage_Abs
{
    private $params;
    public function __construct(Dao_Factory $daoFactory, Services_Settings_Container $settings, array $currentSession, array $params = [])
    {
        parent::__construct($daoFactory, $settings, $currentSession);
        $this->params = $params;
    }

    // ctor

    public function render()
    {
        $this->_spotSec->fatalPermCheck(SpotSecurity::spotsec_view_spots_index, '');

        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $this->_spotSec->fatalPermCheck(SpotSecurity::spotsec_retrieve_spots, '');
            $this->sendExpireHeaders(true);
            $this->sendContentTypeHeader('json');
            if (($this->params['syncform']['action'] ?? '') !== 'retrieve') {
                http_response_code(400);
                echo json_encode(['error' => _('Refresh authorization expired. Reload the page and try again.')]);
                return;
            }
            $schedule = Services_Retriever_Schedule::status($this->_daoFactory, $this->_settings);
            if (!$schedule['schedulerActive']) {
                http_response_code(503);
                echo json_encode(['error' => _('Background retriever is not running. Start the retrieval scheduler.')]);
                return;
            }
            if (!$schedule['queued'] && empty($schedule['running'])) {
                $this->_settings->set(Services_Retriever_Schedule::REQUEST, bin2hex(random_bytes(12)));
            }
            echo json_encode(['ok' => true, 'queued' => true]);
            return;
        }

        $conn = $this->_daoFactory->getConnection();
        $now = time();

        $server = $this->_settings->get('nntp_hdr');
        $configured = is_array($server) && !empty($server['host']);

        // database side: when did each retriever last finish / is one marked as running
        $state = [];
        foreach ($conn->arrayQuery('SELECT infotype, curarticlenr, lastretrieved, nowrunning FROM usenetstate') as $row) {
            $state[$row['infotype']] = [
                'lastretrieved' => (int) $row['lastretrieved'],
                'nowrunning'    => (int) $row['nowrunning'],
            ];
        } // foreach

        // file side: detailed progress of the current / last run
        $progress = Services_Retriever_Progress::read($this->_daoFactory);
        $schedule = Services_Retriever_Schedule::status($this->_daoFactory, $this->_settings);
        $types = [];
        $running = false;
        foreach ($progress as $type => $p) {
            $isRunning = (isset($p['phase']) && $p['phase'] === 'running') && (($now - (int) $p['updated']) < 180);
            $total = max(0, (int) $p['last'] - (int) $p['start']);
            $pct = $total > 0 ? (int) min(100, max(0, round(((int) $p['cur'] - (int) $p['start']) / $total * 100))) : 0;
            if (isset($p['phase']) && $p['phase'] === 'done') {
                $pct = 100;
            } // if
            $types[$type] = [
                'running'   => $isRunning,
                'percent'   => $pct,
                'processed' => (int) (isset($p['processed']) ? $p['processed'] : 0),
                'stage' => $p['stage'] ?? 'history',
                'previewAvailable' => (int) ($p['previewAvailable'] ?? 0),
                'started'   => isset($p['started']) ? (int) $p['started'] : null,
                'finished'  => isset($p['finished']) ? (int) $p['finished'] : null,
            ];
            $running = $running || $isRunning;
        } // foreach

        // a run without progress information (older retriever, other host) still counts as running
        if (!$running) {
            foreach ($state as $s) {
                if ($s['nowrunning'] > 0 && ($now - $s['nowrunning']) < 300) {
                    $running = true;
                } // if
            } // foreach
        } // if

        // A failed worker can leave a recent progress file behind. Do not keep
        // advertising an active sync after the scheduler has recorded its failure.
        if (!empty($schedule['error']) && empty($schedule['running'])) {
            $latestProgress = 0;
            foreach ($progress as $p) {
                $latestProgress = max($latestProgress, (int) ($p['updated'] ?? 0));
            }
            if ((int) ($schedule['finished'] ?? 0) >= $latestProgress) {
                $running = false;
                foreach ($types as &$type) {
                    $type['running'] = false;
                }
                unset($type);
            }
        }

        $spots = (int) $conn->singleQuery('SELECT COUNT(1) FROM spots');

        $this->sendExpireHeaders(true);
        $this->sendContentTypeHeader('json');
        echo json_encode([
            'configured' => $configured,
            'running'    => $running,
            'last'       => isset($state['Spots']) ? $state['Spots']['lastretrieved'] : 0,
            'spots'      => $spots,
            'initialSyncIncomplete' => (bool) $this->_settings->get(Services_Retriever_Schedule::INITIAL_PENDING),
            'types'      => $types,
            'now'        => $now,
            'schedule'   => $schedule,
            'syncToken'  => $this->_spotSec->allowed(SpotSecurity::spotsec_retrieve_spots, '') ? SpotReq::generateXsrfCookie('syncform') : null,
        ]);
    }

    // render
} // class SpotPage_syncstatus
