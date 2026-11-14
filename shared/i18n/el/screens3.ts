/** Screen text found by walking the app in Greek (#108): helpers, button states, counts. */
export const EL_SCREENS3: Record<string, string> = {
  "Replace a new skill": "Αντικατάσταση με νέα δεξιότητα",
  "Create a new skill": "Δημιουργία νέας δεξιότητας",
  "Replace {name}": "Αντικατάσταση του {name}",
  "Create {name}": "Δημιουργία του {name}",
  "Create a new digital employee, again":
    "Δημιουργία νέου ψηφιακού υπαλλήλου, ξανά",
  "Create a new digital employee": "Δημιουργία νέου ψηφιακού υπαλλήλου",
  "Create {called}, again": "Δημιουργία του {called}, ξανά",
  "and {count} more": "και {count} ακόμη",
  "{ref} — no connected server offers this":
    "{ref} — κανένας συνδεδεμένος διακομιστής δεν το προσφέρει",
  "{title} · hidden from your roster": "{title} · κρυφός από τη λίστα σας",
  "{filename} is unavailable.": "Το {filename} δεν είναι διαθέσιμο.",
  "{name} is speaking": "Μιλά: {name}",
  "{label}, didn't work": "{label}, δεν λειτούργησε",
  "{unreadable} earlier messages could not be read and are not shown. The rest of this conversation is complete.":
    "{unreadable} παλαιότερα μηνύματα δεν διαβάστηκαν και δεν εμφανίζονται. Η υπόλοιπη συνομιλία είναι πλήρης.",
  "A gigabyte of storage for a month": "Ένα gigabyte αποθήκευσης για έναν μήνα",
  "A gigabyte sent out": "Ένα gigabyte εξερχόμενων δεδομένων",
  "1 model found.": "Βρέθηκε 1 μοντέλο.",
  "{count} models found.": "Βρέθηκαν {count} μοντέλα.",
  "{label} is required.": "Το πεδίο «{label}» είναι υποχρεωτικό.",
  "Enter {min} or more.": "Εισαγάγετε {min} ή περισσότερο.",
  "Enter {max} or less.": "Εισαγάγετε {max} ή λιγότερο.",
  "{title} table, scroll for more columns":
    "Πίνακας {title}, κάντε κύλιση για περισσότερες στήλες",
  "may be cut": "μπορεί να κοπεί",
  "{count} attachments are staged and a message can carry at most {max}. Remove {extra} to send the rest.":
    "Έχουν προστεθεί {count} συνημμένα, αλλά ένα μήνυμα μπορεί να έχει το πολύ {max}. Αφαιρέστε {extra} για να στείλετε τα υπόλοιπα.",
  "dropped when queued messages were merged into one: a message can carry at most {max} attachments.":
    "αφαιρέθηκε όταν τα μηνύματα σε αναμονή ενώθηκαν σε ένα: ένα μήνυμα μπορεί να έχει το πολύ {max} συνημμένα.",
  "removed along with the queued message it was attached to.":
    "αφαιρέθηκε μαζί με το μήνυμα σε αναμονή στο οποίο ήταν συνημμένο.",
  "was not attached: this conversation can no longer take messages.":
    "δεν επισυνάφθηκε: αυτή η συνομιλία δεν δέχεται πλέον μηνύματα.",
  "was not attached: there is no conversation here yet. Send this message first, then attach to the one it opens.":
    "δεν επισυνάφθηκε: δεν υπάρχει ακόμη συνομιλία εδώ. Στείλτε πρώτα αυτό το μήνυμα και μετά επισυνάψτε στη συνομιλία που θα ανοίξει.",
  "'{name}' is an SVG, which can carry scripts and is not accepted.":
    "Το «{name}» είναι SVG, που μπορεί να περιέχει κώδικα, και δεν γίνεται δεκτό.",
  "'{name}' is an image format that is not supported.":
    "Το «{name}» είναι μορφή εικόνας που δεν υποστηρίζεται.",
  "'{name}' is not a file type this chat accepts.":
    "Το «{name}» δεν είναι τύπος αρχείου που δέχεται αυτή η συνομιλία.",
  "'{name}' is too large for a Word, Excel or PDF attachment (limit {formatBytes}).":
    "Το «{name}» είναι πολύ μεγάλο για συνημμένο Word, Excel ή PDF (όριο {formatBytes}).",
  "'{name}' is too large for an image attachment (limit {formatBytes}).":
    "Το «{name}» είναι πολύ μεγάλο για συνημμένη εικόνα (όριο {formatBytes}).",
  "'{name}' is too large for a text attachment (limit {formatBytes}).":
    "Το «{name}» είναι πολύ μεγάλο για συνημμένο κειμένου (όριο {formatBytes}).",
  "'{name}' is larger than the {formatBytes} limit for an attachment.":
    "Το «{name}» ξεπερνά το όριο των {formatBytes} για συνημμένο.",
  "'{name}' was not added: a message can carry at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments.":
    "Το «{name}» δεν προστέθηκε: ένα μήνυμα μπορεί να έχει το πολύ {MAX_ATTACHMENTS_PER_MESSAGE} συνημμένα.",
  "A check against {title} was made with your key and did not come back clean — that may be the key, and it may be {title2} itself. The account still stands at Composio, so press Re-check to try again, or disconnect it here and connect again with a fresh key.":
    "Ένας έλεγχος στο {title} έγινε με το κλειδί σας και δεν βγήκε καθαρός — μπορεί να φταίει το κλειδί ή το ίδιο το {title2}. Ο λογαριασμός παραμένει στη Composio, οπότε πατήστε Επανέλεγχος για να δοκιμάσετε ξανά ή αποσυνδέστε τον εδώ και συνδέστε τον ξανά με νέο κλειδί.",
  "A command is required.": "Απαιτείται εντολή.",
  "A title is required.": "Απαιτείται τίτλος.",
  "Key ID is required.": "Απαιτείται αναγνωριστικό κλειδιού.",
  "A Google OAuth client, with its client id and secret added by an administrator":
    "Ένας πελάτης Google OAuth, με το αναγνωριστικό και το μυστικό του καταχωρισμένα από διαχειριστή",
  "A Google OAuth client (the same one Google Drive uses works), with the Gmail API turned on and its client id and secret added by an administrator":
    "Ένας πελάτης Google OAuth (κάνει και αυτός του Google Drive), με ενεργοποιημένο το Gmail API και το αναγνωριστικό και το μυστικό του καταχωρισμένα από διαχειριστή",
  "{quiet}, having said nothing at all": "{quiet}, χωρίς να έχει πει τίποτα",
  "{length} of {length2} digital employees":
    "{length} από {length2} ψηφιακούς υπαλλήλους",
  "never signed in": "δεν έχει συνδεθεί ποτέ",
  "cents per hour": "λεπτά ανά ώρα",
  "cents per GB a month": "λεπτά ανά GB τον μήνα",
  "cents per GB": "λεπτά ανά GB",
  "cents per charge": "λεπτά ανά χρέωση",
  "A month that comes to less than this is added to the next month instead of charged.":
    "Ένας μήνας που βγαίνει λιγότερο από αυτό προστίθεται στον επόμενο αντί να χρεωθεί.",
  "{formatRate} an hour, {paymentFeePercent}% payment fee, {marginPercent}% margin.":
    "{formatRate} την ώρα, {paymentFeePercent}% χρέωση πληρωμής, {marginPercent}% περιθώριο.",
  "{value1} hours of running cost us {formatEur}. At these prices it is {formatEur3} charged.":
    "{value1} ώρες εκτέλεσης μάς κόστισαν {formatEur}. Με αυτές τις τιμές χρεώνονται {formatEur3}.",
  "switched on": "ενεργό",
  "not switched on": "ανενεργό",
  "carried to the next month": "μεταφέρθηκε στον επόμενο μήνα",
  "refused, will be tried again": "απορρίφθηκε, θα ξαναδοκιμαστεί",
  "sent, no answer recorded": "στάλθηκε, δεν καταγράφηκε απάντηση",
  "sent, the payment service did not say":
    "στάλθηκε, η υπηρεσία πληρωμών δεν απάντησε",
  "A password box the page labels something else is not covered, the rule matches the label.":
    "Ένα πεδίο κωδικού που η σελίδα ονομάζει αλλιώς δεν καλύπτεται· ο κανόνας ταιριάζει με την ετικέτα.",
  "true, anything not refused above":
    "true, οτιδήποτε δεν απορρίφθηκε παραπάνω",
  "{label} must be valid JSON: {reason}":
    "Το {label} πρέπει να είναι έγκυρο JSON: {reason}",
  "{label} must be a JSON object, not {jsonKind}.":
    "Το {label} πρέπει να είναι αντικείμενο JSON, όχι {jsonKind}.",
  "published, revision {revision}": "δημοσιευμένο, αναθεώρηση {revision}",
  "draft only, no digital employee can draw it":
    "μόνο πρόχειρο, κανένας ψηφιακός υπάλληλος δεν μπορεί να το εμφανίσει",
  "edited since publishing": "έχει αλλάξει από τη δημοσίευση",
  "changes things": "κάνει αλλαγές",
  reads: "διαβάζει",
  "{held} of {total} digital employees":
    "{held} από {total} ψηφιακούς υπαλλήλους",
  "{held} of {total} tools": "{held} από {total} εργαλεία",
  "{appTitle} lists no actions. Refresh its tools to ask again.":
    "Το {appTitle} δεν αναφέρει ενέργειες. Ανανεώστε τα εργαλεία του για να ρωτήσετε ξανά.",
  "{appTitle} offers nothing that only reads.":
    "Το {appTitle} δεν προσφέρει τίποτα που μόνο διαβάζει.",
  "{appTitle} offers nothing that changes anything.":
    "Το {appTitle} δεν προσφέρει τίποτα που κάνει αλλαγές.",
  "{offered} of {granted} tools": "{offered} από {granted} εργαλεία",
  "A person took the wheel": "Ένα άτομο ανέλαβε τον έλεγχο",
  "A person supplied a secret": "Ένα άτομο έδωσε ένα μυστικό",
  "A person pressed stop": "Ένα άτομο πάτησε διακοπή",
  "Asked a person": "Ρώτησε ένα άτομο",
  "A person approved": "Ένα άτομο ενέκρινε",
  "A person declined": "Ένα άτομο απέρριψε",
  "{reassurance} Connecting takes you to Composio and then to the vendor to consent.":
    "{reassurance} Η σύνδεση σας μεταφέρει στη Composio και μετά στον πάροχο για συναίνεση.",
  "no limit": "χωρίς όριο",
  "{activeBots} working now, no limit":
    "{activeBots} σε εργασία τώρα, χωρίς όριο",
  "{activeBots} of {limit} working now":
    "{activeBots} από {limit} σε εργασία τώρα",
  "key saved": "το κλειδί αποθηκεύτηκε",
  "Suspended: {reason}": "Σε αναστολή: {reason}",
  Suspended: "Σε αναστολή",
  "{status} · {count} working now · since {date}":
    "{status} · {count} σε εργασία τώρα · από {date}",
  active: "ενεργός",
  "on trial": "σε δοκιμή",
  "payment overdue": "καθυστέρηση πληρωμής",
  cancelled: "ακυρωμένος",
  unpaid: "απλήρωτος",
  incomplete: "ημιτελής",
  "no plan": "χωρίς πλάνο",
  "last signed in {date}": "τελευταία σύνδεση {date}",
  "{title} needs no account. A digital employee granted these tools can use it as it is.":
    "Το {title} δεν χρειάζεται λογαριασμό. Ένας ψηφιακός υπάλληλος με αυτά τα εργαλεία μπορεί να το χρησιμοποιεί ως έχει.",
  "The most capable choice that runs on a good laptop.":
    "Η πιο ικανή επιλογή που τρέχει σε έναν καλό φορητό υπολογιστή.",
  "Tiny: chat only, and weak at using tools.":
    "Πολύ μικρό: μόνο συνομιλία, και αδύναμο στη χρήση εργαλείων.",
  "Models that run on this computer. Free, private, and no account.":
    "Μοντέλα που τρέχουν σε αυτόν τον υπολογιστή. Δωρεάν, ιδιωτικά και χωρίς λογαριασμό.",
  "Quality and speed depend on your computer. Small models are noticeably weaker at using tools and browsing than the large hosted ones.":
    "Η ποιότητα και η ταχύτητα εξαρτώνται από τον υπολογιστή σας. Τα μικρά μοντέλα είναι αισθητά πιο αδύναμα στη χρήση εργαλείων και στην περιήγηση από τα μεγάλα φιλοξενούμενα.",
  "Models running in LM Studio on this computer.":
    "Μοντέλα που τρέχουν στο LM Studio σε αυτόν τον υπολογιστή.",
  "OpenRouter (free models)": "OpenRouter (δωρεάν μοντέλα)",
  "Many open models at no cost, with a free OpenRouter key.":
    "Πολλά ανοιχτά μοντέλα χωρίς κόστος, με δωρεάν κλειδί OpenRouter.",
  "Free models share a small daily allowance per account, and the free line-up changes.":
    "Τα δωρεάν μοντέλα μοιράζονται ένα μικρό ημερήσιο όριο ανά λογαριασμό, και η δωρεάν επιλογή αλλάζει.",
  "Very fast open models. A free plan with rate limits, with your own key.":
    "Πολύ γρήγορα ανοιχτά μοντέλα. Δωρεάν πλάνο με όρια ρυθμού, με δικό σας κλειδί.",
  "The free plan has per-minute and per-day limits for the whole organisation.":
    "Το δωρεάν πλάνο έχει όρια ανά λεπτό και ανά ημέρα για ολόκληρο τον οργανισμό.",
  "Fast open models with a limited free allowance, with your own key.":
    "Γρήγορα ανοιχτά μοντέλα με περιορισμένο δωρεάν όριο, με δικό σας κλειδί.",
  "Free access is small and its terms change. Check the limits on your account.":
    "Η δωρεάν πρόσβαση είναι μικρή και οι όροι της αλλάζουν. Ελέγξτε τα όρια του λογαριασμού σας.",
  "Anthropic (Claude)": "Anthropic (Claude)",
  "Claude, billed by Anthropic to your own API account.":
    "Claude, με χρέωση από την Anthropic στον δικό σας λογαριασμό API.",
  "Use an API key. A Claude.ai subscription cannot be used here: Anthropic does not allow other apps to sign in with it.":
    "Χρησιμοποιήστε κλειδί API. Μια συνδρομή Claude.ai δεν μπορεί να χρησιμοποιηθεί εδώ: η Anthropic δεν επιτρέπει σε άλλες εφαρμογές να συνδέονται με αυτήν.",
  "OpenAI models, billed by OpenAI to your own API account.":
    "Μοντέλα OpenAI, με χρέωση από την OpenAI στον δικό σας λογαριασμό API.",
  "Google Gemini": "Google Gemini",
  "Gemini, billed by Google to your own API account.":
    "Gemini, με χρέωση από τη Google στον δικό σας λογαριασμό API.",
  "Use a paid key. Google allows only paid Gemini API use for people in the EU, the UK and Switzerland, and its free tier may use prompts to improve its products.":
    "Χρησιμοποιήστε κλειδί επί πληρωμή. Η Google επιτρέπει μόνο χρήση επί πληρωμή του Gemini API σε άτομα στην ΕΕ, στο Ηνωμένο Βασίλειο και στην Ελβετία, και η δωρεάν βαθμίδα της μπορεί να χρησιμοποιεί τα αιτήματα για να βελτιώνει τα προϊόντα της.",
  "Inception · Mercury 3": "Inception · Mercury 3",
  "Mercury 3, a very fast model with a 1M-token context, billed by Inception to your own account.":
    "Mercury 3, ένα πολύ γρήγορο μοντέλο με πλαίσιο 1M tokens, με χρέωση από την Inception στον δικό σας λογαριασμό.",
  "New Inception accounts start with a free allowance of tokens; after that it is billed per token.":
    "Οι νέοι λογαριασμοί Inception ξεκινούν με δωρεάν όριο tokens· μετά χρεώνεται ανά token.",
  "Inception's documentation does not say how it keeps or uses prompts. Check its terms before sending customer data.":
    "Η τεκμηρίωση της Inception δεν λέει πώς κρατά ή χρησιμοποιεί τα αιτήματα. Ελέγξτε τους όρους της πριν στείλετε δεδομένα πελατών.",
  "Grok, billed by xAI to your own API account.":
    "Grok, με χρέωση από την xAI στον δικό σας λογαριασμό API.",
  "Azure OpenAI": "Azure OpenAI",
  "Models in your own Azure subscription.":
    "Μοντέλα στη δική σας συνδρομή Azure.",
  "Planned. Azure needs its own deployment names and API version.":
    "Σχεδιάζεται. Το Azure χρειάζεται δικά του ονόματα ανάπτυξης και έκδοση API.",
  "Another OpenAI-compatible server": "Άλλος διακομιστής συμβατός με OpenAI",
  "The key is optional: a server that needs none is fine, and one that does will refuse requests without it.":
    "Το κλειδί είναι προαιρετικό: ένας διακομιστής που δεν χρειάζεται κλειδί λειτουργεί κανονικά, και ένας που χρειάζεται θα αρνείται τα αιτήματα χωρίς αυτό.",
  "ChatGPT subscription": "Συνδρομή ChatGPT",
  "Use the ChatGPT plan you already pay for.":
    "Χρησιμοποιήστε το πλάνο ChatGPT που ήδη πληρώνετε.",
  "Waiting for OpenAI's approval for paid apps. Use an OpenAI API key for now.":
    "Αναμένεται η έγκριση της OpenAI για εφαρμογές επί πληρωμή. Χρησιμοποιήστε προς το παρόν κλειδί API της OpenAI.",
  "Claude Code (your own installation)": "Claude Code (η δική σας εγκατάσταση)",
  "Run the Claude Code you have installed, signed in with your own plan.":
    "Εκτελέστε το Claude Code που έχετε εγκαταστήσει, συνδεδεμένο με το δικό σας πλάνο.",
  "Planned. It will run your own unmodified Claude Code; Ark will never see your Claude login.":
    "Σχεδιάζεται. Θα εκτελεί το δικό σας, αμετάβλητο Claude Code· το Ark δεν θα δει ποτέ τη σύνδεσή σας στο Claude.",
  "One digital employee, working for you.":
    "Ένας ψηφιακός υπάλληλος που δουλεύει για εσάς.",
  "Ark Team": "Ark Team",
  "Up to 15 digital employees working at the same time.":
    "Έως 15 ψηφιακοί υπάλληλοι που δουλεύουν ταυτόχρονα.",
  "Ark Team Enterprise": "Ark Team Enterprise",
  "Up to 500 digital employees working at the same time.":
    "Έως 500 ψηφιακοί υπάλληλοι που δουλεύουν ταυτόχρονα.",
  "For our own staff. Not sold.": "Για το δικό μας προσωπικό. Δεν πωλείται.",
  "A company's own SAML or OpenID Connect provider, routed by email domain.":
    "Ο δικός πάροχος SAML ή OpenID Connect μιας εταιρείας, με δρομολόγηση ανά τομέα email.",
  Active: "Ενεργό",
  "Show what this deployment has actually been doing, read from its own records rather than from anything you know. Use for 'what have the digital employees been up to' and 'what has been refused'. You choose the report and the period; the figures are read for you and you will not see them.":
    "Δείχνει τι έχει κάνει πραγματικά αυτή η εγκατάσταση, από τα δικά της αρχεία και όχι από όσα ξέρετε. Για το «τι έκαναν οι ψηφιακοί υπάλληλοι» και το «τι απορρίφθηκε». Εσείς επιλέγετε την αναφορά και την περίοδο· οι αριθμοί διαβάζονται για εσάς και δεν θα τους δείτε.",
  "Show one thing and its fields, an order, a person, a ticket. Use instead of describing a record in prose.":
    "Δείχνει ένα πράγμα και τα πεδία του: μια παραγγελία, ένα άτομο, ένα αίτημα. Αντί για περιγραφή μιας εγγραφής σε κείμενο.",
  "Show up to six headline figures, each with an optional movement. Use for a summary somebody reads at a glance.":
    "Δείχνει έως έξι βασικούς αριθμούς, ο καθένας με προαιρετική μεταβολή. Για μια σύνοψη που διαβάζεται με μια ματιά.",
  "Show a list of things and which are done. Reporting only, the person cannot tick these, so do not use it to ask for anything.":
    "Δείχνει μια λίστα πραγμάτων και ποια έχουν γίνει. Μόνο για αναφορά: το άτομο δεν μπορεί να τα τσεκάρει, οπότε δεν χρησιμοποιείται για να ζητηθεί κάτι.",
  "Show a headline, a short explanation and optional supporting points. Use instead of writing several paragraphs of prose.":
    "Δείχνει έναν τίτλο, μια σύντομη εξήγηση και προαιρετικά σημεία τεκμηρίωσης. Αντί για πολλές παραγράφους κειμένου.",
  "Show values as a bar chart. Use when comparing a handful of named things, teams, months, categories. Not for a trend over time, which is showLineChart.":
    "Δείχνει τιμές ως ραβδόγραμμα. Για σύγκριση λίγων ονομασμένων πραγμάτων, ομάδων, μηνών, κατηγοριών. Όχι για τάση στον χρόνο, που είναι το showLineChart.",
  "Show how a whole is divided, as a donut with a legend. Use only when the parts sum to something meaningful, and prefer a bar chart above about six slices.":
    "Δείχνει πώς μοιράζεται ένα σύνολο, ως δακτύλιο με υπόμνημα. Μόνο όταν τα μέρη αθροίζονται σε κάτι με νόημα· πάνω από περίπου έξι κομμάτια προτιμάται ραβδόγραμμα.",
  "Show one or more series over an ordered axis, usually time. Every series must have one value per label.":
    "Δείχνει μία ή περισσότερες σειρές σε έναν διατεταγμένο άξονα, συνήθως τον χρόνο. Κάθε σειρά πρέπει να έχει μία τιμή ανά ετικέτα.",
  "The same as showLineChart with the area under each line filled. Use for volume or accumulation rather than for a rate.":
    "Όπως το showLineChart, με γεμάτη την περιοχή κάτω από κάθε γραμμή. Για όγκο ή συσσώρευση και όχι για ρυθμό.",
  "Show values against their targets as progress bars. Use for 'are we there yet' questions, budget spent against budget, done against planned.":
    "Δείχνει τιμές σε σχέση με τους στόχους τους ως μπάρες προόδου. Για ερωτήσεις «φτάσαμε;», προϋπολογισμό που ξοδεύτηκε σε σχέση με τον προϋπολογισμό, ολοκληρωμένα σε σχέση με τα σχεδιασμένα.",
  "Ask the person to approve or decline something, and WAIT for their answer. Use before doing anything you cannot undo, spending money, sending a message, changing a record. Write everything you want to say BEFORE calling this, and nothing after it: your message ends with the card. You are given their decision and any reason they typed.":
    "Ζητά από το άτομο να εγκρίνει ή να απορρίψει κάτι και ΠΕΡΙΜΕΝΕΙ την απάντησή του. Πριν από οτιδήποτε δεν αναιρείται: δαπάνη, αποστολή μηνύματος, αλλαγή εγγραφής. Ό,τι υπάρχει να ειπωθεί γράφεται ΠΡΙΝ από την κάρτα και τίποτα μετά: το μήνυμα τελειώνει με την κάρτα. Επιστρέφει την απόφαση και όποια αιτιολογία πληκτρολογήθηκε.",
  "Ask the person to pick one of several options, and WAIT for their answer. Use when you cannot sensibly guess which one they meant. Write everything you want to say BEFORE calling this, and nothing after it: your message ends with the card. You are given the id of the option they chose.":
    "Ζητά από το άτομο να διαλέξει μία από πολλές επιλογές και ΠΕΡΙΜΕΝΕΙ την απάντησή του. Όταν δεν μπορεί να μαντευτεί λογικά τι εννοούσε. Ό,τι υπάρχει να ειπωθεί γράφεται ΠΡΙΝ από την κάρτα και τίποτα μετά: το μήνυμα τελειώνει με την κάρτα. Επιστρέφει το αναγνωριστικό της επιλογής.",
  "Ask the person to fill in a short form and WAIT for their answers. Use when several related details are needed together. Provide up to eight labeled text, email, number, select, or textarea fields with unique IDs. Mark required fields and give options for selects. Never request passwords or secrets. The result has status submitted and values keyed by field ID; numbers are returned as numbers and blank optional fields are omitted.":
    "Ζητά από το άτομο να συμπληρώσει μια σύντομη φόρμα και ΠΕΡΙΜΕΝΕΙ τις απαντήσεις του. Όταν χρειάζονται μαζί πολλά σχετικά στοιχεία. Έως οκτώ πεδία με ετικέτα (κείμενο, email, αριθμός, επιλογή ή περιοχή κειμένου) με μοναδικά αναγνωριστικά. Τα υποχρεωτικά πεδία σημειώνονται και οι επιλογές δίνονται. Δεν ζητούνται ποτέ κωδικοί ή μυστικά. Το αποτέλεσμα έχει κατάσταση submitted και τιμές ανά αναγνωριστικό πεδίου· οι αριθμοί επιστρέφονται ως αριθμοί και τα κενά προαιρετικά πεδία παραλείπονται.",
  "Show a quotation with its attribution. Use when the exact words matter, something a person said, or a line from a document you were given.":
    "Δείχνει ένα απόσπασμα με την πηγή του. Όταν μετράνε τα ακριβή λόγια: κάτι που είπε ένα άτομο ή μια γραμμή από ένα έγγραφο που δόθηκε.",
  "Show a sortable table to compare records, plans, or other structured facts. Supply up to eight columns and 100 rows, with exactly one cell per column. Use numbers for quantities so sorting is numeric. Show only data you have; do not invent rows.":
    "Δείχνει έναν πίνακα με ταξινόμηση για σύγκριση εγγραφών, πλάνων ή άλλων δομημένων στοιχείων. Έως οκτώ στήλες και 100 γραμμές, με ακριβώς ένα κελί ανά στήλη. Οι ποσότητες δίνονται ως αριθμοί ώστε η ταξινόμηση να είναι αριθμητική. Μόνο δεδομένα που υπάρχουν· δεν επινοούνται γραμμές.",
  neutral: "ουδέτερο",
  positive: "θετικό",
  caution: "προσοχή",
  negative: "αρνητικό",
  "12 March": "12 Μαρτίου",
  "+12% on last month": "+12% σε σχέση με τον προηγούμενο μήνα",
  "the expense policy": "η πολιτική εξόδων",
  Team: "Ομάδα",
  Focus: "Εστίαση",
  Product: "Προϊόν",
  Design: "Σχεδιασμός",
  Jan: "Ιαν",
  Feb: "Φεβ",
  Mar: "Μαρ",
  Apr: "Απρ",
  May: "Μάι",
  "Bar chart": "Ραβδόγραμμα",
  "A few details to prepare a useful first draft.":
    "Λίγα στοιχεία για ένα χρήσιμο πρώτο προσχέδιο.",
  Exploring: "Διερεύνηση",
  Refund: "Επιστροφή χρημάτων",
  Subscription: "Συνδρομή",
  "vLLM, a company gateway, or any server that speaks the OpenAI API.":
    "vLLM, μια εταιρική πύλη ή οποιοσδήποτε διακομιστής μιλά το OpenAI API.",
  Free: "Δωρεάν",
  "Still waiting for you. The run that asked has ended, so your answer is recorded in Requests; ask again here to have it carried out.":
    "Περιμένει ακόμη εσάς. Η εκτέλεση που το ζήτησε έχει τελειώσει, οπότε η απάντησή σας καταγράφεται στα Αιτήματα· ζητήστε το ξανά εδώ για να εκτελεστεί.",
  "Read message": "Ανάγνωση μηνύματος",
  "Search messages": "Αναζήτηση μηνυμάτων",
  "List recent messages": "Πρόσφατα μηνύματα",
  "Search files": "Αναζήτηση αρχείων",
  "List recent files": "Πρόσφατα αρχεία",
  "Get file metadata": "Στοιχεία αρχείου",
  "Read file content": "Ανάγνωση αρχείου",
  "Outlook read mail": "Ανάγνωση email Outlook",
  "Outlook search mail": "Αναζήτηση email Outlook",
  "Outlook send mail": "Αποστολή email Outlook",
  "Calendar list events": "Συμβάντα ημερολογίου",
  "Teams list chats": "Συνομιλίες Teams",
  "Teams read chat": "Ανάγνωση συνομιλίας Teams",
  "Sharepoint search files": "Αναζήτηση αρχείων SharePoint",
  "Create routine": "Δημιουργία ρουτίνας",
  "Update routine": "Ενημέρωση ρουτίνας",
  "Delete routine": "Διαγραφή ρουτίνας",
  "List routines": "Λίστα ρουτινών",
  "Memory remember": "Απομνημόνευση",
  "Memory forget": "Λήθη ανάμνησης",
};
