<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html>
	<head>
		<meta http-equiv='Content-Type' content='text/html; charset=utf-8'>
		<title>SpotWeb - <?php echo $pagetitle?></title>
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
		<meta name="theme-color" content="#3b5bfd">
		<link rel="icon" type="image/png" href="<?php echo htmlspecialchars($tplHelper->getThemeAssetPath('img/spotnet-icon-64.png'), ENT_QUOTES, 'UTF-8'); ?>">
		<meta name="generator" content="SpotWeb v<?php echo SPOTWEB_VERSION; ?>">
<?php if ($settings->get('deny_robots')) {
    echo "\t\t<meta name=\"robots\" content=\"noindex, nofollow\">\r\n";
} ?>
		<base href='<?php echo $tplHelper->makeBaseUrl('full'); ?>'>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_view_rssfeed, '')) { ?>
		<link rel='alternate' type='application/rss+xml' href='<?php echo $tplHelper->makeRssUrl(); ?>'>
<?php } ?>

		<script type="text/javascript">
		// Guards for legacy globals some plugins expect
		try { if (typeof window.templates === 'undefined') { window.templates = {}; } } catch (e) { }
		try { if (typeof window.modern === 'undefined') { window.modern = {}; } } catch (e) { }
		(function(){
		  try {
		    window.SPOTWEB_DEFAULT_THEME = '<?php $defTheme = $settings->get('default_theme_mode'); echo in_array($defTheme, ['light', 'dark', 'auto'], true) ? $defTheme : 'auto'; ?>';
		    var pref = localStorage.getItem('spotweb_theme') || window.SPOTWEB_DEFAULT_THEME;
		    var mode = pref === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
		    document.documentElement.setAttribute('data-theme', mode);
		  } catch(e) {}
		})();
		// Fallback for back button in full-page spot view
		document.addEventListener('click', function(ev){
		  var a = ev.target && ev.target.closest ? ev.target.closest('a.closeDetails') : null;
		  if (!a) return;
		  ev.preventDefault();
		  try {
		    if (window.history.length > 1) { window.history.back(); }
		    else { window.location.href = '<?php echo $tplHelper->makeBaseUrl('path'); ?>'; }
		  } catch(e) { window.location.href = '<?php echo $tplHelper->makeBaseUrl('path'); ?>'; }
		}, true);
		</script>

<?php if ($tplHelper->allowed(SpotSecurity::spotsec_view_statics, '')) { ?>
		<link rel='stylesheet' type='text/css' href='?page=statics&amp;type=css&amp;mod=<?php echo $tplHelper->getStaticModTime('css'); ?>'>
		<link rel='shortcut icon' href='?page=statics&amp;type=ico&amp;mod=<?php echo $tplHelper->getStaticModTime('ico'); ?>'>
<?php } ?>
<?php foreach ($tplHelper->getThemeHeaderCssFiles() as $cssFile) { ?>
		<link rel='stylesheet' type='text/css' href='<?php echo htmlspecialchars($cssFile, ENT_QUOTES, 'UTF-8'); ?>'>
<?php } ?>
		<style type="text/css" media="screen,handheld,projection">
			<?php echo $settings->get('customcss'); ?>
		</style>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_allow_custom_stylesheet, '')) { ?>
		<style type="text/css" media="screen,handheld,projection">
			<?php echo $tplHelper->getUserCustomCss(); ?>
		</style>
<?php } ?>
		<!-- Modern JS (loaded separately to avoid statics concatenation issues) -->
<?php foreach ($tplHelper->getThemeHeaderJsFiles() as $jsFile) { ?>
		<script src="<?php echo htmlspecialchars($jsFile, ENT_QUOTES, 'UTF-8'); ?>" type="text/javascript" defer></script>
<?php } ?>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_retrieve_nzb, '')) { ?>
		<!-- Browser Download Engine (client-side NNTP + yEnc + PAR2 + 7z-wasm) -->
		<script src="js/browser-download/nzb-parser.js?v=<?php echo filemtime(__DIR__.'/../../../js/browser-download/nzb-parser.js'); ?>" type="text/javascript" defer></script>
		<script src="js/browser-download/storage-manager.js?v=<?php echo filemtime(__DIR__.'/../../../js/browser-download/storage-manager.js'); ?>" type="text/javascript" defer></script>
		<script src="js/browser-download/download-manager.js?v=<?php echo max(array_map('filemtime', glob(__DIR__.'/../../../js/browser-download/*.js'))); ?>" type="text/javascript" defer></script>
<?php } ?>
<?php
    $pageName = strtolower((string) ($_GET['page'] ?? 'index'));
    $tplName = strtolower((string) ($_GET['tplname'] ?? ''));
    $bodyClasses = [
        'modern-theme',
        'modern-page-'.preg_replace('/[^a-z0-9_-]+/', '-', $pageName),
    ];
    $configPages = ['editsettings', 'edituserprefs', 'usermanagement', 'admin'];
    $configTemplates = ['usermanagement', 'listusers', 'listgroups', 'listfilters', 'editfilter'];
    if (in_array($pageName, $configPages, true) || in_array($tplName, $configTemplates, true)) {
        $bodyClasses[] = 'modern-config';
    }
