<?php
/**
 * The low-balance email, as Amgad approved it (#109 / PR 138, 17 Nov 12:53), one entry per text.
 *
 * LANGUAGE RULE (Amgad): one email, in the customer's country language first, then the English copy
 * below it; GCC countries (AE, SA, QA, KW, BH, OM) get English only. A new language is added here
 * only after Amgad says yes to its text. Until a country has one, its customers get the English
 * text, and the server log says so, so it can be added.
 *
 * {minutes} is the minutes left at the mobile rate (never more than what is left); {link} the top-up
 * page. Denied to the web by .htaccess; read only by lib.php.
 */

declare(strict_types=1);

if (!defined('ARK_CHECKIN')) {
    http_response_code(404);
    exit;
}

return [
    // Which text each country gets. Countries not listed get the English text (Amgad, 17 Nov 13:42),
    // and the server log names the country.
    'countries' => [
        'GR' => 'el',
        'CY' => 'el', // Amgad, 17 Nov 13:42: Cyprus gets the approved Greek text.
        'AE' => 'en', 'SA' => 'en', 'QA' => 'en', 'KW' => 'en', 'BH' => 'en', 'OM' => 'en',
    ],
    'texts' => [
        // Greek first, then English. Approved 17 Nov 12:53.
        'el' => [
            'subject' => 'ArkAgent: απομένει λιγότερο από μία ώρα τηλεφωνίας / less than one hour of phone time left',
            'body' => "Αγαπητέ πελάτη,\n\n"
                . "Στο υπόλοιπο τηλεφωνίας του ArkAgent απομένουν περίπου {minutes} λεπτά. Όταν το υπόλοιπο μηδενιστεί, ο ψηφιακός υπάλληλος σταματά να απαντά στις κλήσεις και οι καλούντες ακούν σήμα κατειλημμένου.\n\n"
                . "Για να συνεχίσει χωρίς διακοπή, προσθέστε 5 ώρες (23,40 € χωρίς ΦΠΑ) εδώ:\n{link}\n\n"
                . "Με εκτίμηση,\nΟμάδα Υποστήριξης\nBlackArk Technologies\n\n"
                . "---\n\n"
                . "Dear customer,\n\n"
                . "Your ArkAgent phone balance has about {minutes} minutes left. When it reaches zero, your digital employee stops answering calls and callers hear a busy tone.\n\n"
                . "To keep it running without a break, add 5 hours (€23.40 excl. VAT) here:\n{link}\n\n"
                . "Best regards,\nSupport Team\nBlackArk Technologies\n",
        ],
        // English only (GCC). Approved 17 Nov 12:53.
        'en' => [
            'subject' => 'ArkAgent: less than one hour of phone time left',
            'body' => "Dear customer,\n\n"
                . "Your ArkAgent phone balance has about {minutes} minutes left. When it reaches zero, your digital employee stops answering calls and callers hear a busy tone.\n\n"
                . "To keep it running without a break, add 5 hours (€23.40 excl. VAT) here:\n{link}\n\n"
                . "Best regards,\nSupport Team\nBlackArk Technologies\n",
        ],
    ],
];
