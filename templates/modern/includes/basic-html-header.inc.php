<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
		<meta name="theme-color" content="#3b5bfd">
		<title>SpotWeb</title>
		<link rel="icon" type="image/png" href="<?php echo htmlspecialchars($tplHelper->getThemeAssetPath('img/spotnet-icon-64.png'), ENT_QUOTES, 'UTF-8'); ?>">
		<script type="text/javascript">
		(function(){
		  try {
		    var def = '<?php $defTheme = $settings->get('default_theme_mode'); echo in_array($defTheme, ['light', 'dark', 'auto'], true) ? $defTheme : 'auto'; ?>';
		    var pref = localStorage.getItem('spotweb_theme') || def;
		    var mode = pref === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
		    document.documentElement.setAttribute('data-theme', mode);
		  } catch(e) {}
		})();
		</script>
		<link rel="stylesheet" type="text/css" href="<?php echo htmlspecialchars($tplHelper->getThemeAssetPath('css/auth.css'), ENT_QUOTES, 'UTF-8'); ?>">
		<style type='text/css'>
			<?php echo $settings->get('customcss'); ?>
		</style>
	</head>

	<body class="modern-theme sw-auth">
		<div class="container">
			<img class="sw-brand" src="<?php echo htmlspecialchars($tplHelper->getThemeAssetPath('img/spotweb3-logo.png'), ENT_QUOTES, 'UTF-8'); ?>" alt="Spotweb 3" width="380" height="190">
