# Security

Keep Usenet passwords, API tokens, private keys, cookie jars, SQLite databases and
other runtime data outside the source tree. Docker stores installation data in
`/data`; native LXC installations use `/var/lib/spotweb`. Do not commit `.env` or
local settings files. `.env.example` contains empty configuration fields only.

The development Compose override uses the normal setup wizard and does not set
a shared administrator password. Optional Twitter integration requires credentials
for your own application, supplied through the environment.

Relay tokens are signed using the installation's `pass_salt`. Token issuance
fails if that secret is missing, and tokens generated using the earlier
empty-salt implementation are rejected. Upgrading an older installation requires
refreshing the browser's relay credentials and restarting its relay process.

This distribution starts from a source snapshot with a fresh Git history. It
does not include upstream runtime database snapshots, authentication-cookie
files, generated random-seed files or the Composer dependency directory.
Composer installs the locked dependencies at build/install time. Upstream
copyright notices and licenses are retained.

GitHub Actions scans repository history with Gitleaks. Scan locally before pushing
changes as well: CI detection runs after data has already reached GitHub. If a
credential is committed, revoke/rotate it and remove it from publication history.

For a vulnerability in this repository, use GitHub's private vulnerability reporting
when available. Avoid placing credentials or personal data in public issues.
