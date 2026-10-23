<?php

/**
 * Small progress file written by the retriever and read by the web interface
 * (sync indicator in the menu bar). Stored next to the cache so it works with
 * every database engine and survives restarts. All errors are swallowed: progress
 * reporting must never break a retrieval run.
 */
class Services_Retriever_Progress
{
    const FILE = 'retriever-progress.json';

    private static function path(Dao_Factory $daoFactory)
    {
        return rtrim($daoFactory->getCachePath(), '/\\').'/'.self::FILE;
    }

    /**
     * @return array [type => [phase, start, first, last, cur, processed, started, updated, finished]]
     */
    public static function read(Dao_Factory $daoFactory)
    {
        try {
            $raw = @file_get_contents(self::path($daoFactory));
            $data = $raw === false ? null : json_decode($raw, true);

            return is_array($data) ? $data : [];
        } catch (Throwable $x) {
            return [];
        }
    }

    public static function update(Dao_Factory $daoFactory, $type, array $data)
    {
        try {
            $path = self::path($daoFactory);
            $all = self::read($daoFactory);
            $all[$type] = array_merge(isset($all[$type]) ? $all[$type] : [], $data, ['updated' => time()]);

            $tmp = $path.'.'.getmypid().'.tmp';
            if (@file_put_contents($tmp, json_encode($all)) !== false) {
                @rename($tmp, $path);
            } // if
        } catch (Throwable $x) {
            // progress is informational only
        }
    }
}
