<?php
    require __DIR__.'/includes/header.inc.php';

    $e = function ($v) {
        return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
    };
    $bytes = function ($b) {
        if ($b === null) {
            return '–';
        }
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $i = 0;
        while ($b >= 1024 && $i < count($units) - 1) {
            $b /= 1024;
            $i++;
        }

        return round($b, $i ? 1 : 0).' '.$units[$i];
    };
    $when = function ($ts) {
        return $ts ? date('Y-m-d H:i', $ts) : '–';
    };
    $pct = function ($part, $whole) {
        return ($part === null || !$whole) ? 0 : max(0, min(100, round($part / $whole * 100)));
    };
?>
</div>
<div id="toolbar">
  <div class="closeadmin"><p><a class="toggle" href="<?php echo $e($tplHelper->makeBaseUrl('path')); ?>"><?php echo _('Back to mainview'); ?></a></p></div>
</div>
<?php require __DIR__.'/includes/admin-nav.inc.php'; ?>
<style>
  body.modern-page-admin .admin-center { max-width: 1207px; margin: 12px auto 24px; padding: 24px; background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border); border-radius: 20px; font: 14px/1.6 var(--font, 'Segoe UI', sans-serif); }
  body.sw-desktop.modern-page-admin .admin-center { max-width: 980px; }
  .admin-center h2 { margin: 24px 0 10px; font-size: 16px; }
  .admin-center a { color: var(--color-accent); }
  .admin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
  .admin-card { border: 1px solid var(--color-border); border-radius: 14px; padding: 16px 18px; background: var(--color-bg); }
  .admin-card h3 { margin: 0 0 6px; font-size: 15px; }
  .admin-card p { margin: 0 0 8px; color: var(--color-muted); }
  .admin-card a.cardlink { text-decoration: none; font-weight: 600; }
  .admin-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
  .admin-kv dt { color: var(--color-muted); }
  .admin-kv dd { margin: 0; word-break: break-word; }
  .admin-meter { height: 8px; border-radius: 4px; background: var(--color-border); overflow: hidden; margin: 6px 0 4px; }
  .admin-meter > span { display: block; height: 100%; background: var(--color-accent); }
  .admin-table { width: 100%; border-collapse: collapse; }
  .admin-table th, .admin-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--color-border); }
  .admin-table td.num, .admin-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .admin-msg { padding: 10px 14px; border-radius: 10px; margin-bottom: 16px; border: 1px solid var(--color-border); }
  .admin-msg.ok { border-color: #16a34a; }
  .admin-msg.err { border-color: #dc2626; }
  .admin-task form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 8px; }
  body.modern-config .admin-task input[type=number] { width: 84px; min-height: 36px; padding: 4px 10px; }
  body.modern-config .admin-task button { height: 38px; padding: 0 20px; border-radius: 999px; border: 0; background: var(--color-accent); color: #fff; font-weight: 700; cursor: pointer; }
  body.modern-config .admin-task.danger button { background: #dc2626; }
  .admin-ext.ok { color: #16a34a; } .admin-ext.missing { color: #dc2626; }
  @media (max-width: 600px) { body.modern-page-admin .admin-center { margin: 8px; padding: 14px; border-radius: 14px; } .admin-kv { grid-template-columns: 1fr; } .admin-kv dd { margin-bottom: 6px; } }
</style>

<div class="admin-center">
<?php if ($result !== null) { ?>
  <div class="admin-msg <?php echo $result['ok'] ? 'ok' : 'err'; ?>"><?php echo $e($result['message']); ?></div>
<?php } ?>

<?php if ($tab === 'manage') { ?>
  <div class="admin-grid">
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_edit_own_userprefs, '')) { ?>
    <div class="admin-card"><h3><?php echo _('Change preferences'); ?></h3><p><?php echo _('Personal preferences, language, NZB download integration, filters, notifications and custom CSS.'); ?></p><a class="cardlink" href="?page=edituserprefs&amp;userid=<?php echo (int) $currentSession['user']['userid']; ?>"><?php echo _('Open'); ?> &rarr;</a></div>
<?php } ?>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_edit_settings, '')) { ?>
    <div class="admin-card admin-task">
      <h3><?php echo _('Automatic spot retrieval'); ?></h3>
      <p><?php echo _('Check the newsserver for new spots on this schedule. Refresh checks immediately.'); ?></p>
      <form method="post" action="?page=admin">
        <input type="hidden" name="adminform[xsrfid]" value="<?php echo $e($tplHelper->generateXsrfCookie('adminform')); ?>">
        <label for="retrieval-interval"><?php echo _('Check for new spots'); ?></label>
        <select id="retrieval-interval" name="adminform[interval]">
<?php foreach ($retrievalIntervals as $seconds => $label) { ?>
          <option value="<?php echo (int) $seconds; ?>"<?php echo $retrievalSchedule['interval'] === $seconds ? ' selected' : ''; ?>><?php echo $e(_($label)); ?></option>
<?php } ?>
        </select>
        <button type="submit" name="adminform[submitsaveretrieval]" value="1"><?php echo _('Save schedule'); ?></button>
      </form>
      <p><?php echo $retrievalSchedule['schedulerActive'] ? _('Background retriever is active.') : _('Background retriever is not running. Start the retrieval scheduler to apply this schedule.'); ?></p>
<?php if (!empty($retrievalSchedule['error'])) { ?><p role="alert"><?php echo $e($retrievalSchedule['error']); ?></p><?php } ?>
<?php if ($retrievalSchedule['next']) { ?><p><?php echo _('Next automatic check:'); ?> <time data-local-time="<?php echo (int) $retrievalSchedule['next']; ?>" datetime="<?php echo gmdate('c', $retrievalSchedule['next']); ?>"><?php echo $when($retrievalSchedule['next']); ?> UTC</time></p><?php } ?>
    </div>
    <div class="admin-card"><h3><?php echo _('Settings'); ?></h3><p><?php echo _('Newsservers, retrieval, performance, custom CSS and general options.'); ?></p><a class="cardlink" href="?page=editsettings"><?php echo _('Open'); ?> &rarr;</a></div>
<?php } ?>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_edit_other_users, '') || $tplHelper->allowed(SpotSecurity::spotsec_list_all_users, '')) { ?>
    <div class="admin-card"><h3><?php echo _('Users'); ?></h3><p><?php echo _('Create, edit and remove users and their group membership.'); ?></p><a class="cardlink" href="?page=render&amp;tplname=usermanagement"><?php echo _('Open'); ?> &rarr;</a></div>
<?php } ?>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_edit_securitygroups, '')) { ?>
    <div class="admin-card"><h3><?php echo _('Groups &amp; permissions'); ?></h3><p><?php echo _('Security groups and the rights each group has.'); ?></p><a class="cardlink" href="?page=render&amp;tplname=usermanagement&amp;tab=2"><?php echo _('Open'); ?> &rarr;</a></div>
<?php } ?>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_view_statistics, '')) { ?>
    <div class="admin-card"><h3><?php echo _('Statistics'); ?></h3><p><?php echo _('Spot statistics for this installation.'); ?></p><a class="cardlink" href="?page=statistics"><?php echo _('Open'); ?> &rarr;</a></div>
<?php } ?>
<?php if ($tplHelper->allowed(SpotSecurity::spotsec_edit_settings, '')) { ?>
    <div class="admin-card"><h3><?php echo _('Server info'); ?></h3><p><?php echo _('Resources, storage and database size.'); ?></p><a class="cardlink" href="?page=admin&amp;tab=serverinfo"><?php echo _('Open'); ?> &rarr;</a></div>
    <div class="admin-card"><h3><?php echo _('Maintenance'); ?></h3><p><?php echo _('Clean caches, sessions and old data; optimize the database.'); ?></p><a class="cardlink" href="?page=admin&amp;tab=maintenance"><?php echo _('Open'); ?> &rarr;</a></div>
<?php } ?>
  </div>
