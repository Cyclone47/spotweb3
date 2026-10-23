<?php

require_once __DIR__.'/../services/Retriever/Services_Retriever_Schedule.php';

/**
 * Admin center: one place for server management. Tabs: management links,
 * server info and maintenance.
 */
class SpotPage_admin extends SpotPage_Abs
{
    const TABS = ['manage', 'serverinfo', 'maintenance'];

    private $_params;

    public function __construct(Dao_Factory $daoFactory, Services_Settings_Container $settings, array $currentSession, array $params)
    {
        /*
         * The admin center is only implemented in the modern theme, so always
         * render with it regardless of the user's preferred theme.
         */
        $currentSession['active_tpl'] = 'modern';
        parent::__construct($daoFactory, $settings, $currentSession);

        $this->_params = $params;
    }

    // ctor

    public function render()
    {
        $canEditSettings = $this->_spotSec->allowed(SpotSecurity::spotsec_edit_settings, '');
        $canEditPrefs = $this->_spotSec->allowed(SpotSecurity::spotsec_edit_own_userprefs, '');
        $canManageUsers = $this->_spotSec->allowed(SpotSecurity::spotsec_edit_other_users, '')
            || $this->_spotSec->allowed(SpotSecurity::spotsec_list_all_users, '')
            || $this->_spotSec->allowed(SpotSecurity::spotsec_edit_securitygroups, '');

        if (!$canEditSettings && !$canEditPrefs && !$canManageUsers) {
            $this->_spotSec->fatalPermCheck(SpotSecurity::spotsec_edit_settings, '');
        } // if

        $this->_pageTitle = _('Admin center');

        $tab = in_array($this->_params['tab'], self::TABS, true) ? $this->_params['tab'] : 'manage';
        if ($tab !== 'manage' && !$canEditSettings) {
            $tab = 'manage';
        } // if
        $form = $this->_params['adminform'];

        $result = null;
        if ($form['action'] === 'saveretrieval') {
            $this->_spotSec->fatalPermCheck(SpotSecurity::spotsec_edit_settings, '');
            $interval = $form['interval'] ?? '';
            if (Services_Retriever_Schedule::validate($interval)) {
                $this->_settings->set(Services_Retriever_Schedule::SETTING, (int) $interval);
                $result = ['ok' => true, 'message' => _('Automatic retrieval schedule saved.')];
            } else {
                $result = ['ok' => false, 'message' => _('Choose a valid retrieval interval.')];
            }
            $tab = 'manage';
        }
        if ($form['action'] === 'runtask') {
            $this->_spotSec->fatalPermCheck(SpotSecurity::spotsec_edit_settings, '');
            $svcMaintenance = new Services_Admin_Maintenance($this->_daoFactory, $this->_settings);
            $task = isset($form['task']) ? $form['task'] : '';

            // Destructive tasks need an explicit confirmation on top of the xsrf token
            if (!empty(Services_Admin_Maintenance::TASKS[$task][3]) && empty($form['confirm'])) {
                $result = ['ok' => false, 'message' => 'Tick the confirmation box to run this task'];
            } else {
                $result = $svcMaintenance->run($task, isset($form['days']) ? $form['days'] : 0);
            } // else
            $tab = 'maintenance';
        } // if

        $svcServerInfo = new Services_Admin_ServerInfo($this->_daoFactory, $this->_settings);

        $this->template('admin', [
            'tab'        => $tab,
            'result'     => $result,
            'serverinfo' => ($tab === 'serverinfo' && $canEditSettings) ? $svcServerInfo->collect() : null,
            'tasks'      => Services_Admin_Maintenance::TASKS,
            'retrievalSchedule' => $canEditSettings ? Services_Retriever_Schedule::status($this->_daoFactory, $this->_settings) : null,
            'retrievalIntervals' => Services_Retriever_Schedule::OPTIONS,
        ]);
    }

    // render
} // class SpotPage_admin
