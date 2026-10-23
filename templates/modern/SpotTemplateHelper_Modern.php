<?php

class SpotTemplateHelper_Modern extends SpotTemplateHelper
{
    public function getThemeName()
    {
        return 'modern';
    }

    // getThemeName

    public function getTemplatePreferences()
    {
        return ['modern' => []];
    }

    // getTemplatePreferences

    /**
     * Theme asset path with a cache-busting version, so edits show up immediately.
     */
    private function versionedAsset($relativePath)
    {
        $file = __DIR__.'/'.$relativePath;

        return $this->getThemeAssetPath($relativePath).(file_exists($file) ? '?v='.filemtime($file) : '');
    }

    // versionedAsset

    public function getThemeHeaderCssFiles()
    {
        return [
            $this->getThemeAssetPath('css/posting.css'),
            $this->getThemeAssetPath('css/config.css'),
            $this->versionedAsset('css/redesign.css'),
            $this->versionedAsset('css/icons.css'),
            $this->versionedAsset('css/desktop.css'),
            $this->versionedAsset('css/desktop-config.css'),
            $this->versionedAsset('css/detail-desktop.css'),
            $this->versionedAsset('css/flat.css'),
        ];
    }

    // getThemeHeaderCssFiles

    public function getThemeHeaderJsFiles()
    {
        return [
            $this->getThemeAssetPath('js/theme-toggle.js'),
            $this->getThemeAssetPath('js/back-fix.js'),
            $this->getThemeAssetPath('js/open-spot-fix.js'),
            $this->getThemeAssetPath('js/sticky-offset.js'),
            $this->getThemeAssetPath('js/infinite.js'),
            $this->getThemeAssetPath('js/table-enhance.js'),
            $this->getThemeAssetPath('js/filter-overlay.js'),
            $this->versionedAsset('js/shell.js'),
            $this->versionedAsset('js/desktop.js'),
            $this->versionedAsset('js/seamless-nav.js'),
        ];
    }

    // getThemeHeaderJsFiles

    protected function getThemePostingJsFile()
    {
        return $this->getThemeAssetPath('js/modernpost.js');
    }

    // getThemePostingJsFile

    protected function getThemeExtraStaticFiles($type)
    {
        switch ($type) {
            case 'css':
                return [
                    $this->getThemeAssetPath('css/base.css'),
                    $this->getThemeAssetPath('css/dark.css'),
                    $this->getThemeAssetPath('css/filters.css'),
                    $this->getThemeAssetPath('css/layout.css'),
                    $this->getThemeAssetPath('css/cards.css'),
                    $this->getThemeAssetPath('css/detail.css'),
                    $this->getThemeAssetPath('css/table.css'),
                ];
        } // switch

        return [];
    }

    // getThemeExtraStaticFiles
}
