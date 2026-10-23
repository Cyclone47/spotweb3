<?php
$root = $argv[1] ?? dirname(__DIR__, 2);
require $root.'/vendor/autoload.php';
require $root.'/lib/services/Retriever/Services_Retriever_Schedule.php';
function checkSchedule($ok, $message) { if (!$ok) throw new RuntimeException($message); }
foreach (array_keys(Services_Retriever_Schedule::OPTIONS) as $value) {
    checkSchedule(Services_Retriever_Schedule::validate((string) $value), 'Valid schedule rejected');
}
foreach (['', -1, 1, 301, '900seconds', ['900'], null] as $value) {
    checkSchedule(!Services_Retriever_Schedule::validate($value), 'Invalid interval accepted');
}
$state = ['finished' => 1000, 'handledRequest' => 'old'];
checkSchedule(!Services_Retriever_Schedule::due(900, $state, 'old', 1899), 'Ran before interval elapsed');
checkSchedule(Services_Retriever_Schedule::due(900, $state, 'old', 1900), 'Missed due interval');
checkSchedule(Services_Retriever_Schedule::due(300, $state, 'old', 1300), 'Changed interval not applied');
checkSchedule(!Services_Retriever_Schedule::due(0, $state, 'old', 99999), 'Manual-only ran automatically');
checkSchedule(Services_Retriever_Schedule::due(0, $state, 'new', 1001), 'Manual request ignored');
checkSchedule(!Services_Retriever_Schedule::due(0, ['handledRequest' => 'new'], 'new', 1001), 'Manual request repeated');
$dir = sys_get_temp_dir().'/spotweb-schedule-test-'.bin2hex(random_bytes(6));
mkdir($dir);
$dao = new Dao_Sqlite_Factory(); $dao->setCachePath($dir);
try {
    Services_Retriever_Schedule::write($dao, $state);
    checkSchedule(Services_Retriever_Schedule::read($dao) === $state, 'Schedule state did not persist');
} finally {
    @unlink(Services_Retriever_Schedule::path($dao)); rmdir($dir);
}
echo "PASS interval validation, dynamic changes, manual-only, request deduplication and persistence\n";
