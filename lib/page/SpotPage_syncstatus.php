<?php

require_once __DIR__.'/../services/Retriever/Services_Retriever_Schedule.php';
require_once __DIR__.'/../services/Retriever/Services_Retriever_Status.php';

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
        $summary = Services_Retriever_Status::summarize($progress, $state, $schedule, $now);

        $spots = (int) $conn->singleQuery('SELECT COUNT(1) FROM spots');

        $this->sendExpireHeaders(true);
        $this->sendContentTypeHeader('json');
        echo json_encode([
            'configured' => $configured,
            'running'    => $summary['running'],
            'last'       => isset($state['Spots']) ? $state['Spots']['lastretrieved'] : 0,
            'spots'      => $spots,
            'initialSyncIncomplete' => (bool) $this->_settings->get(Services_Retriever_Schedule::INITIAL_PENDING),
            'types'      => $summary['types'],
            'run'        => $summary['run'],
            'now'        => $now,
            'schedule'   => $schedule,
            'syncToken'  => $this->_spotSec->allowed(SpotSecurity::spotsec_retrieve_spots, '') ? SpotReq::generateXsrfCookie('syncform') : null,
        ]);
    }

    // render
} // class SpotPage_syncstatus
