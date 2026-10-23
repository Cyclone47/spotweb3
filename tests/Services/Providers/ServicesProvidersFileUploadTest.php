<?php

use PHPUnit\Framework\TestCase;

class ServicesProvidersFileUploadTest extends TestCase
{
    private $originalFiles;

    protected function setUp(): void
    {
        $this->originalFiles = $_FILES;
        $_FILES = [];
    }

    protected function tearDown(): void
    {
        $_FILES = $this->originalFiles;
    }

    public function testMissingUploadIsOptional()
    {
        $upload = new Services_Providers_FileUpload('edituserprefsform', 'avatar');

        $this->assertFalse($upload->isUploaded());
        $this->assertFalse($upload->success());
        $this->assertNull($upload->getTempName());
    }

    public function testUnselectedAvatarDoesNotCountAsAnUpload()
    {
        $_FILES['edituserprefsform'] = [
            'name' => ['avatar' => ''],
            'error' => ['avatar' => UPLOAD_ERR_NO_FILE],
            'tmp_name' => ['avatar' => ''],
        ];
        $upload = new Services_Providers_FileUpload('edituserprefsform', 'avatar');

        $this->assertFalse($upload->isUploaded());
        $this->assertFalse($upload->success());
        $this->assertNull($upload->getTempName());
        $this->assertSame('No file was uploaded', $upload->errorText());
    }

    public function testSelectedAvatarCanStillBeUploaded()
    {
        $_FILES['edituserprefsform'] = [
            'name' => ['avatar' => 'avatar.png'],
            'error' => ['avatar' => UPLOAD_ERR_OK],
            'tmp_name' => ['avatar' => '/tmp/uploaded-avatar'],
        ];
        $upload = new Services_Providers_FileUpload('edituserprefsform', 'avatar');

        $this->assertTrue($upload->isUploaded());
        $this->assertTrue($upload->success());
        $this->assertSame('/tmp/uploaded-avatar', $upload->getTempName());
    }

    public function testFailedUploadStillReportsAnError()
    {
        foreach ([UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE, UPLOAD_ERR_PARTIAL,
            UPLOAD_ERR_NO_TMP_DIR, UPLOAD_ERR_CANT_WRITE, UPLOAD_ERR_EXTENSION] as $error) {
            $_FILES['edituserprefsform'] = [
                'name' => ['avatar' => 'avatar.png'],
                'error' => ['avatar' => $error],
                'tmp_name' => ['avatar' => ''],
            ];
            $upload = new Services_Providers_FileUpload('edituserprefsform', 'avatar');

            $this->assertTrue($upload->isUploaded());
            $this->assertFalse($upload->success());
            $this->assertNull($upload->getTempName());
            $this->assertNotSame('No file was uploaded', $upload->errorText());
        }
    }
}
