<?php

require_once __DIR__.'/../services/Nntp/Services_Nntp_ConnectionLimit.php';

/**
 * First-run setup wizard. Only reachable while the 'onboarding_pending'
 * setting is set (docker-init sets it on a brand new install).
 */
class SpotPage_setup extends SpotPage_Abs
{
    /** Providers shown first in the wizard (names as in usenetservers.xml). */
    const POPULAR = ['Spotnews', 'Eweka', 'Newshosting', 'Giganews EU', 'Giganews US', 'Astraweb', 'Tweaknews', 'UsenetServer', 'Blocknews EU', 'EasyNews EU', 'UsenetXL', 'Frugal Usenet'];

    private $_params;

    public function __construct(Dao_Factory $daoFactory, Services_Settings_Container $settings, array $currentSession, array $params)
    {
        // Standalone page; theme templates are not needed, but a helper object is
        $currentSession['active_tpl'] = 'modern';
        parent::__construct($daoFactory, $settings, $currentSession);

        $this->_params = $params;
    }

    // ctor

    public static function isPending(Services_Settings_Container $settings)
    {
        return (bool) $settings->get('onboarding_pending');
    }

    // isPending

    public function render()
    {
        if (!static::isPending($this->_settings)) {
            header('Location: '.$this->_tplHelper->makeBaseUrl('path'));

            return;
        } // if

        $form = $this->_params['setupform'];
        $errors = [];

        // Public CA certificate only. Private keys are root-owned and never served.
        if (($this->_params['certificate'] ?? '') === '1') {
            $certificate = '/etc/spotweb/tls/ca.crt';
            if (!is_readable($certificate)) {
                http_response_code(404);

                return;
            }
            header('Content-Type: application/x-x509-ca-cert');
            header('Content-Disposition: attachment; filename="spotweb3-local-ca.crt"');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
            readfile($certificate);

            return;
        }

        if ($form['action'] === 'testnntp') {
            $this->renderNntpTest($form);

            return;
        } // if

        if ($form['action'] === 'finish') {
            $errors = $this->finish($form);
            if (empty($errors)) {
                header('Location: '.$this->_tplHelper->makeBaseUrl('path'));

                return;
            } // if
        } // if

        $this->_pageTitle = _('Welcome to Spotweb');
        $this->template('setup', [
            'providers' => $this->loadProviders(),
            'popular'   => self::POPULAR,
            'errors'    => $errors,
            'values'    => isset($form['username']) ? $form : [],
            'https_port' => is_readable('/etc/spotweb/tls/ca.crt') ? (int) getenv('SPOTWEB_HTTPS_PORT') : 0,
        ]);
    }

    // render

    /**
     * Ajax endpoint: tries to connect to the given news server. Returns a fresh
     * xsrf token as well, since the wizard page can stay open for a long time.
     */
    private function renderNntpTest(array $form)
    {
        $server = $this->buildServer($form);
        $error = $server['host'] === '' ? _('Enter a server address first') : $this->_tplHelper->validateNntpServer($server);

        $this->sendContentTypeHeader('json');
        echo json_encode(['ok' => $error === '', 'message' => $error === '' ? _('Connection successful') : $error, 'xsrf' => SpotReq::generateXsrfCookie('setupform')]);
    }

    // renderNntpTest

    private function buildServer(array $form)
    {
        $enc = isset($form['nntp_enc']) ? strtolower($form['nntp_enc']) : 'tls';
        $enc = in_array($enc, ['tls', 'starttls'], true) ? $enc : false;

        return [
            'host'                   => trim(isset($form['nntp_host']) ? $form['nntp_host'] : ''),
            'user'                   => isset($form['nntp_user']) ? $form['nntp_user'] : '',
            'pass'                   => isset($form['nntp_pass']) ? $form['nntp_pass'] : '',
            'enc'                    => $enc,
            'port'                   => (int) (isset($form['nntp_port']) && $form['nntp_port'] !== '' ? $form['nntp_port'] : ($enc ? 563 : 119)),
            'buggy'                  => false,
            'verifyname'             => true,
            'article_pipeline_depth' => Services_Nntp_PipelineDepth::DefaultDepth,
        ];
    }

