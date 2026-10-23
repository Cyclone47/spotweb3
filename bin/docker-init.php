#!/usr/bin/php
<?php

/*
 * First-boot initialisation for container installs.
 *
 * Creates/upgrades the schema, then (once) applies the SPOTWEB_* environment
 * variables: admin password and the Usenet server. Safe to run on every start.
 */

error_reporting(E_ALL & ~E_DEPRECATED);

if (PHP_SAPI !== 'cli') {
    exit('docker-init.php can only be run from the console');
}

function env($name, $default = '')
{
    $value = getenv($name);

    return ($value === false || $value === '') ? $default : $value;
}

try {
    require_once __DIR__.'/../vendor/autoload.php';

    $dataDir = env('SPOTWEB_DATA_DIR', __DIR__.'/../data');
    @mkdir($dataDir.'/cache', 0775, true);

    $bootstrap = new Bootstrap();
    $daoFactory = $bootstrap->getDaoFactory();
    $settings = $bootstrap->getSettings($daoFactory, false);
    $dbSettings = $bootstrap->getDbSettings();

    echo 'Updating schema ('.$dbSettings['engine'].')'.PHP_EOL;
    $svcUpgradeBase = new Services_Upgrade_Base($daoFactory, $settings, $dbSettings['engine']);
    $svcUpgradeBase->database();

    /*
     * On a fresh database the settings table did not exist yet when the settings
     * source was set up above, so it was silently skipped (this is also why
     * bin/upgrade-db.php has to be run twice on a new install). Continue in a
     * fresh process, where the table exists.
     */
    if (getenv('SPOTWEB_INIT_STAGE') !== '2') {
        putenv('SPOTWEB_INIT_STAGE=2');
        passthru(escapeshellarg(PHP_BINARY).' '.escapeshellarg(__FILE__), $exitCode);
        exit($exitCode);
    }

    $svcUpgradeBase->users();
    $svcUpgradeBase->usenetState();
    $svcUpgradeBase->settings();

    /*
     * Everything below is only applied on the very first start, so changes
     * made later in the admin center are never overwritten by the environment.
     */
    $marker = $dataDir.'/.initialized';
    if (file_exists($marker)) {
        echo 'Already initialised, done'.PHP_EOL;
        exit(0);
    }

    $adminPassword = env('SPOTWEB_ADMIN_PASSWORD');
    if ($adminPassword !== '') {
        echo 'Setting admin password'.PHP_EOL;
        $svcUpgradeUsers = new Services_Upgrade_Users($daoFactory, $settings);
        $svcUpgradeUsers->resetUserPassword('admin', $adminPassword);
    }

    if (env('SPOTWEB_NNTP_HOST') !== '') {
        $enc = strtolower(env('SPOTWEB_NNTP_ENCRYPTION', 'tls'));
        $noEnc = in_array($enc, ['none', 'false', '0'], true);
        $server = [
            'host'                   => env('SPOTWEB_NNTP_HOST'),
            'user'                   => env('SPOTWEB_NNTP_USER'),
            'pass'                   => env('SPOTWEB_NNTP_PASS'),
            'enc'                    => $noEnc ? false : $enc,
            'port'                   => (int) env('SPOTWEB_NNTP_PORT', $noEnc ? 119 : 563),
            'buggy'                  => false,
            'verifyname'             => true,
            'article_pipeline_depth' => Services_Nntp_PipelineDepth::DefaultDepth,
        ];
        echo 'Configuring Usenet server '.$server['host'].PHP_EOL;
        $settingDao = $daoFactory->getSettingDao();
        foreach (['nntp_nzb', 'nntp_hdr', 'nntp_post'] as $name) {
            $settingDao->updateSetting($name, $server);
        }
    }

    if (env('SPOTWEB_SYSTEMTYPE') !== '') {
        $svcUpgradeBase->resetSystemType(env('SPOTWEB_SYSTEMTYPE'));
    }

    if (env('SPOTWEB_SKIP_ONBOARDING') === '') {
        // The first visitor is guided through the setup wizard (?page=setup)
        $daoFactory->getSettingDao()->updateSetting('onboarding_pending', '1');
    }

    file_put_contents($marker, date('c'));
    echo 'Initialisation done'.PHP_EOL;
} catch (Throwable $x) {
    fwrite(STDERR, 'docker-init failed: '.$x->getMessage().PHP_EOL);
    exit(1);
}
