<?php

class Services_Nntp_ConnectionLimit
{
    const SettingName = 'nntp_max_connections';
    const DefaultConnections = 4;
    const MaxConnections = 100;

    public static function validate($value)
    {
        return (is_int($value) || (is_string($value) && preg_match('/^[0-9]+$/D', $value)))
            && (int) $value >= 1 && (int) $value <= self::MaxConnections;
    }

    public static function normalize($value)
    {
        return self::validate($value) ? (int) $value : self::DefaultConnections;
    }
}