?>
<?php
    /*
     * Application style menu bar (desktop skin): everything the menus need, already
     * permission checked, so every page can render the same menu.
     */
    $swIsAnon = ($currentSession['user']['userid'] == $settings->get('nonauthenticated_userid'));
    $swUserId = $currentSession['user']['userid'];
    $swFile = [];
    $swEdit = [];
    if ($tplHelper->allowed(SpotSecurity::spotsec_retrieve_spots, '') && $swUserId > SPOTWEB_ADMIN_USERID) {
        $swFile[] = ['id' => 'refresh', 'label' => _('Update')];
    }
    if ($tplHelper->allowed(SpotSecurity::spotsec_post_spot, '') && $swUserId > SPOTWEB_ADMIN_USERID) {
        $swFile[] = ['id' => 'addspot', 'label' => _('Add spot'), 'url' => $tplHelper->getPageUrl('postspot')];
    }
    $swFile[] = ['sep' => true];
    if ($tplHelper->allowed(SpotSecurity::spotsec_perform_login, '') && $swIsAnon) {
        $swFile[] = ['id' => 'login', 'label' => _('Log in')];
    }
    if ($tplHelper->allowed(SpotSecurity::spotsec_create_new_user, '')) {
        $swFile[] = ['id' => 'adduser', 'label' => _('Add user')];
    }
    if ($tplHelper->allowed(SpotSecurity::spotsec_edit_own_user, '')) {
        $swFile[] = ['id' => 'changeuser', 'label' => _('Change user'), 'userid' => $swUserId];
    }
    if ($tplHelper->allowed(SpotSecurity::spotsec_perform_logout, '')) {
        $swFile[] = ['id' => 'logout', 'label' => _('Log out')];
    }
    $canAccessAdmin = $tplHelper->allowed(SpotSecurity::spotsec_edit_own_userprefs, '')
        || $tplHelper->allowed(SpotSecurity::spotsec_edit_settings, '')
        || $tplHelper->allowed(SpotSecurity::spotsec_edit_other_users, '')
        || $tplHelper->allowed(SpotSecurity::spotsec_list_all_users, '')
        || $tplHelper->allowed(SpotSecurity::spotsec_edit_securitygroups, '');
    if ($canAccessAdmin) {
        $prefsUrl = '?page=edituserprefs&userid='.$swUserId;
        $swEdit[] = ['label' => _('Admin center'), 'href' => '?page=admin'];
        $swEdit[] = ['sep' => true];
        if ($tplHelper->allowed(SpotSecurity::spotsec_edit_own_userprefs, '')) {
            $swEdit[] = ['label' => _('Change preferences'), 'href' => $prefsUrl];
            $swEdit[] = ['label' => _('Download button'), 'href' => $prefsUrl.'&tab=2'];
        }
        if ($tplHelper->allowed(SpotSecurity::spotsec_edit_settings, '')) {
            $swEdit[] = ['label' => _('Settings'), 'href' => '?page=editsettings'];
            $swEdit[] = ['label' => _('Newsservers'), 'href' => '?page=editsettings&tab=2'];
        }
        if ($tplHelper->allowed(SpotSecurity::spotsec_edit_other_users, '') || $tplHelper->allowed(SpotSecurity::spotsec_list_all_users, '') || $tplHelper->allowed(SpotSecurity::spotsec_edit_securitygroups, '')) {
            $swEdit[] = ['label' => _('User & group management'), 'href' => '?page=render&tplname=usermanagement'];
        }
        if ($tplHelper->allowed(SpotSecurity::spotsec_edit_settings, '')) {
            $swEdit[] = ['sep' => true];
            $swEdit[] = ['label' => _('Database'), 'children' => [
                ['label' => _('Server info'), 'href' => '?page=admin&tab=serverinfo'],
                ['label' => _('Maintenance'), 'href' => '?page=admin&tab=maintenance'],
            ]];
        }
    }
    $swMenu = [
        'file' => $swFile, 'edit' => $swEdit,
        'labels' => [
            'file' => _('File'), 'edit' => _('Edit'), 'view' => _('View'), 'help' => _('Help'),
            'table' => _('Table'), 'cards' => _('Cards'), 'theme' => _('Theme'), 'light' => _('Light'), 'dark' => _('Dark'), 'auto' => _('Auto'),
            'columns' => _('Columns'), 'fontsize' => _('Font size'), 'refresh' => _('Refresh'), 'documentation' => _('Documentation'),
            'about' => _('About'), 'genre' => _('Genre'), 'sender' => _('Sender'), 'date' => _('Date'), 'size' => _('Size'),
            'comments' => _('Comments'), 'nzb' => _('NZB'), 'points' => _('points'),
            'nosync' => _('No Usenet server configured'), 'syncing' => _('Syncing'), 'uptodate' => _('Up to date'), 'lastsync' => _('last sync'), 'waitfirst' => _('Waiting for first sync'), 'spotsn' => _('spots'), 'close' => _('Close'),
        ],
        'version' => SPOTWEB_VERSION,
        'syncToken' => $tplHelper->allowed(SpotSecurity::spotsec_retrieve_spots, '') ? $tplHelper->generateXsrfCookie('syncform') : null,
        'loginTitle' => _('Login'), 'addUserTitle' => _('Add user'), 'changeUserTitle' => _('Change user'),
    ];
?>
		<script type="text/javascript">window.SW_MENU = <?php echo json_encode($swMenu, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT); ?>;</script>
	</head>
	<body class="<?php echo htmlspecialchars(implode(' ', $bodyClasses), ENT_QUOTES, 'UTF-8'); ?>">
		<div id='editdialogdiv'></div>
		<div id="overlay"></div>
		<div class="container" id="container">
