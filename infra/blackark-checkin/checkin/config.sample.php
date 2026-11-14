<?php
/**
 * Copy this file to config.php (same folder) and fill it in. config.php is denied to the web by
 * .htaccess and is never committed.
 */
return [
    // The status page password, as a hash. Make it on your own computer, never on the server:
    //   php -r 'echo password_hash(readline("Password: "), PASSWORD_DEFAULT), "\n";'
    'admin_password_hash' => '',

    // Where the SQLite file lives. Best outside the web root if one.com lets you write there;
    // otherwise the data/ folder here, which .htaccess denies to the web.
    'data_dir' => __DIR__ . '/data',

    // BlackArk's trial public key(s): the same as shared/trial-public-key.ts in ArkAgent.
    'trial_public_keys' => [
        '+sUZUOflN+rBn01lZ1gTFr/Q2hL/OqhJqJ1XizQ9+9o=',
    ],

    // Refuse check-ins that carry no signed profile. Turn on once every install runs v0.1.38+.
    'require_proof' => false,

    // The shortest gap between two check-ins of one install, in seconds.
    'rate_limit_seconds' => 300,

    // The most installs kept. A new install beyond this is refused.
    'max_installs' => 2000,
];
