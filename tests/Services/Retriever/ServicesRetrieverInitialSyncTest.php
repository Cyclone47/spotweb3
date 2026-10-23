<?php

use PHPUnit\Framework\TestCase;

class InitialSyncSettings extends Services_Settings_Container
{
    public $values = ['nntp_hdr' => ['host' => 'news.example.test'], 'hdr_group' => 'spots',
        'nzb_group' => 'binaries', 'retrieve_increment' => 50, 'retention' => 0,
        'retrieve_newer_than' => 0, 'spot_moderation' => 'disable'];

    public function get($name) { return $this->values[$name] ?? null; }
    public function set($name, $value) { $this->values[$name] = $value; }
    public function remove($name) { unset($this->values[$name]); }
    public function exists($name) { return isset($this->values[$name]); }
}

class InitialSyncState
{
    public $cursor = 0;
    public $messageId = '';
    public $finished = 0;
    public $checkpoints = [];
    public function getLastArticleNumber($type) { return $this->cursor; }
    public function getLastMessageId($type) { return $this->messageId; }
    public function getLastUpdate($type) { return $this->finished; }
    public function setLastUpdate($type) { $this->finished = time(); }
    public function setMaxArticleId($type, $number, $messageId)
    {
        $this->cursor = $number;
        $this->messageId = $messageId;
        $this->checkpoints[] = $number;
    }
}

class InitialSyncSpotStore
{
    public $spots = [];
    public $batches = [];
    public $cleanupCalls = 0;
    public function matchSpotMessageIds($headers)
    {
        $matched = ['spot' => [], 'fullspot' => []];
        foreach ($headers as $header) {
            if (isset($this->spots[$header['Message-ID']])) {
                $matched['spot'][$header['Message-ID']] = 1;
            }
        }

        return $matched;
    }
    public function addSpots($spots, $fullSpots = [])
    {
        if ($spots) $this->batches[] = count($spots);
        foreach ($spots as $spot) {
            if (isset($this->spots[$spot['messageid']])) throw new RuntimeException('Duplicate spot inserted');
            $this->spots[$spot['messageid']] = $spot;
        }
    }
    public function removeExtraSpots($messageId) { $this->cleanupCalls++; }
    public function getMaxMessageId($headers) { return array_fill_keys(array_keys($this->spots), 1); }
}

class InitialSyncParser
{
    public function parseHeader($subject, $from, $date, $id, $keys)
    {
        if ($subject === 'invalid') return false;

        return ['messageid' => $id, 'title' => $subject, 'keyid' => 1, 'spotterid' => 'fixture',
            'stamp' => (int) $date, 'verified' => true, 'wassigned' => true];
    }
}

class InitialSyncTransport extends Services_Nntp_PipelinedTransport
{
    public $ranges = [];
    public $invalid = false;
    public $fail = false;
    public $renumbered = false;
    public function __construct() {}
    public function getOverview($first, $last)
    {
        $this->ranges[] = [$first, $last];
        if ($this->fail) throw new RuntimeException('Provider unavailable');
        $headers = [];
        for ($number = max(1, $first); $number <= min(500, $last); $number++) {
            $headers[] = ['Number' => $number, 'Message-ID' => '<spot'.$number.'@example.test>',
                'Subject' => $this->invalid ? 'invalid' : 'Spot '.$number, 'From' => 'Fixture', 'Date' => $number];
        }

        return $headers;
    }
    public function getMessageIdByArticleNumber($number) { return $this->renumbered ? '<changed@example.test>' : '<spot'.$number.'@example.test>'; }
    public function getMessageIdList($first, $last)
    {
        return [151 => '<spot51@example.test>', 500 => '<spot500@example.test>'];
    }
}

class InitialSyncRetriever extends Services_Retriever_Spots
{
    public $store;
    public $state;
    public $transport;
    public $onHistory;
    public $reports = [];
    public function __construct($settings, $store, $state, $transport)
    {
        // Use the real processing/perform loop without opening provider sockets.
        $this->_settings = $settings;
        $this->_usenetStateDao = $state;
        $this->_svcNntpTextPipelined = $transport;
        $this->_textServer = ['buggy' => false];
        $this->_retro = false;
        $this->_msgdata = ['first' => 1, 'last' => 500];
        $this->store = $store;
        $this->state = $state;
        $this->transport = $transport;
        $cache = new class {
            public function getMassCacheRecords($headers) { return []; }
        };
        $moderation = new class {
            public function matchAgainst($headers) { return []; }
            public function deleteOldest() {}
        };
        foreach (['_spotDao' => $store, '_cacheDao' => $cache, '_modListDao' => $moderation,
            '_svcSpotParser' => new InitialSyncParser(), '_rsakeys' => [], '_retrieveFull' => false,
            '_prefetch_image' => false, '_prefetch_nzb' => false] as $name => $value) {
            $this->setPrivate($name, $value);
        }
    }
    public function setPrivate($name, $value)
    {
        $property = new ReflectionProperty(Services_Retriever_Spots::class, $name);
        $property->setAccessible(true);
        $property->setValue($this, $value);
    }
    public function getPrivate($name)
    {
        $property = new ReflectionProperty(Services_Retriever_Spots::class, $name);
        $property->setAccessible(true);

        return $property->getValue($this);
    }
    public function connect(array $groups) { return $this->_msgdata; }
    public function quit() {}
    public function displayStatus($category, $text) {}
    public function hasMemoryPressure() { return false; }
    protected function reportProgress(array $data) { $this->reports[] = $data; }
    public function process($headers, $first, $next, $timer)
    {
        if (!$this->getPrivate('_previewMode') && $this->onHistory) {
            call_user_func($this->onHistory, $this);
        }

        return parent::process($headers, $first, $next, $timer);
    }
}

