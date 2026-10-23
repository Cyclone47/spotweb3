<?php
    $e = function ($v) {
        return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
    };
    $val = function ($k, $default = '') use ($values, $e) {
        return $e(isset($values[$k]) ? $values[$k] : $default);
    };
    $popularList = array_values(array_filter($popular, function ($n) use ($providers) {
        return isset($providers[$n]);
    }));
    $otherList = array_values(array_diff(array_keys($providers), $popularList));
    sort($otherList, SORT_NATURAL | SORT_FLAG_CASE);
    $steps = ['Appearance', 'Account', 'Usenet server', 'Downloads', 'Access', 'Finish'];
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spotweb setup</title>
<link rel="icon" type="image/png" href="templates/modern/img/spotnet-icon-64.png">
<base href="<?php echo $e($tplHelper->makeBaseUrl('full')); ?>">
<script>
  (function () {
    try {
      var pref = localStorage.getItem('spotweb_theme') || 'auto';
      var mode = pref === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : pref;
      document.documentElement.setAttribute('data-theme', mode);
    } catch (e) {}
  })();
</script>
<style>
  :root {
    --bg: #eef2f8; --surface: #ffffff; --surface2: #f3f6fb; --border: #c9d2e3; --text: #1b2233; --muted: #5d6b85;
    --accent: #2f6fe4; --navy: #1b2459; --navy-text: #dfe5f5; --navy-muted: #8f9bc4; --ok: #2e7d32; --err: #b3261e;
  }
  :root[data-theme="dark"] {
    --bg: #1b2332; --surface: #1f2839; --surface2: #172030; --border: #2f3c55; --text: #e7ecf6; --muted: #93a1bb;
    --accent: #4d8dff; --navy: #2b3d66; --navy-text: #e7ecf6; --navy-muted: #a3b0d0; --ok: #7bc47f; --err: #f2867c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }

  .win { width: 100%; max-width: 900px; min-height: 520px; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .win-title { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 14px; background: var(--navy); color: #fff; font-weight: 600; font-size: 13.5px; }
  .win-title img { display: block; border-radius: 3px; }
  .win-body { display: flex; flex: 1; min-height: 0; }

  .steps { width: 220px; flex: none; margin: 0; padding: 18px 0; list-style: none; background: var(--surface2); border-right: 1px solid var(--border); }
  .steps li { display: flex; align-items: center; gap: 12px; padding: 10px 18px; color: var(--muted); border-left: 3px solid transparent; }
  .steps li .n { width: 22px; height: 22px; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 50%; font-size: 12px; background: var(--surface); }
  .steps li.active { color: var(--text); font-weight: 600; border-left-color: var(--accent); background: var(--surface); }
  .steps li.active .n { background: var(--accent); border-color: var(--accent); color: #fff; }
  .steps li.done .n { background: var(--text); border-color: var(--text); color: var(--surface); }
  .steps li.done .n svg { width: 12px; height: 12px; }

  .pane { flex: 1; min-width: 0; padding: 26px 32px; overflow-y: auto; }
  .step { display: none; } .step.active { display: block; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
  p.lead { margin: 0 0 20px; color: var(--muted); }

  label { display: block; margin: 14px 0 4px; font-weight: 600; font-size: 13px; }
  input[type=text], input[type=email], input[type=password], input[type=number], select { width: 100%; height: 32px; padding: 0 10px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 3px; font: inherit; }
  input:focus, select:focus { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 0; border-color: var(--accent); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .hint { color: var(--muted); font-size: 12.5px; margin-top: 4px; }

  .options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 8px; }
  .option { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 10px 14px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface); color: var(--text); cursor: pointer; font-weight: 600; }
  .option svg { width: 26px; height: 26px; color: var(--muted); }
  .option small { font-weight: 400; color: var(--muted); font-size: 12px; }
  .option:hover { border-color: var(--muted); }
  .option.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .option.sel svg { color: var(--accent); }

  .check { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface2); font-weight: 400; font-size: 14px; cursor: pointer; }
  .check input { width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--accent); }
  .check b { font-weight: 600; }

  .errors { margin-bottom: 16px; padding: 10px 14px; border: 1px solid var(--err); border-left-width: 4px; border-radius: 3px; background: color-mix(in srgb, var(--err) 8%, var(--surface)); color: var(--text); }
  .errors ul { margin: 4px 0 0; padding-left: 18px; }
  #nntpresult { margin-left: 10px; font-size: 13px; } #nntpresult.ok { color: var(--ok); } #nntpresult.err { color: var(--err); }

  .summary { margin: 0; display: grid; grid-template-columns: 170px 1fr; border-top: 1px solid var(--border); }
  .summary dt, .summary dd { margin: 0; padding: 9px 0; border-bottom: 1px solid var(--border); }
  .summary dt { color: var(--muted); } .summary dd { font-weight: 600; }

  .win-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 16px; background: var(--surface2); border-top: 1px solid var(--border); }
  button { height: 32px; padding: 0 18px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover { filter: brightness(1.08); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .download-choice { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:3px; cursor:pointer; }
  .download-choice:has(input:checked) { border-color:var(--accent); background:var(--surface2); }
  .download-choice input { accent-color:var(--accent); }
  .download-location { margin-top:18px; padding:14px; border:1px solid var(--border); border-radius:3px; background:var(--surface2); }
  .download-location button { margin-bottom:6px; }


  .combo { position: relative; }
  .combo input { padding-right: 32px; }
  .combo-ico { position: absolute; right: 9px; top: 8px; width: 16px; height: 16px; color: var(--muted); pointer-events: none; }
  #providerlist { position: absolute; z-index: 10; left: 0; right: 0; top: 100%; max-height: 250px; overflow-y: auto; margin: 2px 0 0; padding: 2px; list-style: none; background: var(--surface); border: 1px solid var(--border); border-radius: 3px; box-shadow: 0 6px 18px rgba(0, 0, 0, .2); }
  #providerlist li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 2px; cursor: pointer; }
  #providerlist li small { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #providerlist li.group { cursor: default; padding: 8px 10px 3px; color: var(--muted); font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  #providerlist li.opt.active, #providerlist li.opt:hover { background: var(--accent); color: #fff; }
  #providerlist li.opt.active small, #providerlist li.opt:hover small { color: rgba(255, 255, 255, .85); }
  #providerlist li.empty { cursor: default; color: var(--muted); }

  @media (max-width: 700px) {
    body { padding: 0; align-items: stretch; }
    .win { border-radius: 0; border-left: 0; border-right: 0; min-height: 100vh; }
    .win-body { flex-direction: column; }
    .steps { width: auto; display: flex; padding: 0; border-right: 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
    .steps li { flex: none; padding: 10px 12px; border-left: 0; border-bottom: 3px solid transparent; }
    .steps li span.t { display: none; }
    .steps li.active span.t { display: inline; }
    .steps li.active { border-bottom-color: var(--accent); }
    .pane { padding: 20px 16px; }
    .row, .options { grid-template-columns: 1fr; }
    .summary { grid-template-columns: 120px 1fr; }
  }
</style>
</head>
<body>
<form class="win" id="wiz" method="post" action="?page=setup" autocomplete="off">
  <input type="hidden" name="setupform[xsrfid]" id="xsrfid" value="<?php echo $e($tplHelper->generateXsrfCookie('setupform')); ?>">
  <input type="hidden" name="setupform[theme]" id="theme" value="<?php echo $val('theme', 'auto'); ?>">

  <div class="win-title">
    <img src="templates/modern/img/spotnet-icon-64.png" alt="" width="20" height="20">
    Spotweb setup
  </div>

  <div class="win-body">
    <ol class="steps" id="steps">
<?php foreach ($steps as $i => $name) { ?>
      <li><span class="n"><?php echo $i + 1; ?></span><span class="t"><?php echo $e($name); ?></span></li>
<?php } ?>
    </ol>

    <div class="pane">
<?php if (!empty($errors)) { ?>
      <div class="errors"><strong>Please fix the following:</strong><ul>
<?php foreach ($errors as $err) { ?><li><?php echo $err; ?></li><?php } ?>
      </ul></div>
<?php } ?>

      <!-- Step 1: appearance -->
      <section class="step active" data-step="1">
        <h1>Appearance</h1>
        <p class="lead">Choose how Spotweb looks. You can change this later from the View menu.</p>
        <div class="options" id="themechoices">
          <div class="option" data-theme="light">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>
            Light
          </div>
          <div class="option" data-theme="dark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
            Dark
          </div>
          <div class="option" data-theme="auto">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>
            Automatic<small>follows your system</small>
          </div>
        </div>
      </section>

      <!-- Step 2: account -->
      <section class="step" data-step="2">
        <h1>Account</h1>
        <p class="lead">This account becomes the administrator of this Spotweb.</p>
        <div class="row">
          <div><label for="firstname">First name</label><input type="text" id="firstname" name="setupform[firstname]" value="<?php echo $val('firstname'); ?>"></div>
          <div><label for="lastname">Last name</label><input type="text" id="lastname" name="setupform[lastname]" value="<?php echo $val('lastname'); ?>"></div>
        </div>
        <label for="username">Username</label><input type="text" id="username" name="setupform[username]" value="<?php echo $val('username'); ?>" autocapitalize="none">
        <label for="mail">Email address</label><input type="email" id="mail" name="setupform[mail]" value="<?php echo $val('mail'); ?>">
        <div class="row">
          <div><label for="pw1">Password</label><input type="password" id="pw1" name="setupform[newpassword1]"></div>
          <div><label for="pw2">Repeat password</label><input type="password" id="pw2" name="setupform[newpassword2]"></div>
        </div>
        <div class="hint">At least 5 characters.</div>
      </section>

      <!-- Step 3: usenet -->
      <section class="step" data-step="3">
        <h1>Usenet server</h1>
        <p class="lead">Spotweb downloads spots through a Usenet provider you have an account with.</p>
        <label for="provider">Provider</label>
        <div class="combo">
          <input type="text" id="provider" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="providerlist" autocomplete="off" autocapitalize="none" placeholder="Type to search providers...">
          <svg class="combo-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <ul id="providerlist" role="listbox" hidden></ul>
        </div>
        <div class="row">
          <div><label for="nntp_host">Server address</label><input type="text" id="nntp_host" name="setupform[nntp_host]" value="<?php echo $val('nntp_host'); ?>" autocapitalize="none"></div>
          <div><label for="nntp_port">Port</label><input type="number" id="nntp_port" name="setupform[nntp_port]" value="<?php echo $val('nntp_port', '563'); ?>"></div>
        </div>
        <label for="nntp_enc">Encryption</label>
        <select id="nntp_enc" name="setupform[nntp_enc]">
          <option value="tls">TLS / SSL (recommended)</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">None</option>
        </select>
        <label for="nntp-max-connections">Maximum download connections</label>
        <input type="number" id="nntp-max-connections" name="setupform[nntp_max_connections]" min="1" max="100" step="1" value="<?php echo $val('nntp_max_connections', '4'); ?>">
        <div class="hint">Simultaneous connections shared by browser downloads (1–100). Leave room in your provider allowance for spot syncing and other apps.</div>
        <div class="row">
          <div><label for="nntp_user">Username</label><input type="text" id="nntp_user" name="setupform[nntp_user]" value="<?php echo $val('nntp_user'); ?>" autocapitalize="none"></div>
          <div><label for="nntp_pass">Password</label><input type="password" id="nntp_pass" name="setupform[nntp_pass]"></div>
        </div>
        <div style="margin-top:14px"><button type="button" id="testnntp">Test connection</button><span id="nntpresult"></span></div>
        <label class="check"><input type="checkbox" id="skipnntp" name="setupform[skipnntp]" value="1"<?php echo !empty($values['skipnntp']) ? ' checked' : ''; ?>><span><b>Skip for now</b><br><span class="hint">You can add a server later under Edit &rarr; Newsservers.</span></span></label>
      </section>

      <!-- Step 4: download method -->
      <section class="step" data-step="4">
        <h1>Downloads</h1>
        <p class="lead">Choose how you want to download. You can change this later in your preferences.</p>
<?php foreach (['browser' => 'Download in browser', 'nzb' => 'Download .nzb files', 'push-sabnzbd' => 'Download with SABnzbd', 'nzbget' => 'Download with NZBGet'] as $method => $label) { ?>
        <label class="download-choice"><input type="radio" name="setupform[download_method]" value="<?php echo $e($method); ?>"<?php echo (isset($values['download_method']) ? $values['download_method'] : 'browser') === $method ? ' checked' : ''; ?>><?php echo $e($label); ?></label>
<?php } ?>
        <div class="download-location" id="browser-location">
          <button type="button" class="primary" id="select-download-location">Select download location</button>
          <div id="download-location-status" class="hint" role="status">Select a local folder before continuing. No software installation is needed.</div>
          <input type="hidden" name="setupform[download_folder_selected]" id="download-folder-selected" value="0">
        </div>
        <div id="sab-download-settings" hidden>
          <label for="sab-url">SABnzbd URL</label><input type="text" id="sab-url" name="setupform[sab_url]" placeholder="http://your-server:8080/" value="<?php echo $val('sab_url'); ?>">
          <label for="sab-api-key">SABnzbd API key</label><input type="password" id="sab-api-key" name="setupform[sab_api_key]">
          <p class="hint">Connect to an existing SABnzbd instance.</p>
        </div>
        <div id="nzbget-download-settings" hidden>
          <div class="row"><div><label for="nzbget-host">NZBGet host</label><input type="text" id="nzbget-host" name="setupform[nzbget_host]" value="<?php echo $val('nzbget_host'); ?>"></div>
          <div><label for="nzbget-port">Port</label><input type="number" id="nzbget-port" name="setupform[nzbget_port]" value="<?php echo $val('nzbget_port', '6789'); ?>"></div></div>
          <div class="row"><div><label for="nzbget-user">Username</label><input type="text" id="nzbget-user" name="setupform[nzbget_user]" value="<?php echo $val('nzbget_user'); ?>"></div>
          <div><label for="nzbget-password">Password</label><input type="password" id="nzbget-password" name="setupform[nzbget_password]"></div></div>
          <label class="check"><input type="checkbox" id="nzbget-ssl" name="setupform[nzbget_ssl]" value="1"<?php echo !empty($values['nzbget_ssl']) ? ' checked' : ''; ?>>Use HTTPS</label>
          <p class="hint">Connect to an existing NZBGet instance.</p>
        </div>
      </section>

      <!-- Step 5: access -->
      <section class="step" data-step="5">
        <h1>Access and content</h1>
        <p class="lead">Decide who may use this Spotweb and what it downloads and shows.</p>
        <label class="check"><input type="checkbox" id="anonymous" name="setupform[anonymous]" value="1"<?php echo !empty($values) && empty($values['anonymous']) ? '' : ' checked'; ?>>
          <span><b>Allow anonymous access</b><br><span class="hint">When on, visitors can browse spots without logging in and people can create their own account. When off, everyone must log in first.</span></span></label>
        <label class="check"><input type="checkbox" id="prefetch" name="setupform[prefetch_images]" value="1"<?php echo !empty($values) && empty($values['prefetch_images']) ? '' : ' checked'; ?>>
          <span><b>Download post images (covers)</b><br><span class="hint">Fetches the cover of every new spot while syncing, so lists and spots open faster. This uses more bandwidth and makes the first sync slower.</span></span></label>
        <label class="check"><input type="checkbox" id="noerotica" name="setupform[hide_erotica]" value="1"<?php echo !empty($values['hide_erotica']) ? ' checked' : ''; ?>>
          <span><b>Hide erotic content</b><br><span class="hint">Leaves the erotic category out of the overview and removes its filters from the sidebar. You can still search for it.</span></span></label>
      </section>

      <!-- Step 6: review -->
      <section class="step" data-step="6">
        <h1>Finish</h1>
        <p class="lead">Review your choices, then finish the setup.</p>
        <dl class="summary" id="summary"></dl>
      </section>
    </div>
  </div>

  <div class="win-foot">
    <button type="button" id="back">Back</button>
    <span>
      <button type="button" class="primary" id="next">Next</button>
      <button type="submit" class="primary" id="finish" name="setupform[submitfinish]" value="1" style="display:none">Finish</button>
    </span>
  </div>
</form>

<script src="js/browser-download/nzb-parser.js?v=<?php echo filemtime(__DIR__.'/../../js/browser-download/nzb-parser.js'); ?>" defer></script>
<script src="js/browser-download/storage-manager.js?v=<?php echo filemtime(__DIR__.'/../../js/browser-download/storage-manager.js'); ?>" defer></script>
<script src="js/browser-download/download-manager.js?v=<?php echo max(array_map('filemtime', glob(__DIR__.'/../../js/browser-download/*.js'))); ?>" defer></script>
<script>
(function () {
  var providers = <?php echo json_encode($providers, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT); ?>;
  var steps = document.querySelectorAll('.step'), items = document.querySelectorAll('#steps li');
  var cur = <?php echo !empty($errors) ? 2 : 1; ?>;
  var $ = function (id) { return document.getElementById(id); };
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function setTheme(t) {
    $('theme').value = t;
    try { localStorage.setItem('spotweb_theme', t); } catch (e) {}
    var mode = t === 'auto' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
    document.documentElement.setAttribute('data-theme', mode);
    [].forEach.call(document.querySelectorAll('.option'), function (c) { c.classList.toggle('sel', c.getAttribute('data-theme') === t); });
  }
  [].forEach.call(document.querySelectorAll('.option'), function (c) { c.onclick = function () { setTheme(c.getAttribute('data-theme')); }; });
  setTheme($('theme').value || 'auto');

  var folderReady = false, selectingFolder = false, destinationName = '';
  function downloadMethod() { return document.querySelector('input[name="setupform[download_method]"]:checked').value; }
  function updateDownloads() {
    var method = downloadMethod();
    $('browser-location').hidden = method !== 'browser';
    $('sab-download-settings').hidden = method !== 'push-sabnzbd';
    $('nzbget-download-settings').hidden = method !== 'nzbget';
    $('download-folder-selected').value = folderReady ? '1' : '0';
    $('next').disabled = cur === 4 && method === 'browser' && (!folderReady || selectingFolder);
  }
  document.querySelectorAll('input[name="setupform[download_method]"]').forEach(function(radio) {
    radio.addEventListener('change', updateDownloads);
  });
  $('select-download-location').onclick = function () {
    var manager = window.spotwebBrowserDownloadManager;
    if (!manager) return;
    selectingFolder = true;
    updateDownloads();
    manager.selectDestinationDirectory().then(function(handle) {
      folderReady = true;
      destinationName = handle.name;
      $('download-location-status').textContent = 'Save downloads to: ' + handle.name;
    }).catch(function(err) {
      $('download-location-status').textContent = err.name === 'AbortError'
        ? (folderReady ? 'Save downloads to: ' + destinationName : 'Select a local folder before continuing.')
        : err.message;
    }).then(function() { selectingFolder = false; updateDownloads(); });
  };
  document.addEventListener('DOMContentLoaded', function() {
    var manager = window.spotwebBrowserDownloadManager;
    if (!manager) return;
    var support = manager.checkBrowserSupport();
    if (!support.supported) {
      $('select-download-location').disabled = true;
      $('download-location-status').textContent = 'Browser downloads need desktop Chrome or Edge over HTTPS or localhost. Choose another method to continue in this browser.';
      return;
    }
    manager.init().then(function() {
      var handle = manager.destinationDirectory;
      if (!handle) return;
      return window.SpotwebStorageManager.verifyDirectoryPermission(handle, false).then(function(permission) {
        if (permission === 'granted') {
          folderReady = true;
          destinationName = handle.name;
          $('download-location-status').textContent = 'Save downloads to: ' + handle.name;
          updateDownloads();
        }
      });
    }).catch(function() {});
  });

  // searchable provider list (type to filter, arrows + enter to pick)
  var popularNames = <?php echo json_encode($popularList); ?>;
  var allNames = Object.keys(providers).sort(function (x, y) { return x.toLowerCase().localeCompare(y.toLowerCase()); });
  var otherNames = allNames.filter(function (n) { return popularNames.indexOf(n) < 0; });
  var box = $('provider'), list = $('providerlist'), activeIdx = -1, shown = [];

  function pick(name) {
    var p = providers[name];
    box.value = name;
    closeList();
    if (!p) { return; }
    $('nntp_host').value = p.host;
    $('nntp_port').value = p.port || (p.enc ? 563 : 119);
    $('nntp_enc').value = p.enc || 'none';
    $('nntpresult').textContent = '';
  }
  function closeList() { list.hidden = true; box.setAttribute('aria-expanded', 'false'); activeIdx = -1; }
  function setActive(i) {
    var opts = list.querySelectorAll('li.opt');
    if (!opts.length) { return; }
    activeIdx = (i + opts.length) % opts.length;
    [].forEach.call(opts, function (o, k) { o.classList.toggle('active', k === activeIdx); });
    opts[activeIdx].scrollIntoView({ block: 'nearest' });
  }
  function render() {
    var q = box.value.trim().toLowerCase();
    var match = function (n) { return !q || n.toLowerCase().indexOf(q) >= 0 || providers[n].host.toLowerCase().indexOf(q) >= 0; };
    var pop = popularNames.filter(match), rest = otherNames.filter(match);
    list.innerHTML = ''; shown = [];
    function group(label) { var li = document.createElement('li'); li.className = 'group'; li.textContent = label; list.appendChild(li); }
    function item(n) {
      var li = document.createElement('li'); li.className = 'opt'; li.setAttribute('role', 'option');
      var a = document.createElement('span'); a.textContent = n;
      var b = document.createElement('small'); b.textContent = providers[n].host;
      li.appendChild(a); li.appendChild(b);
      li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(n); });
      list.appendChild(li); shown.push(n);
    }
    if (pop.length) { group('Popular'); pop.forEach(item); }
    if (rest.length) { group(q ? 'Other providers' : 'All providers'); rest.forEach(item); }
    if (!shown.length) { var e = document.createElement('li'); e.className = 'empty'; e.textContent = 'No provider found. Enter the server details below.'; list.appendChild(e); }
    list.hidden = false; box.setAttribute('aria-expanded', 'true');
    setActive(0);
  }
  box.addEventListener('input', render);
  box.addEventListener('focus', function () { box.select(); render(); });
  box.addEventListener('blur', function () { setTimeout(closeList, 120); });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) { render(); } else { setActive(activeIdx + 1); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') { if (!list.hidden && shown.length) { e.preventDefault(); e.stopPropagation(); pick(shown[Math.max(activeIdx, 0)]); } }
    else if (e.key === 'Escape') { closeList(); }
  });

  function summary() {
    var skip = $('skipnntp').checked;
    var names = { light: 'Light', dark: 'Dark', auto: 'Automatic' };
    var rows = [
      ['Appearance', names[$('theme').value] || $('theme').value],
      ['Account', $('firstname').value + ' ' + $('lastname').value + ' (' + $('username').value + ')'],
      ['Usenet server', skip ? 'Not configured yet' : $('nntp_host').value + ':' + $('nntp_port').value],
      ['Download connections', $('nntp-max-connections').value],
      ['Download method', document.querySelector('input[name="setupform[download_method]"]:checked').parentNode.textContent.trim()],
      ['Download location', downloadMethod() === 'browser' ? destinationName : 'Managed by the selected download method'],
      ['Anonymous access', $('anonymous').checked ? 'On' : 'Off (login required)'],
      ['Download covers', $('prefetch').checked ? 'Yes' : 'No'],
      ['Hide erotic content', $('noerotica').checked ? 'Yes' : 'No']
    ];
    var dl = $('summary'); dl.innerHTML = '';
    rows.forEach(function (r) {
      var dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = r[0]; dd.textContent = r[1]; dl.appendChild(dt); dl.appendChild(dd);
    });
  }

  function show(n) {
    if (cur === 3 && n > cur && !$('nntp-max-connections').checkValidity()) { $('nntp-max-connections').reportValidity(); return; }
    if (cur === 4 && n > cur && downloadMethod() === 'browser' && (!folderReady || selectingFolder)) return;
    cur = Math.max(1, Math.min(steps.length, n));
    [].forEach.call(steps, function (s, i) { s.classList.toggle('active', i === cur - 1); });
    [].forEach.call(items, function (li, i) {
      li.classList.toggle('active', i === cur - 1);
      li.classList.toggle('done', i < cur - 1);
      var num = li.querySelector('.n');
      num.innerHTML = i < cur - 1 ? CHECK : String(i + 1);
    });
    $('back').style.visibility = cur === 1 ? 'hidden' : 'visible';
    $('next').style.display = cur === steps.length ? 'none' : '';
    $('finish').style.display = cur === steps.length ? '' : 'none';
    updateDownloads();
    if (cur === steps.length) { summary(); }
    window.scrollTo(0, 0);
  }
  $('next').onclick = function () { show(cur + 1); };
  $('back').onclick = function () { show(cur - 1); };
  $('wiz').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && cur < steps.length) { e.preventDefault(); show(cur + 1); }
  });
  $('wiz').addEventListener('submit', function(event) {
    if (downloadMethod() === 'browser' && (!folderReady || selectingFolder)) {
      event.preventDefault();
      show(4);
    }
  });

  $('testnntp').onclick = function () {
    var out = $('nntpresult'), fd = new FormData();
    out.className = ''; out.textContent = 'Testing...';
    fd.append('setupform[xsrfid]', $('xsrfid').value);
    fd.append('setupform[submittestnntp]', '1');
    ['nntp_host', 'nntp_port', 'nntp_enc', 'nntp_user', 'nntp_pass'].forEach(function (k) { fd.append('setupform[' + k + ']', $(k).value); });
    fetch('?page=setup', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.xsrf) { $('xsrfid').value = j.xsrf; }
        out.className = j.ok ? 'ok' : 'err';
        out.textContent = j.message;
      })
      .catch(function () { out.className = 'err'; out.textContent = 'Could not run the test'; });
  };

  show(cur);
})();
</script>
</body>
</html>