<?php } ?>

<?php if ($tab === 'serverinfo' && $serverinfo !== null) {
    $sys = $serverinfo['system'];
    $sto = $serverinfo['storage'];
    $db = $serverinfo['database'];
?>
  <div class="admin-grid">
    <div class="admin-card">
      <h3><?php echo _('System'); ?></h3>
      <dl class="admin-kv">
        <dt>Spotweb</dt><dd><?php echo $e($sys['spotweb_version']); ?></dd>
        <dt>PHP</dt><dd><?php echo $e($sys['php_version'].' ('.$sys['php_sapi'].')'); ?></dd>
        <dt><?php echo _('OS'); ?></dt><dd><?php echo $e($sys['os']); ?></dd>
        <dt><?php echo _('Host'); ?></dt><dd><?php echo $e($sys['hostname']); ?><?php echo $sys['in_container'] ? ' (container)' : ''; ?></dd>
<?php if ($sys['web_server']) { ?><dt><?php echo _('Web server'); ?></dt><dd><?php echo $e($sys['web_server']); ?></dd><?php } ?>
        <dt><?php echo _('PHP memory limit'); ?></dt><dd><?php echo $e($sys['memory_limit']); ?></dd>
        <dt><?php echo _('Server time'); ?></dt><dd><?php echo $e($sys['server_time']); ?></dd>
<?php if ($sys['uptime'] !== null) { ?><dt><?php echo _('Uptime'); ?></dt><dd><?php echo floor($sys['uptime'] / 86400); ?>d <?php echo floor(($sys['uptime'] % 86400) / 3600); ?>h</dd><?php } ?>
<?php if ($sys['load'] !== null) { ?><dt><?php echo _('Load average'); ?></dt><dd><?php echo $e(implode(' / ', $sys['load'])); ?></dd><?php } ?>
      </dl>
<?php if ($sys['memory_total'] !== null) { ?>
      <div class="admin-meter"><span style="width: <?php echo $pct($sys['memory_total'] - $sys['memory_free'], $sys['memory_total']); ?>%"></span></div>
      <small><?php echo _('Memory'); ?>: <?php echo $bytes($sys['memory_total'] - $sys['memory_free']); ?> / <?php echo $bytes($sys['memory_total']); ?></small>
<?php } ?>
    </div>

    <div class="admin-card">
      <h3><?php echo _('Storage'); ?></h3>
      <div class="admin-meter"><span style="width: <?php echo $pct($sto['disk_used'], $sto['disk_total']); ?>%"></span></div>
      <small><?php echo _('Disk'); ?> (<?php echo $e($sto['disk_path']); ?>): <?php echo $bytes($sto['disk_used']); ?> / <?php echo $bytes($sto['disk_total']); ?>, <?php echo $bytes($sto['disk_free']); ?> <?php echo _('free'); ?></small>
      <dl class="admin-kv" style="margin-top: 10px">
        <dt><?php echo _('Cache path'); ?></dt><dd><?php echo $e($sto['cache_path']); ?><?php echo $sto['writable'] ? '' : ' <strong>('._('not writable').')</strong>'; ?></dd>
        <dt><?php echo _('Cache on disk'); ?></dt><dd><?php echo $bytes($sto['cache_bytes']); ?> (<?php echo number_format($sto['cache_files']); ?> <?php echo _('files'); ?>)</dd>
        <dt><?php echo _('Cache entries'); ?></dt><dd><?php echo number_format($sto['cache_rows']); ?></dd>
      </dl>
    </div>

    <div class="admin-card">
      <h3><?php echo _('Database'); ?></h3>
      <dl class="admin-kv">
        <dt><?php echo _('Engine'); ?></dt><dd><?php echo $e($db['engine'].' '.$db['version']); ?></dd>
        <dt><?php echo _('Size'); ?></dt><dd><?php echo $bytes($db['size']); ?></dd>
        <dt><?php echo _('Oldest spot'); ?></dt><dd><?php echo $when($db['oldest_spot']); ?></dd>
        <dt><?php echo _('Newest spot'); ?></dt><dd><?php echo $when($db['newest_spot']); ?></dd>
      </dl>
    </div>
  </div>

  <h2><?php echo _('Tables'); ?></h2>
  <table class="admin-table">
    <thead><tr><th><?php echo _('Table'); ?></th><th><?php echo _('Description'); ?></th><th class="num"><?php echo _('Rows'); ?></th></tr></thead>
    <tbody>
<?php foreach ($db['tables'] as $t) { ?>
      <tr><td><code><?php echo $e($t['table']); ?></code></td><td><?php echo $e($t['label']); ?></td><td class="num"><?php echo number_format($t['rows']); ?></td></tr>
<?php } ?>
    </tbody>
  </table>

  <h2><?php echo _('Retriever'); ?></h2>
  <table class="admin-table">
    <thead><tr><th><?php echo _('Type'); ?></th><th class="num"><?php echo _('Last article'); ?></th><th><?php echo _('Last run'); ?></th><th><?php echo _('Status'); ?></th></tr></thead>
    <tbody>
<?php foreach ($serverinfo['retriever'] as $r) { ?>
      <tr><td><?php echo $e($r['infotype']); ?></td><td class="num"><?php echo number_format($r['curarticlenr']); ?></td><td><?php echo $when($r['lastretrieved']); ?></td><td><?php echo $r['running'] ? _('running') : _('idle'); ?></td></tr>
<?php } ?>
    </tbody>
  </table>

  <h2><?php echo _('PHP extensions'); ?></h2>
  <p>
<?php foreach ($sys['extensions'] as $ext => $loaded) { ?>
    <span class="admin-ext <?php echo $loaded ? 'ok' : 'missing'; ?>"><?php echo $loaded ? '✓' : '✗'; ?> <?php echo $e($ext); ?></span>&nbsp;
<?php } ?>
  </p>
<?php } ?>