class ServicesRetrieverInitialSyncTest extends TestCase
{
    private function retriever()
    {
        return new InitialSyncRetriever(new InitialSyncSettings(), new InitialSyncSpotStore(), new InitialSyncState(), new InitialSyncTransport());
    }

    public function testNewestPreviewIsVisibleBeforeHistoryAndDoesNotMoveItsCheckpoint()
    {
        $retriever = $this->retriever();
        $observed = false;
        $retriever->onHistory = function ($worker) use (&$observed) {
            if ($observed) return;
            $observed = true;
            $this->assertCount(200, $worker->store->spots);
            $this->assertArrayHasKey('<spot500@example.test>', $worker->store->spots);
            $this->assertArrayNotHasKey('<spot300@example.test>', $worker->store->spots);
            $this->assertSame(0, $worker->state->cursor);
            $this->assertSame([], $worker->state->checkpoints);
            $this->assertSame(array_fill(0, 8, 25), $worker->store->batches);
        };
        $retriever->perform();
        $this->assertTrue($observed);
        $this->assertCount(500, $retriever->store->spots);
        $this->assertSame(500, $retriever->state->cursor);
        $this->assertSame(0, $retriever->store->cleanupCalls, 'ID-based cleanup must not delete backfilled history');
        $this->assertFalse($retriever->getPrivate('_previewMode'));
    }

    public function testInterruptedHistoryCanResumeWithoutSkippingOrDuplicatingSpots()
    {
        $retriever = $this->retriever();
        $calls = 0;
        $retriever->onHistory = function () use (&$calls) {
            if (++$calls === 2) throw new RuntimeException('Interrupted history');
        };
        try {
            $retriever->perform();
            $this->fail('Expected interrupted history');
        } catch (RuntimeException $expected) {
            $this->assertSame('Interrupted history', $expected->getMessage());
        }
        $this->assertGreaterThan(0, $retriever->state->cursor);
        $this->assertLessThan(300, $retriever->state->cursor);
        $this->assertSame(['<spot51@example.test>' => 1], $retriever->getRecentRetrievedMessageIdList());
        $retriever->transport->renumbered = true;
        $this->assertSame(151, $retriever->searchMessageId($retriever->state->cursor,
            $retriever->state->messageId, $retriever->getRecentRetrievedMessageIdList()),
            'Provider renumbering must find the history checkpoint rather than a preview spot');
        $retriever->transport->renumbered = false;
        $retriever->onHistory = null;
        $retriever->perform();
        $this->assertCount(500, $retriever->store->spots);
        $this->assertSame(500, $retriever->state->cursor);
    }

    public function testInvalidHeadersAreNotPublishedAndThePreviewScanIsBounded()
    {
        $retriever = $this->retriever();
        $retriever->transport->invalid = true;
        $retriever->onHistory = function ($worker) {
            $this->assertCount(0, $worker->store->spots);
            $this->assertLessThanOrEqual(80, count($worker->transport->ranges));
            throw new RuntimeException('Preview observed');
        };
        $this->expectExceptionMessage('Preview observed');
        $retriever->perform();
    }

    public function testPreviewFailureRestoresFullArticleAndPrefetchSettings()
    {
        $retriever = $this->retriever();
        foreach (['_retrieveFull', '_prefetch_image', '_prefetch_nzb'] as $name) $retriever->setPrivate($name, true);
        $retriever->transport->fail = true;
        try {
            $retriever->perform();
            $this->fail('Expected provider failure');
        } catch (RuntimeException $expected) {
            $this->assertSame('Provider unavailable', $expected->getMessage());
        }
        foreach (['_retrieveFull', '_prefetch_image', '_prefetch_nzb'] as $name) $this->assertTrue($retriever->getPrivate($name));
        $this->assertFalse($retriever->getPrivate('_previewMode'));
        $this->assertSame([], $retriever->state->checkpoints);
    }

    public function testSetupQueuesExactlyOneInitialRequestEvenInManualOnlyMode()
    {
        $settings = new InitialSyncSettings();
        $settings->set(Services_Retriever_Schedule::SETTING, 0);
        $settings->set('onboarding_pending', true);
        $this->assertTrue(Services_Retriever_Schedule::queueInitial($settings));
        $request = $settings->get(Services_Retriever_Schedule::REQUEST);
        $this->assertTrue((bool) $settings->get(Services_Retriever_Schedule::INITIAL_PENDING));
        $this->assertFalse(Services_Retriever_Schedule::due(0, [], $request, time(), true));
        $settings->remove('onboarding_pending');
        $this->assertTrue(Services_Retriever_Schedule::due(0, [], $request, time(), false));
        $this->assertFalse(Services_Retriever_Schedule::due(0, ['handledRequest' => $request], $request, time()));
        $settings->set('nntp_hdr', ['host' => '']);
        $this->assertFalse(Services_Retriever_Schedule::queueInitial($settings));
        $this->assertSame($request, $settings->get(Services_Retriever_Schedule::REQUEST));
    }
}
