<?php
/**
 * Ark Private Server (#149; COO's table, prices approved by Amgad 19 Nov 17:45, comment 7014144068):
 * a private server BlackArk sets up for one customer to run local models on. One entry per tier, in
 * the order the app shows them. EUR, excluding VAT, monthly; the GPU tiers add a one-time activation.
 *
 * The prices here are what the app and the buy page SHOW. What Stripe CHARGES is looked up by the
 * lookup keys at checkout (Stripe's own price objects), and checked against these amounts first: if
 * the two ever differ, the buy page refuses rather than charge a price the customer was not shown.
 *
 * Denied to the web by .htaccess; read by servers/ and buy/ through lib.php.
 */

declare(strict_types=1);

if (!defined('ARK_CHECKIN')) {
    http_response_code(404);
    exit;
}

return [
    'small' => [
        'name' => 'Ark Private Server — Small',
        'cpu' => '4 vCPU',
        'memory' => '8 GB RAM',
        'gpu' => null,
        'storage' => '100 GB',
        'modelSize' => '3B',
        'models' => ['Llama 3.2 3B', 'Qwen 2.5 3B'],
        'monthlyCents' => 950,
        'activationCents' => 0,
        'lookupKeys' => ['monthly' => 'private_server_small_monthly'],
    ],
    'medium' => [
        'name' => 'Ark Private Server — Medium',
        'cpu' => '8 vCPU',
        'memory' => '24 GB RAM',
        'gpu' => null,
        'storage' => '300 GB SSD or 150 GB NVMe',
        'modelSize' => '7–8B',
        'models' => ['Llama 3.1 8B', 'Qwen 2.5 7B', 'Mistral 7B'],
        'monthlyCents' => 2350,
        'activationCents' => 0,
        'lookupKeys' => ['monthly' => 'private_server_medium_monthly'],
    ],
    'large' => [
        'name' => 'Ark Private Server — Large',
        'cpu' => '12 vCPU',
        'memory' => '48 GB RAM',
        'gpu' => null,
        'storage' => '400 GB SSD or 200 GB NVMe',
        'modelSize' => '14B',
        'models' => ['Qwen 2.5 14B'],
        'monthlyCents' => 4200,
        'activationCents' => 0,
        'lookupKeys' => ['monthly' => 'private_server_large_monthly'],
    ],
    'gpu_entry' => [
        'name' => 'Ark Private Server — GPU Entry',
        'cpu' => null,
        'memory' => '64 GB RAM',
        'gpu' => '24 GB GPU',
        'storage' => '~1 TB NVMe',
        'modelSize' => '14–32B',
        'models' => [],
        'monthlyCents' => 35700,
        'activationCents' => 34800,
        'lookupKeys' => ['monthly' => 'private_server_gpu_entry_monthly', 'activation' => 'private_server_gpu_entry_activation'],
    ],
    'gpu_high' => [
        'name' => 'Ark Private Server — GPU High',
        'cpu' => null,
        'memory' => '128 GB RAM',
        'gpu' => '96 GB GPU',
        'storage' => '~3.8 TB NVMe',
        'modelSize' => '70B',
        'models' => ['Llama 3.3 70B'],
        'monthlyCents' => 166500,
        'activationCents' => 166500,
        'lookupKeys' => ['monthly' => 'private_server_gpu_high_monthly', 'activation' => 'private_server_gpu_high_activation'],
    ],
];
