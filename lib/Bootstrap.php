<?php

/*
 * Define several version constants
 * used throughput Spotweb
 */
define('SPOTWEB_SETTINGS_VERSION', '0.42');
define('SPOTWEB_SECURITY_VERSION', '0.35');
define('SPOTDB_SCHEMA_VERSION', '0.71');
define('SPOTWEB_VERSION', '0.'.(SPOTDB_SCHEMA_VERSION * 100).'.'.(SPOTWEB_SETTINGS_VERSION * 100).'.'.(SPOTWEB_SECURITY_VERSION * 100));

/*
 * Define several constants regarding "fixed"
 * userids, used by Spotweb.
 */
define('SPOTWEB_ANONYMOUS_USERID', 1);
define('SPOTWEB_ADMIN_USERID', 2);

/*
 * Define variables
 * $settings and $dbsettings
 */
$settings = [];
$dbsettings = [];

/*
 * Spotweb bootstrapping code.
 *
 */
class Bootstrap
{
    private $_dbSettings;

    /**
     * Boot up the Spotweb system.
     *
     * @return array (Services_Settings_Container|Dao_Factory_Base|SpotReq)[]
     */
    public function boot()
    {
        SpotTiming::start('bootstrap');
        $daoFactory = $this->getDaoFactory();
        $settings = $this->getSettings($daoFactory, true);
        $spotReq = $this->getSpotReq($settings);
        $GLOBALS['_intl'] = extension_loaded('intl');

        /*
         * Set the cache path
         */
        if ($settings->exists('cache_path')) {
            $cachePath = $settings->get('cache_path');
            if (!empty($cachePath)) {
                if (strpos($cachePath, './') === 0 or strpos($cachePath, '.\\') === 0) {
                    $cachePath = __DIR__.'/../'.substr($cachePath, 2);
                }
            } else {
                $cachePath = __DIR__.'/../cache';
            }
        } else {
            $cachePath = __DIR__.'/../cache';
        } // if

        $daoFactory->setCachePath($cachePath);

        /*
         * Run the validation of the most basic systems
         * in Spotweb
         */
        $this->validate(new Services_Settings_Base($settings, $daoFactory->getBlackWhiteListDao()));

        /*
         * Disable the timing part as soon as possible because it
         * gobbles memory
         */
        if (!$settings->get('enable_timing')) {
            SpotTiming::disable();
        } // if

        /*
         * Disable XML entity loader as this might be an
         * security issue.
         */
        if (\PHP_VERSION_ID < 80000) {
            libxml_disable_entity_loader(true);
        }

        SpotTiming::stop('bootstrap');

        return [$settings, $daoFactory, $spotReq];
    }

    // boot

    /**
     * Returns the DAO factory used by all of
     * Spotweb.
     *
     * @throws DatabaseConnectionException
     *
     * @return Dao_Base_Factory
     */
    public function getDaoFactory()
    {
        SpotTiming::start(__CLASS__.'::'.__FUNCTION__);

        if (!file_exists(__DIR__.'/../dbsettings.inc.php') && ($envDbSettings = static::getEnvDbSettings()) !== null) {
            $dbsettings = $envDbSettings;
        } elseif (!file_exists(__DIR__.'/../dbsettings.inc.php')) {
            throw new DatabaseConnectionException("No database settings have been entered, please use the 'install.php' wizard to install and configure Spotweb.".PHP_EOL.'If you are upgrading from an earlier version of Spotweb, please consult https://github.com/spotweb/spotweb/wiki/Frequently-asked-questions/ first');
        } else {
            require __DIR__.'/../dbsettings.inc.php';
        }

        /*
         * Store the DB settings so we can retrieve them later, if so desired,
         * we do overwrite the password to make sure it doesn't show up in a
         * stacktrace.
         */

        switch ($dbsettings['engine']) {
            case 'mysql':
            case 'pdo_mysql':
                if (!isset($dbsettings['port'])) {
                    $dbsettings['port'] = '3306';
                }
                if (!isset($dbsettings['schema'])) {
                    $dbsettings['schema'] = '';
                }
                break;
            case 'pdo_pgsql':
                if (!isset($dbsettings['port'])) {
                    $dbsettings['port'] = '5432';
                }
                if (!isset($dbsettings['schema'])) {
                    $dbsettings['schema'] = 'public';
                }
                break;
            default:
                if (!isset($dbsettings['port'])) {
                    $dbsettings['port'] = '';
                }
                if (!isset($dbsettings['schema'])) {
                    $dbsettings['schema'] = '';
                }
        }
        $this->_dbSettings = $dbsettings;
        $this->_dbSettings['pass'] = '**overwritten**';
        $this->_dbSettings['user'] = '**overwritten**';

        $dbCon = dbeng_abs::getDbFactory($dbsettings['engine']);
        $dbCon->connect(
            $dbsettings['host'],
            $dbsettings['user'],
            $dbsettings['pass'],
            $dbsettings['dbname'],
            $dbsettings['port'],
            $dbsettings['schema']
        );

        $daoFactory = Dao_Factory::getDAOFactory($dbsettings['engine']);
        $daoFactory->setConnection($dbCon);

        SpotTiming::stop(__CLASS__.'::'.__FUNCTION__);

        return $daoFactory;
    }

