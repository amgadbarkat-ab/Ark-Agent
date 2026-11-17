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

    // ---- Paid licence keys after Stripe payment (v0.1.44) -------------------------------------
    // From `bun scripts/ark-trial.ts license-keygen` on Amgad's PC: paste the two lines from
    // ~/.arklicense/license-config.php.txt here. The secret never goes anywhere else.
    'license_secret_key' => '',
    'license_public_key' => '',
    // Days a key stays valid after the paid period ends.
    'license_grace_days' => 7,
    // Where the app asks daily for the renewed key. Leave as is.
    'license_renew_url' => 'https://blackark.uk/checkin/renew/',
    // The Stripe webhook's signing secret (whsec_…), from the Stripe dashboard. Never post it.
    'stripe_webhook_secret' => '',
    // Which plan each Stripe price is. Price ids are not secret. Example:
    //   'price_1AbC…' => ['plan' => 'team', 'seats' => 1, 'addons' => []],
    //   'price_1Phone…' => ['addon' => 'phone'],   // the phone add-on as its own price
    'stripe_prices' => [],

    // ---- The buy page and the prepaid phone balance (v0.1.47) ----------------------------------
    // Where these pages are, for the links Stripe returns to. Leave as is on blackark.uk.
    'public_base_url' => 'https://blackark.uk/checkin',
    'buy_url' => 'https://blackark.uk/checkin/buy/',
    'buy_cancel_url' => 'https://blackark.uk/',
    // A RESTRICTED Stripe key (rk_live_…). It needs: Checkout Sessions write; for automatic top-up
    // also Invoices write and Customers read. Nothing else. Never post it.
    'stripe_api_key' => '',
    // The price ids the buy page puts in a checkout: the team plan (monthly), the phone add-on
    // (monthly), and one prepaid 5-hour phone block (a one-off price of EUR 23.40).
    'stripe_buy' => ['plan' => '', 'phone' => '', 'block' => ''],
    // Let Stripe add VAT at checkout (Stripe Tax must be set up in the dashboard first).
    'stripe_automatic_tax' => false,
    // The secret the phone relay signs its balance and charge requests with: 32+ random characters,
    // the same as BILLING_SECRET in the relay's .env. Make it with: php -r 'echo bin2hex(random_bytes(32));'
    'relay_secret' => '',
    // Prices in mils (1/1000 euro), excl. VAT. A block is 5 hours at the incoming rate (Amgad).
    // The balance never goes below zero: calls stop before a minute it cannot pay.
    'phone_rates_mils' => ['incoming' => 78, 'landline' => 88, 'mobile' => 139],
    'phone_block_mils' => 23400,
    // "Low" (the notice, the email, the automatic top-up) is the last hour at the mobile rate.
    'phone_low_mils' => 8340,
    // The one email when the last hour starts. OFF until Amgad approves the text below.
    'phone_low_email' => false,
    'phone_low_email_from' => 'no-reply@blackark.uk',
    'phone_low_email_subject' => 'ArkAgent: απομένει λιγότερο από μία ώρα τηλεφωνίας',
    'phone_low_email_text' => "Καλησπέρα,\n\nΣτο υπόλοιπο τηλεφωνίας του ArkAgent απομένουν περίπου {minutes} λεπτά.\nΓια να συνεχίσει ο ψηφιακός υπάλληλος να απαντά στις κλήσεις, προσθέστε 5 ώρες εδώ:\n{topup}\n\nBlackArk",
];
