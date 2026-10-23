<?php

/**
 * Maintenance tasks that can be triggered from the admin center.
 *
 * Every task returns a Dto_FormResult-compatible message array:
 * ['ok' => bool, 'message' => string].
 */
class Services_Admin_Maintenance
{
    /**
     * Task name => [label, description, needs a "days" argument, destructive].
     */
    const TASKS = [
        'cache_expired' => ['Remove expired cache', 'Removes cached images, NZB files and other resources that are older than the given number of days or past their time-to-live.', true, false],
        'cache_all'     => ['Clear entire cache', 'Removes every cached item from the database and from disk. Items are re-created on demand.', false, false],
        'sessions'      => ['Remove old sessions', 'Removes login sessions that were not used for the given number of days. Users with a removed session need to log in again.', true, false],
        'statelist'     => ['Clean watch/seen lists', 'Removes watchlist, seen and download entries that point to spots that no longer exist.', false, false],
        'filtercounts'  => ['Reset filter counters', 'Empties the cached "new spots" counters per filter. They are rebuilt automatically.', false, false],
        'audit'         => ['Purge audit log', 'Removes permission-audit entries older than the given number of days.', true, false],
        'spotsfull'     => ['Remove full-spot data', 'Removes the downloaded details (descriptions, NZB references) of spots older than the given number of days. Spots stay in the list and are re-fetched when opened.', true, false],
        'commentsfull'  => ['Remove full-comment data', 'Removes the downloaded bodies of comments belonging to spots older than the given number of days.', true, false],
        'old_spots'     => ['Delete old spots', 'Permanently deletes spots, including their comments, older than the given number of days. This cannot be undone.', true, true],
        'optimize'      => ['Optimize database', 'Reclaims unused space and refreshes query statistics (VACUUM / OPTIMIZE / ANALYZE depending on the database). Can take a while on large databases.', false, false],
    ];

    /**
     * @var Dao_Factory
     */
    private $_daoFactory;

    /**
     * @var dbeng_abs
     */
    private $_conn;

    /**
     * @var Services_Admin_ServerInfo
     */
    private $_serverInfo;

    public function __construct(Dao_Factory $daoFactory, Services_Settings_Container $settings)
    {
        $this->_daoFactory = $daoFactory;
        $this->_conn = $daoFactory->getConnection();
        $this->_serverInfo = new Services_Admin_ServerInfo($daoFactory, $settings);
    }

    // ctor