<?php if ($tab === 'maintenance') { ?>
  <div class="admin-grid" style="grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))">
<?php foreach ($tasks as $key => $task) { ?>
    <div class="admin-card admin-task<?php echo $task[3] ? ' danger' : ''; ?>">
      <h3><?php echo $e(_($task[0])); ?></h3>
      <p><?php echo $e(_($task[1])); ?></p>
      <form method="post" action="?page=admin&amp;tab=maintenance">
        <input type="hidden" name="adminform[xsrfid]" value="<?php echo $e($tplHelper->generateXsrfCookie('adminform')); ?>">
        <input type="hidden" name="adminform[task]" value="<?php echo $e($key); ?>">
<?php if ($task[2]) { ?>
        <label><?php echo _('Older than'); ?> <input type="number" min="1" name="adminform[days]" value="30"> <?php echo _('days'); ?></label>
<?php } ?>
<?php if ($task[3]) { ?>
        <label><input type="checkbox" name="adminform[confirm]" value="1"> <?php echo _('I understand this cannot be undone'); ?></label>
<?php } ?>
        <button type="submit" name="adminform[submitruntask]" value="1"><?php echo _('Run'); ?></button>
      </form>
    </div>
<?php } ?>
  </div>
<?php } ?>
</div>
<?php
    require_once __DIR__.'/includes/footer.inc.php';
