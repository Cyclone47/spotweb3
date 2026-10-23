<?php
    $adminNavPage = strtolower((string) ($_GET['page'] ?? 'admin'));
    $adminNavTpl = strtolower((string) ($_GET['tplname'] ?? ''));
    $adminNavTab = strtolower((string) ($_GET['tab'] ?? 'manage'));
    $adminNavUserId = (int) ($currentSession['user']['userid'] ?? 0);
    $adminNavPrefsUrl = '?page=edituserprefs&userid='.$adminNavUserId;

    $canEditPrefs = $tplHelper->allowed(SpotSecurity::spotsec_edit_own_userprefs, '');
    $canEditSettings = $tplHelper->allowed(SpotSecurity::spotsec_edit_settings, '');
    $canManageUsers = $tplHelper->allowed(SpotSecurity::spotsec_edit_other_users, '')
        || $tplHelper->allowed(SpotSecurity::spotsec_list_all_users, '')
        || $tplHelper->allowed(SpotSecurity::spotsec_edit_securitygroups, '');

    $adminNavItems = [
        [
            'key'    => 'manage',
            'label'  => _('Overview'),
            'href'   => '?page=admin',
            'active' => ($adminNavPage === 'admin' && !in_array($adminNavTab, ['serverinfo', 'maintenance'], true)),
            'show'   => true,
        ],
        [
            'key'    => 'preferences',
            'label'  => _('Change preferences'),
            'href'   => $adminNavPrefsUrl,
            'active' => ($adminNavPage === 'edituserprefs'),
            'show'   => $canEditPrefs,
        ],
        [
            'key'    => 'settings',
            'label'  => _('Settings'),
            'href'   => '?page=editsettings',
            'active' => ($adminNavPage === 'editsettings'),
            'show'   => $canEditSettings,
        ],
        [
            'key'    => 'users',
            'label'  => _('User & group management'),
            'href'   => '?page=render&tplname=usermanagement',
            'active' => ($adminNavPage === 'render' && $adminNavTpl === 'usermanagement'),
            'show'   => $canManageUsers,
        ],
        [
            'key'    => 'serverinfo',
            'label'  => _('Server info'),
            'href'   => '?page=admin&tab=serverinfo',
            'active' => ($adminNavPage === 'admin' && $adminNavTab === 'serverinfo'),
            'show'   => $canEditSettings,
        ],
        [
            'key'    => 'maintenance',
            'label'  => _('Maintenance'),
            'href'   => '?page=admin&tab=maintenance',
            'active' => ($adminNavPage === 'admin' && $adminNavTab === 'maintenance'),
            'show'   => $canEditSettings,
        ],
    ];
?>
<style>
  .admin-shell-nav { max-width: 1207px; margin: 16px auto 0; padding: 18px 24px 0; background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border); border-radius: 20px; font: 14px/1.6 var(--font, 'Segoe UI', sans-serif); }
  body.sw-desktop .admin-shell-nav { max-width: 980px; margin: 12px auto 0; border-radius: 4px; }
  .admin-shell-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .admin-shell-top h1 { margin: 0; font-size: 20px; }
  .admin-shell-top a.admin-back { color: var(--color-accent); text-decoration: none; font-size: 13.5px; }
  .admin-tabs { display: flex; gap: 4px; margin: 12px 0 0; border-bottom: 0; overflow-x: auto; }
  .admin-tabs a { padding: 9px 16px; text-decoration: none; color: var(--color-muted); border-bottom: 3px solid transparent; white-space: nowrap; font-size: 13.5px; }
  .admin-tabs a:hover { color: var(--color-text); }
  .admin-tabs a.active { color: var(--color-text); border-bottom-color: var(--color-accent); font-weight: 600; }
  @media (max-width: 600px) { .admin-shell-nav { margin: 8px 8px 0; padding: 14px 14px 0; border-radius: 14px; } }
</style>
<div class="admin-shell-nav">
  <div class="admin-shell-top">
    <h1><?php echo htmlspecialchars(_('Admin center'), ENT_QUOTES, 'UTF-8'); ?></h1>
    <a class="admin-back" href="<?php echo htmlspecialchars($tplHelper->makeBaseUrl('path'), ENT_QUOTES, 'UTF-8'); ?>">&larr; <?php echo htmlspecialchars(_('Back to mainview'), ENT_QUOTES, 'UTF-8'); ?></a>
  </div>
  <nav class="admin-tabs">
<?php foreach ($adminNavItems as $navItem) {
    if (!$navItem['show']) {
        continue;
    } ?>
    <a href="<?php echo htmlspecialchars($navItem['href'], ENT_QUOTES, 'UTF-8'); ?>"<?php echo $navItem['active'] ? ' class="active"' : ''; ?>><?php echo htmlspecialchars($navItem['label'], ENT_QUOTES, 'UTF-8'); ?></a>
<?php } ?>
  </nav>
</div>