    /**
     * Runs the given task.
     *
     * @param string $task
     * @param int    $days
     *
     * @return array ['ok' => bool, 'message' => string]
     */
    public function run($task, $days)
    {
        if (!isset(self::TASKS[$task])) {
            return ['ok' => false, 'message' => 'Unknown maintenance task'];
        } // if

        $days = max(0, (int) $days);
        if (self::TASKS[$task][2] && $days < 1) {
            return ['ok' => false, 'message' => 'Please enter a number of days of at least 1'];
        } // if

        // Retrieval and maintenance share tables; do not clean while the retriever is writing
        if (in_array($task, ['old_spots', 'spotsfull', 'commentsfull', 'optimize'], true) && $this->isRetrieverRunning()) {
            return ['ok' => false, 'message' => 'The retriever is running right now, try again when it has finished'];
        } // if

        try {
            switch ($task) {
                case 'cache_expired':
                    $before = $this->count('cache');
                    $this->_daoFactory->getCacheDao()->expireCache($days);

                    return $this->removed('cache entries', $before, $this->count('cache'));

                case 'cache_all':
                    $before = $this->count('cache');
                    $this->_daoFactory->getCacheDao()->expireCache(0);
                    // expireCache() only removes items older than "now"; catch anything stamped this second
                    $this->_conn->modify('DELETE FROM cache WHERE stamp <= :now', [':now' => [time() + 1, PDO::PARAM_INT]]);

                    return $this->removed('cache entries', $before, $this->count('cache'));

                case 'sessions':
                    $before = $this->count('sessions');
                    $this->_conn->modify('DELETE FROM sessions WHERE lasthit < :lasthit', [':lasthit' => [time() - ($days * 86400), PDO::PARAM_INT]]);

                    return $this->removed('sessions', $before, $this->count('sessions'));

                case 'statelist':
                    $before = $this->count('spotstatelist');
                    $this->_daoFactory->getSpotStateListDao()->cleanSpotStateList();

                    return $this->removed('list entries', $before, $this->count('spotstatelist'));

                case 'filtercounts':
                    $before = $this->count('filtercounts');
                    $this->_conn->modify('DELETE FROM filtercounts');

                    return $this->removed('filter counters', $before, 0);

                case 'audit':
                    $before = $this->count('permaudit');
                    $this->_conn->modify('DELETE FROM permaudit WHERE stamp < :stamp', [':stamp' => [time() - ($days * 86400), PDO::PARAM_INT]]);

                    return $this->removed('audit entries', $before, $this->count('permaudit'));

                case 'spotsfull':
                    $before = $this->count('spotsfull');
                    $this->_daoFactory->getSpotDao()->expireSpotsFull($days);

                    return $this->removed('full-spot records', $before, $this->count('spotsfull'));

                case 'commentsfull':
                    $before = $this->count('commentsfull');
                    $this->_daoFactory->getCommentDao()->expireCommentsFull($days);

                    return $this->removed('full-comment records', $before, $this->count('commentsfull'));

                case 'old_spots':
                    $before = $this->count('spots');
                    $this->_daoFactory->getSpotDao()->deleteSpotsRetention($days);

                    return $this->removed('spots', $before, $this->count('spots'));

                case 'optimize':
                    $before = $this->_serverInfo->getDatabaseInfo()['size'];
                    $this->optimizeDatabase();
                    $after = $this->_serverInfo->getDatabaseInfo()['size'];

                    return ['ok' => true, 'message' => 'Database optimized'.(($before !== null && $after !== null) ? ' ('.$this->formatBytes($before).' → '.$this->formatBytes($after).')' : '')];
            } // switch
        } catch (Exception $x) {
            return ['ok' => false, 'message' => 'Task failed: '.$x->getMessage()];
        } // catch

        return ['ok' => false, 'message' => 'Unknown maintenance task'];
    }

    // run

    private function optimizeDatabase()
    {
        switch ($this->_serverInfo->getEngineName()) {
            case 'sqlite':
                $this->_conn->rawExec('VACUUM');
                $this->_conn->rawExec('ANALYZE');
                break;
            case 'pgsql':
                $this->_conn->rawExec('VACUUM ANALYZE');
                break;
            case 'mysql':
                foreach (['spots', 'spotsfull', 'commentsxover', 'commentsfull', 'cache', 'sessions', 'spotstatelist'] as $table) {
                    $this->_conn->rawExec('OPTIMIZE TABLE '.$table);
                } // foreach
                break;
            default:
                throw new Exception('Unsupported database engine');
        } // switch
    }

    // optimizeDatabase

    private function isRetrieverRunning()
    {
        foreach ($this->_serverInfo->getRetrieverInfo() as $state) {
            if ($state['running']) {
                return true;
            } // if
        } // foreach

        return false;
    }

    // isRetrieverRunning

    private function count($table)
    {
        return (int) $this->_conn->singleQuery('SELECT COUNT(1) FROM '.$table);
    }

    // count

    private function removed($what, $before, $after)
    {
        $removed = max(0, $before - $after);

        return ['ok' => true, 'message' => sprintf('Removed %s %s', number_format($removed), $what)];
    }

    // removed

    private function formatBytes($bytes)
    {
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        while ($bytes >= 1024 && $i < count($units) - 1) {
            $bytes /= 1024;
            $i++;
        } // while

        return round($bytes, 1).' '.$units[$i];
    }

    // formatBytes
} // Services_Admin_Maintenance
