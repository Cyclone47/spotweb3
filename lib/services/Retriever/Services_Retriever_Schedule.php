<?php

/** Schedule shared by the background worker and Admin Center. */
class Services_Retriever_Schedule
{
    const SETTING = 'retrieve_interval_seconds';
    const REQUEST = 'retrieve_requested_id';
    const INITIAL_PENDING = 'retrieve_initial_sync_pending';
    const OPTIONS = [0 => 'Manual only', 300 => 'Every 5 minutes', 900 => 'Every 15 minutes',
        1800 => 'Every 30 minutes', 3600 => 'Every hour', 21600 => 'Every 6 hours',
        43200 => 'Every 12 hours', 86400 => 'Every day'];

    public static function interval(Services_Settings_Container $settings)
    {
        $value = $settings->exists(self::SETTING) ? $settings->get(self::SETTING) : getenv('SPOTWEB_RETRIEVE_INTERVAL');
        return $value === false || $value === '' ? 900 : max(0, (int) $value);
    }

    public static function validate($value)
    {
        return is_scalar($value) && preg_match('/^\d+$/D', (string) $value) && array_key_exists((int) $value, self::OPTIONS);
    }

    /** Queue the first run even when automatic retrieval is set to manual-only. */
    public static function queueInitial(Services_Settings_Container $settings)
    {
        $server = $settings->get('nntp_hdr');
        if (empty($server['host'])) {
            return false;
        }
        $settings->set(self::INITIAL_PENDING, true);
        $settings->set(self::REQUEST, bin2hex(random_bytes(12)));

        return true;
    }

    public static function path(Dao_Factory $dao, $suffix = 'json')
    {
        return rtrim($dao->getCachePath(), '/\\').'/retriever-schedule.'.$suffix;
    }

    public static function read(Dao_Factory $dao)
    {
        $data = json_decode((string) @file_get_contents(self::path($dao)), true);
        return is_array($data) ? $data : [];
    }

    public static function write(Dao_Factory $dao, array $state)
    {
        $path = self::path($dao);
        $tmp = $path.'.'.getmypid().'.tmp';
        if (file_put_contents($tmp, json_encode($state)) === false || !rename($tmp, $path)) {
            throw new RuntimeException('Unable to save retrieval schedule status');
        }
    }

    public static function status(Dao_Factory $dao, Services_Settings_Container $settings)
    {
        $state = self::read($dao);
        $interval = self::interval($settings);
        $request = $settings->exists(self::REQUEST) ? $settings->get(self::REQUEST) : '';
        $last = (int) ($state['finished'] ?? $state['attempted'] ?? 0);
        return array_merge($state, [
            'interval' => $interval,
            'schedulerActive' => time() - (int) ($state['heartbeat'] ?? 0) < 30,
            'queued' => $request !== '' && $request !== ($state['handledRequest'] ?? ''),
            'next' => $interval > 0 ? max(time(), $last + $interval) : null,
        ]);
    }

    public static function due($interval, array $state, $request, $now, $onboardingPending = false)
    {
        if ($onboardingPending) return false;
        if ($request !== '' && $request !== ($state['handledRequest'] ?? '')) return true;
        $last = (int) ($state['finished'] ?? $state['attempted'] ?? 0);
        return $interval > 0 && $now >= $last + $interval;
    }
}
