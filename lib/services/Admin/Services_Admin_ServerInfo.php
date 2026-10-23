<?php

/**
 * Collects read-only information about the server Spotweb runs on:
 * resources, storage usage and database size.
 */
class Services_Admin_ServerInfo
{
    /**
     * @var Dao_Factory
     */
    private $_daoFactory;

    /**
     * @var dbeng_abs
     */
    private $_conn;

    /**
     * @var Services_Settings_Container
     */
    private $_settings;

    public function __construct(Dao_Factory $daoFactory, Services_Settings_Container $settings)
    {
        $this->_daoFactory = $daoFactory;
        $this->_conn = $daoFactory->getConnection();
        $this->_settings = $settings;
    }

    // ctor

    /**
     * Returns all information shown on the "Server info" tab.
     *
     * @return array
     */
    public function collect()
    {
        return [
            'system'    => $this->getSystemInfo(),
            'storage'   => $this->getStorageInfo(),
            'database'  => $this->getDatabaseInfo(),
            'retriever' => $this->getRetrieverInfo(),
        ];
    }

    // collect

    public function getSystemInfo()
    {
        $info = [
            'spotweb_version' => SPOTWEB_VERSION,
            'php_version'     => PHP_VERSION,
            'php_sapi'        => PHP_SAPI,
            'os'              => php_uname('s').' '.php_uname('r'),
            'hostname'        => php_uname('n'),
            'web_server'      => isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : '',
            'memory_limit'    => ini_get('memory_limit'),
            'max_execution'   => ini_get('max_execution_time'),
            'server_time'     => date('Y-m-d H:i:s T'),
            'in_container'    => file_exists('/.dockerenv') || getenv('SPOTWEB_DATA_DIR') !== false,
            'load'            => null,
            'memory_total'    => null,
            'memory_free'     => null,
            'uptime'          => null,
        ];

        if (function_exists('sys_getloadavg')) {
            $load = @sys_getloadavg();
            if (is_array($load)) {
                $info['load'] = array_map(function ($l) {
                    return round($l, 2);
                }, $load);
            } // if
        } // if

        // Linux only; stays null elsewhere and the UI hides it
        if (is_readable('/proc/meminfo')) {
            $meminfo = @file_get_contents('/proc/meminfo');
            if (preg_match('/^MemTotal:\s+(\d+) kB/m', $meminfo, $total)) {
                $info['memory_total'] = $total[1] * 1024;
            } // if
            if (preg_match('/^MemAvailable:\s+(\d+) kB/m', $meminfo, $free)) {
                $info['memory_free'] = $free[1] * 1024;
            } // if
        } // if
        if (is_readable('/proc/uptime')) {
            $uptime = explode(' ', (string) @file_get_contents('/proc/uptime'));
            $info['uptime'] = (int) $uptime[0];
        } // if

        $needed = ['curl', 'dom', 'gettext', 'mbstring', 'xml', 'zip', 'zlib', 'gd', 'openssl', 'pdo'];
        $info['extensions'] = [];
        foreach ($needed as $ext) {
            $info['extensions'][$ext] = extension_loaded($ext);
        } // foreach

        return $info;
    }

    // getSystemInfo

    public function getStorageInfo()
    {
        $cachePath = $this->getCachePath();
        $dataDir = getenv('SPOTWEB_DATA_DIR');
        $diskPath = ($dataDir !== false && is_dir($dataDir)) ? $dataDir : dirname($cachePath);
        if (!is_dir($diskPath)) {
            $diskPath = dirname(__DIR__, 3);
        } // if

        $total = @disk_total_space($diskPath);
        $free = @disk_free_space($diskPath);

        $cache = $this->getDirectoryStats($cachePath);

        return [
            'disk_path'   => $diskPath,
            'disk_total'  => $total === false ? null : $total,
            'disk_free'   => $free === false ? null : $free,
            'disk_used'   => ($total === false || $free === false) ? null : $total - $free,
            'cache_path'  => $cachePath,
            'cache_bytes' => $cache['bytes'],
            'cache_files' => $cache['files'],
            'cache_rows'  => (int) $this->_conn->singleQuery('SELECT COUNT(1) FROM cache'),
            'writable'    => is_dir($cachePath) && is_writable($cachePath),
        ];
    }

    // getStorageInfo

