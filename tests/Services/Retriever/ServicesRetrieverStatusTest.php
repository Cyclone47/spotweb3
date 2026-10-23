<?php

use PHPUnit\Framework\TestCase;

require_once __DIR__.'/../../../lib/services/Retriever/Services_Retriever_Status.php';
require_once __DIR__.'/../../../lib/services/Retriever/Services_Retriever_Progress.php';

class ServicesRetrieverStatusTest extends TestCase
{
    public function testRunLifecycleIsPersistedIndependentlyOfStreamCompletion()
    {
        $directory = sys_get_temp_dir().'/spotweb-progress-test-'.bin2hex(random_bytes(6));
        mkdir($directory);
        $dao = new Dao_Sqlite_Factory();
        $dao->setCachePath($directory);
        try {
            Services_Retriever_Progress::startRun($dao);
            Services_Retriever_Progress::update($dao, 'Spots', ['phase' => 'done', 'cur' => 1000]);
            Services_Retriever_Progress::stage($dao, 'counts');
            $progress = Services_Retriever_Progress::read($dao);
            $this->assertSame('counts', $progress['Run']['stage']);
            $this->assertSame('running', $progress['Run']['phase']);
            $this->assertSame('done', $progress['Spots']['phase']);
            Services_Retriever_Progress::finishRun($dao, false);
            $this->assertSame('error', Services_Retriever_Progress::read($dao)['Run']['phase']);
            Services_Retriever_Progress::startRun($dao);
            Services_Retriever_Progress::finishRun($dao, true);
            $this->assertSame('done', Services_Retriever_Progress::read($dao)['Run']['phase']);
        } finally {
            unlink($directory.'/'.Services_Retriever_Progress::FILE);
            rmdir($directory);
        }
    }

    private function stream($phase = 'running', $current = 995, $started = 900, $updated = 1000)
    {
        return ['phase' => $phase, 'start' => 0, 'last' => 1000, 'cur' => $current,
            'started' => $started, 'updated' => $updated];
    }

    public function testLastRunningBatchNeverRoundsToOneHundredPercent()
    {
        $result = Services_Retriever_Status::summarize(['Spots' => $this->stream()], [], [], 1000);
        $this->assertTrue($result['running']);
        $this->assertSame(99, $result['types']['Spots']['percent']);
    }

    public function testCompletedSpotsDoNotHideActiveComments()
    {
        $result = Services_Retriever_Status::summarize([
            'Run' => ['phase' => 'running', 'stage' => 'comments', 'started' => 900, 'updated' => 999],
            'Spots' => $this->stream('done', 1000), 'Comments' => $this->stream('running', 200),
        ], [], ['attempted' => 900, 'running' => true, 'schedulerActive' => true], 1000);
        $this->assertTrue($result['running']);
        $this->assertFalse($result['types']['Spots']['running']);
        $this->assertSame('comments', $result['run']['stage']);
        $this->assertSame(20, $result['types']['Comments']['percent']);
    }

    public function testLongPostProcessingRemainsVisibleWhileTheWorkerIsAlive()
    {
        $result = Services_Retriever_Status::summarize([
            'Run' => ['phase' => 'running', 'stage' => 'counts', 'started' => 800, 'updated' => 900],
            'Spots' => $this->stream('done', 1000, 800, 900),
        ], [], ['attempted' => 800, 'running' => true, 'schedulerActive' => true], 2000);
        $this->assertTrue($result['running']);
        $this->assertSame('counts', $result['run']['stage']);
    }

    public function testFinishedRunOverridesStaleStreamAndSchedulerRunningFlags()
    {
        $result = Services_Retriever_Status::summarize([
            'Run' => ['phase' => 'done', 'stage' => 'done', 'started' => 900, 'updated' => 1000],
            'Comments' => $this->stream(),
        ], ['Base' => ['nowrunning' => 900]], ['attempted' => 900, 'running' => true, 'schedulerActive' => true], 1000);
        $this->assertFalse($result['running']);
        $this->assertFalse($result['types']['Comments']['running']);
    }

    public function testFailureCannotLeaveAStaleOneHundredPercentRunActive()
    {
        $result = Services_Retriever_Status::summarize([
            'Run' => ['phase' => 'running', 'stage' => 'spots', 'started' => 900, 'updated' => 990],
            'Spots' => $this->stream('running', 1000, 900, 990),
        ], ['Base' => ['nowrunning' => 900]], ['attempted' => 900, 'running' => false,
            'finished' => 995, 'error' => 'Provider unavailable'], 1000);
        $this->assertFalse($result['running']);
        $this->assertSame('error', $result['run']['phase']);
        $this->assertFalse($result['types']['Spots']['running']);
    }

    public function testADeadWorkerIsReportedAsStalledRatherThanSyncingForever()
    {
        $result = Services_Retriever_Status::summarize([
            'Run' => ['phase' => 'running', 'stage' => 'counts', 'started' => 800, 'updated' => 900],
        ], ['Base' => ['nowrunning' => 800]], ['attempted' => 800, 'running' => true, 'schedulerActive' => false], 2000);
        $this->assertFalse($result['running']);
        $this->assertSame('stalled', $result['run']['phase']);
    }

    public function testProgressFromAnEarlierRunCannotBeUsedForANewRun()
    {
        $result = Services_Retriever_Status::summarize([
            'Run' => ['phase' => 'done', 'stage' => 'done', 'started' => 800, 'updated' => 990],
            'Comments' => $this->stream('running', 1000, 800),
        ], [], ['attempted' => 999, 'running' => true, 'schedulerActive' => true], 1000);
        $this->assertTrue($result['running']);
        $this->assertNull($result['run']);
        $this->assertFalse($result['types']['Comments']['running']);
    }
}