    // buildServer

    /** Normalize the chosen download method before creating any accounts. */
    public static function buildDownloadPreferences(array $form)
    {
        $method = isset($form['download_method']) ? $form['download_method'] : 'browser';
        if (!in_array($method, ['browser', 'nzb', 'push-sabnzbd', 'nzbget'], true)) {
            throw new InvalidArgumentException('Choose a valid download method');
        }
        $prefs = ['action' => $method === 'nzb' ? 'disable' : $method, 'prepare_action' => 'merge'];
        if ($method === 'browser' && (string) ($form['download_folder_selected'] ?? '') !== '1') {
            throw new InvalidArgumentException('Select a download location before continuing with browser downloads');
        }
        if ($method === 'push-sabnzbd') {
            $url = trim($form['sab_url'] ?? '');
            $parts = parse_url($url);
            if (!$parts || empty($parts['host']) || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) {
                throw new InvalidArgumentException('Enter a valid HTTP or HTTPS URL for SABnzbd');
            }
            if (trim($form['sab_api_key'] ?? '') === '') {
                throw new InvalidArgumentException('Enter the SABnzbd API key');
            }
            $prefs['sabnzbd'] = ['url' => rtrim($url, '/').'/', 'apikey' => trim($form['sab_api_key']), 'username' => '', 'password' => ''];
        }
        if ($method === 'nzbget') {
            $host = trim($form['nzbget_host'] ?? '');
            $port = filter_var($form['nzbget_port'] ?? 6789, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
            if ($host === '' || preg_match('/[\s\/?#]/', $host) || $port === false) {
                throw new InvalidArgumentException('Enter a valid NZBGet host and port');
            }
            $prefs['nzbget'] = [
                'host' => $host, 'port' => $port, 'timeout' => 30,
                'username' => $form['nzbget_user'] ?? '', 'password' => $form['nzbget_password'] ?? '',
                'ssl' => !empty($form['nzbget_ssl']) ? 'on' : '',
            ];
        }

        return $prefs;
    }

    /**
     * Applies the wizard. Returns a list of error messages, empty on success.
     */
    private function finish(array $form)
    {
        $user = [
            'username'     => trim(isset($form['username']) ? $form['username'] : ''),
            'firstname'    => trim(isset($form['firstname']) ? $form['firstname'] : ''),
            'lastname'     => trim(isset($form['lastname']) ? $form['lastname'] : ''),
            'mail'         => trim(isset($form['mail']) ? $form['mail'] : ''),
            'newpassword1' => isset($form['newpassword1']) ? $form['newpassword1'] : '',
            'newpassword2' => isset($form['newpassword2']) ? $form['newpassword2'] : '',
        ];
        $anonymous = !empty($form['anonymous']);
        $theme = isset($form['theme']) && in_array($form['theme'], ['light', 'dark', 'auto'], true) ? $form['theme'] : 'auto';
        $skipNntp = !empty($form['skipnntp']);
        $prefetchImages = !empty($form['prefetch_images']);
        $hideErotica = !empty($form['hide_erotica']);

        $svcUserRecord = new Services_User_Record($this->_daoFactory, $this->_settings);
        $result = $svcUserRecord->validateUserRecord($user, false);
        $maxConnections = $form['nntp_max_connections'] ?? Services_Nntp_ConnectionLimit::DefaultConnections;
        if (!Services_Nntp_ConnectionLimit::validate($maxConnections)) {
            $result->addError(_('Maximum download connections must be an integer between 1 and 100'));
        }
        try {
            $downloadPrefs = self::buildDownloadPreferences($form);
        } catch (InvalidArgumentException $error) {
            $result->addError($error->getMessage());
        }
        if ($this->_daoFactory->getUserDao()->findUserIdForName($user['username'])) {
            $result->addError(sprintf(_("'%s' already exists"), $user['username']));
        } // if

        $server = $this->buildServer($form);
        if (!$skipNntp && $server['host'] === '') {
            $result->addError(_('Choose a Usenet provider, or tick "Skip for now"'));
        } // if

        if (!$result->isSuccess()) {
            return $result->getErrors();
        } // if

        // Create the user, then give it the chosen password (a random one is assigned on creation)
        $created = $svcUserRecord->createUserRecord($user);
        if (!$created->isSuccess()) {
            return $created->getErrors();
        } // if
        $user['userid'] = $created->getData('userid');
        $svcUserRecord->setUserPassword($user);

        // Spotweb's built-in admin account gets the same password so it is never left on the default
        $adminUser = $svcUserRecord->getUser(SPOTWEB_ADMIN_USERID);
        $adminUser['newpassword1'] = $user['newpassword1'];
        $svcUserRecord->setUserPassword($adminUser);

        if (!$skipNntp) {
            foreach (['nntp_nzb', 'nntp_hdr', 'nntp_post'] as $name) {
                $this->_settings->set($name, $server);
            } // foreach
        } // if

        // Anonymous browsing on = 'public' system, off = 'shared' (login required)
        $engine = (new Services_Admin_ServerInfo($this->_daoFactory, $this->_settings))->getEngineName();
        $svcUpgradeBase = new Services_Upgrade_Base($this->_daoFactory, $this->_settings, 'pdo_'.$engine);
        $this->_settings->set('custom_admin_userid', $user['userid']);
        $svcUpgradeBase->resetSystemType($anonymous ? 'public' : 'shared');

        $downloadUser = $svcUserRecord->getUser($user['userid']);
        $downloadUser['prefs']['nzbhandling'] = array_replace_recursive($downloadUser['prefs']['nzbhandling'] ?? [], $downloadPrefs);
        $downloadUser['prefs']['show_nzbbutton'] = true;
        $this->_daoFactory->getUserDao()->setUser($downloadUser);

        // Download covers / post images while syncing
        $this->_settings->set('prefetch_image', $prefetchImages);

        // Optionally keep erotic content out of the overview and the filter list
        if ($hideErotica) {
            $this->hideEroticContent([$user['userid'], $this->_settings->get('nonauthenticated_userid')]);
        } // if

        $this->_settings->set('default_theme_mode', $theme);
        $this->_settings->set(Services_Nntp_ConnectionLimit::SettingName, Services_Nntp_ConnectionLimit::normalize($maxConnections));
        $this->_settings->remove('onboarding_pending');

        // Log the new user straight in
        $svcUserAuth = new Services_User_Authentication($this->_daoFactory, $this->_settings);
        $svcUserAuth->authenticate($user['username'], $user['newpassword1']);

        return [];
    }

    // finish

    /**
     * Excludes the erotic category from the index page and removes its filters from
     * the sidebar for the given users.
     */
    private function hideEroticContent(array $userIds)
    {
        $svcUserFilters = new Services_User_Filters($this->_daoFactory, $this->_settings);
        $conn = $this->_daoFactory->getConnection();
        foreach (array_unique(array_map('intval', $userIds)) as $userId) {
            if ($userId < 1) {
                continue;
            } // if
            $svcUserFilters->setEroticIndexFilter($userId);
            $conn->modify(
                "DELETE FROM filters WHERE userid = :userid AND filtertype = 'filter' AND tree LIKE :tree",
                [':userid' => [$userId, PDO::PARAM_INT], ':tree' => ['cat0_z3%', PDO::PARAM_STR]]
            );
        } // foreach
    }

    // hideEroticContent

    /**
     * Reads usenetservers.xml into [name => [host, port, enc]].
     */
    private function loadProviders()
    {
        $providers = [];
        $xml = @simplexml_load_string(file_get_contents(dirname(__DIR__, 2).'/usenetservers.xml'));
        if ($xml === false) {
            return $providers;
        } // if

        foreach ($xml->usenetservers->server as $server) {
            $variant = isset($server->ssl) ? $server->ssl->header : (isset($server->plain) ? $server->plain->header : null);
            if ($variant === null) {
                continue;
            } // if
            $encrypted = isset($server->ssl);
            $providers[(string) $server['name']] = [
                'host' => trim((string) $variant),
                'port' => (int) $variant['port'],
                'enc'  => $encrypted ? 'tls' : '',
            ];
        } // foreach

        return $providers;
    }

    // loadProviders
} // class SpotPage_setup