    public function getDatabaseInfo()
    {
        $engine = $this->getEngineName();
        $info = [
            'engine'  => $engine,
            'version' => $this->getDatabaseVersion($engine),
            'size'    => $this->getDatabaseSize($engine),
            'tables'  => [],
        ];

        $tables = [
            'spots'         => 'Spots',
            'spotsfull'     => 'Full spots',
            'commentsxover' => 'Comment headers',
            'commentsfull'  => 'Full comments',
            'reportsxover'  => 'Report headers',
            'users'         => 'Users',
            'sessions'      => 'Sessions',
            'cache'         => 'Cache entries',
            'spotstatelist' => 'Watch/seen/download list',
            'filtercounts'  => 'Filter counters',
        ];
        foreach ($tables as $table => $label) {
            $info['tables'][] = [
                'table' => $table,
                'label' => $label,
                'rows'  => (int) $this->_conn->singleQuery('SELECT COUNT(1) FROM '.$table),
            ];
        } // foreach

        $oldest = $this->_conn->singleQuery('SELECT MIN(stamp) FROM spots WHERE stamp > 0');
        $newest = $this->_conn->singleQuery('SELECT MAX(stamp) FROM spots');
        $info['oldest_spot'] = $oldest ? (int) $oldest : null;
        $info['newest_spot'] = $newest ? (int) $newest : null;

        return $info;
    }

    // getDatabaseInfo

    public function getRetrieverInfo()
    {
        $rows = $this->_conn->arrayQuery('SELECT infotype, curarticlenr, lastretrieved, nowrunning FROM usenetstate ORDER BY infotype');
        $result = [];
        foreach ($rows as $row) {
            $result[] = [
                'infotype'      => $row['infotype'],
                'curarticlenr'  => (int) $row['curarticlenr'],
                'lastretrieved' => (int) $row['lastretrieved'],
                'running'       => (int) $row['nowrunning'] > 0,
            ];
        } // foreach

        return $result;
    }

    // getRetrieverInfo

    /**
     * Same resolution rules as Bootstrap::boot().
     */
    public function getCachePath()
    {
        $cachePath = $this->_settings->exists('cache_path') ? $this->_settings->get('cache_path') : '';
        if (empty($cachePath)) {
            return dirname(__DIR__, 3).'/cache';
        } // if
        if (strpos($cachePath, './') === 0 || strpos($cachePath, '.\\') === 0) {
            return dirname(__DIR__, 3).'/'.substr($cachePath, 2);
        } // if

        return $cachePath;
    }

    // getCachePath

    public function getEngineName()
    {
        if ($this->_conn instanceof dbeng_pdo_mysql) {
            return 'mysql';
        } elseif ($this->_conn instanceof dbeng_pdo_pgsql) {
            return 'pgsql';
        } elseif ($this->_conn instanceof dbeng_pdo_sqlite) {
            return 'sqlite';
        } // if

        return 'unknown';
    }

    // getEngineName

    private function getDatabaseVersion($engine)
    {
        try {
            switch ($engine) {
                case 'mysql': return (string) $this->_conn->singleQuery('SELECT VERSION()');
                case 'pgsql': return (string) $this->_conn->singleQuery('SHOW server_version');
                case 'sqlite': return (string) $this->_conn->singleQuery('SELECT sqlite_version()');
            } // switch
        } catch (Exception $x) {
            // version is purely informational
        } // catch

        return '';
    }

    // getDatabaseVersion

    private function getDatabaseSize($engine)
    {
        try {
            switch ($engine) {
                case 'mysql':
                    return (int) $this->_conn->singleQuery(
                        'SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()'
                    );
                case 'pgsql':
                    return (int) $this->_conn->singleQuery('SELECT pg_database_size(current_database())');
                case 'sqlite':
                    $pageCount = (int) $this->_conn->singleQuery('PRAGMA page_count');
                    $pageSize = (int) $this->_conn->singleQuery('PRAGMA page_size');

                    return $pageCount * $pageSize;
            } // switch
        } catch (Exception $x) {
            // permissions on information_schema may be restricted
        } // catch

        return null;
    }

    // getDatabaseSize

    private function getDirectoryStats($path)
    {
        $stats = ['bytes' => 0, 'files' => 0];
        if (!is_dir($path)) {
            return $stats;
        } // if

        try {
            $iterator = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
                RecursiveIteratorIterator::LEAVES_ONLY
            );
            foreach ($iterator as $file) {
                if ($file->isFile()) {
                    $stats['bytes'] += $file->getSize();
                    $stats['files']++;
                } // if
            } // foreach
        } catch (Exception $x) {
            // unreadable subdirectory; report what we counted so far
        } // catch

        return $stats;
    }

    // getDirectoryStats
} // Services_Admin_ServerInfo