    // getDaoFactory

    /**
     * Builds the database settings from environment variables, so containers
     * can run without a dbsettings.inc.php file.
     *
     * Returns null when neither SPOTWEB_DB_ENGINE nor SPOTWEB_DATA_DIR is set.
     * When only SPOTWEB_DATA_DIR is set, a SQLite database in that directory
     * is used.
     *
     * @return array|null
     */
    public static function getEnvDbSettings()
    {
        $engine = getenv('SPOTWEB_DB_ENGINE');
        $dataDir = getenv('SPOTWEB_DATA_DIR');
        if ($engine === false || $engine === '') {
            if ($dataDir === false || $dataDir === '') {
                return null;
            } // if
            $engine = 'pdo_sqlite';
        } // if

        $env = function ($name, $default = '') {
            $value = getenv($name);

            return ($value === false || $value === '') ? $default : $value;
        };

        $dbsettings = ['engine' => $engine];
        if ($engine === 'pdo_sqlite') {
            $dbsettings['host'] = '';
            $dbsettings['user'] = '';
            $dbsettings['pass'] = '';
            $dbsettings['dbname'] = $env('SPOTWEB_DB_NAME', rtrim($env('SPOTWEB_DATA_DIR', '.'), '/\\').'/spotweb.sqlite');
        } else {
            $dbsettings['host'] = $env('SPOTWEB_DB_HOST', 'localhost');
            $dbsettings['user'] = $env('SPOTWEB_DB_USER', 'spotweb');
            $dbsettings['pass'] = $env('SPOTWEB_DB_PASS', '');
            $dbsettings['dbname'] = $env('SPOTWEB_DB_NAME', 'spotweb');
            if ($env('SPOTWEB_DB_PORT') !== '') {
                $dbsettings['port'] = $env('SPOTWEB_DB_PORT');
            } // if
            if ($env('SPOTWEB_DB_SCHEMA') !== '') {
                $dbsettings['schema'] = $env('SPOTWEB_DB_SCHEMA');
            } // if
        } // else

        return $dbsettings;
    }

    // getEnvDbSettings

    /*
     * Returns a sort of pre-flight check to see if
     * everything is setup the way we like.
     */
    private function validate(Services_Settings_Base $settings)
    {
        /*
         * The basics has been setup, lets check if the schema needs
         * updating
         */
        if (!$settings->schemaValid()) {
            throw new SchemaNotUpgradedException('Schema needs to be upgraded.');
        } // if

        /*
         * Does our global setting table need updating?
         */
        if (!$settings->settingsValid()) {
            throw new SettingsNotUpgradedException('Settings needs to be upgraded.');
        } // if

        /*
         * Because users are asked to modify ownsettings.php themselves, it is
         * possible they create a mistake and accidentally create output from it.
         *
         * This output breaks a lot of stuff like download integration, image generation
         * and more.
         *
         * We try to check if any output has been submitted, and if so, we refuse
         * to continue to prevent all sorts of confusing bug reports
         */
        if (headers_sent() || ((int) ob_get_length() > 0)) {
            throw new OwnsettingsCreatedOutputException();
        } // if
    }

    // validate

    /**
     * Bootup the settings system.
     */
    public function getSettings(Dao_Factory $daoFactory, $requireDb)
    {
        $settingsContainer = Services_Settings_Container::singleton();

        /**
         * Add a database source.
         */
        try {
            $dbSource = new Services_Settings_DbContainer();
            $dbSource->initialize(['dao' => $daoFactory->getSettingDao()]);
            $settingsContainer->addSource($dbSource);
        } catch (Exception $x) {
            if ($requireDb) {
                throw $x;
            } // if
        } // catch

        /**
         * Add the file (ownsettings.php etc) source to override settings.
         */
        require __DIR__.'/../settings.php';
        $fileSource = new Services_Settings_FileContainer();
        $fileSource->initialize($settings);
        $settingsContainer->addSource($fileSource);

        return $settingsContainer;
    }

    // getSettings

    /**
     * Instantiate an Request object.
     *
     * @param Services_Settings_Container $settings
     *
     * @return SpotReq
     */
    private function getSpotReq(Services_Settings_Container $settings)
    {
        $req = new SpotReq();
        $req->initialize($settings);

        return $req;
    }

    // getSpotReq

    /*
     * Returns the dbSettings object if already set
     */
    public function getDbSettings()
    {
        return $this->_dbSettings;
    }

    // getDbSettings
} // Bootstrap
