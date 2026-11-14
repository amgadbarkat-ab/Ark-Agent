/** The administrator's screens. Code a person types (CEL rules, variable names) stays as written. */
export const EL_ADMIN: Record<string, string> = {
  // Overview
  "Could not load the overview.": "Δεν ήταν δυνατή η φόρτωση της επισκόπησης.",
  "Things only you can settle. Each links to where.":
    "Θέματα που μόνο εσείς μπορείτε να διευθετήσετε. Το καθένα οδηγεί στο σημείο όπου γίνεται.",
  "Needs your attention": "Χρειάζεται την προσοχή σας",
  "Nothing needs you right now.": "Τίποτα δεν σας χρειάζεται αυτή τη στιγμή.",
  "Counts from this moment. Revenue is at list price, before tax.":
    "Αριθμοί αυτής της στιγμής. Τα έσοδα είναι σε τιμή καταλόγου, προ φόρων.",
  "Right now": "Αυτή τη στιγμή",
  "Every account paying now, at the price of its plan.":
    "Κάθε λογαριασμός που πληρώνει τώρα, στην τιμή του προγράμματός του.",
  "Monthly recurring revenue": "Μηνιαία επαναλαμβανόμενα έσοδα",
  "New accounts this week": "Νέοι λογαριασμοί αυτή την εβδομάδα",
  "Working right now": "Εργάζονται αυτή τη στιγμή",
  "Before customers rely on it": "Πριν βασιστούν οι πελάτες σε αυτό",
  "Back to app": "Πίσω στην εφαρμογή",
  Overview: "Επισκόπηση",
  "What needs you, how the service is doing, and the settings that apply to everybody in this deployment. Anything here affects every person and every digital employee, which is what separates it from your own preferences.":
    "Τι σας χρειάζεται, πώς πάει η υπηρεσία, και οι ρυθμίσεις που ισχύουν για όλους σε αυτή την εγκατάσταση. Ό,τι αλλάζει εδώ επηρεάζει κάθε άτομο και κάθε ψηφιακό υπάλληλο — αυτό το ξεχωρίζει από τις προσωπικές σας προτιμήσεις.",
  // Components
  Components: "Στοιχεία",
  "Could not load components.": "Δεν ήταν δυνατή η φόρτωση των στοιχείων.",
  "Nothing here answers to that name.":
    "Δεν υπάρχει τίποτα με αυτό το όνομα εδώ.",
  "No such component": "Δεν υπάρχει τέτοιο στοιχείο",
  "It may have been renamed, or this deployment may no longer ship it.":
    "Μπορεί να έχει μετονομαστεί ή να μην περιλαμβάνεται πια σε αυτή την εγκατάσταση.",
  "Back to components": "Πίσω στα στοιχεία",
  "What this component is for, and which digital employees are allowed to answer with it.":
    "Σε τι χρησιμεύει αυτό το στοιχείο και ποιοι ψηφιακοί υπάλληλοι μπορούν να απαντούν με αυτό.",
  Configuration: "Ρυθμίσεις",
  "Not in this build": "Δεν υπάρχει σε αυτή την έκδοση",
  "Nothing here can draw it, whatever else is set.":
    "Τίποτα εδώ δεν μπορεί να το σχεδιάσει, ό,τι κι αν έχει οριστεί.",
  Published: "Δημοσιευμένο",
  "Available to": "Διαθέσιμο σε",
  "May read": "Μπορεί να διαβάζει",
  Kind: "Είδος",
  "Called as": "Καλείται ως",
  "Last changed": "Τελευταία αλλαγή",
  "What the model reads when deciding to call this. It changes nothing until the component is published.":
    "Τι διαβάζει το μοντέλο όταν αποφασίζει αν θα το καλέσει. Δεν αλλάζει τίποτα μέχρι να δημοσιευτεί το στοιχείο.",
  "Switch a digital employee off and it is never told this component exists, so it cannot ask for it and does not apologise for not having it. Each change takes effect immediately.":
    "Αν απενεργοποιήσετε έναν ψηφιακό υπάλληλο, δεν μαθαίνει ποτέ ότι υπάρχει αυτό το στοιχείο, οπότε ούτε το ζητά ούτε απολογείται που δεν το έχει. Κάθε αλλαγή ισχύει αμέσως.",
  "There are no digital employees yet.":
    "Δεν υπάρχουν ακόμη ψηφιακοί υπάλληλοι.",
  "A separate grant from Available to, and not implied by it: that one decides who may draw this, and this decides what it may go and fetch in order to draw itself. Until one of these is on it shows only what the digital employee passes it, and every read it does make is a row in Audit. Each change takes effect immediately.":
    "Ξεχωριστή άδεια από το «Διαθέσιμο σε» και δεν προκύπτει από αυτό: εκείνο ορίζει ποιος μπορεί να το σχεδιάσει, ενώ αυτό ορίζει τι μπορεί να ανακτήσει για να σχεδιαστεί. Μέχρι να ενεργοποιηθεί κάποιο, δείχνει μόνο ό,τι του δίνει ο ψηφιακός υπάλληλος, και κάθε ανάγνωση καταγράφεται στο Ιστορικό ελέγχου. Κάθε αλλαγή ισχύει αμέσως.",
  "This deployment grants no data functions.":
    "Αυτή η εγκατάσταση δεν παρέχει λειτουργίες δεδομένων.",
  "What each digital employee may answer with. Every published component is available to every digital employee; switch one off here and that digital employee is never told about it. Each change and each refusal is a row in Audit.":
    "Με τι μπορεί να απαντά κάθε ψηφιακός υπάλληλος. Κάθε δημοσιευμένο στοιχείο είναι διαθέσιμο σε όλους· αν το απενεργοποιήσετε εδώ για κάποιον, δεν το μαθαίνει ποτέ. Κάθε αλλαγή και κάθε άρνηση καταγράφεται στο Ιστορικό ελέγχου.",
  "UI Components": "Στοιχεία διεπαφής",
  "No components yet": "Δεν υπάρχουν ακόμη στοιχεία",
  "Components that your Agents can use will be shown here.":
    "Εδώ θα εμφανίζονται τα στοιχεία που μπορούν να χρησιμοποιούν οι ψηφιακοί σας υπάλληλοι.",
  // Computers
  "Each digital employee's browser and the profile it keeps. A profile is what makes a digital employee still signed in tomorrow, and resetting one signs it out of everything.":
    "Ο περιηγητής κάθε ψηφιακού υπαλλήλου και το προφίλ που κρατά. Το προφίλ είναι αυτό που τον κρατά συνδεδεμένο και αύριο· η επαναφορά του τον αποσυνδέει από όλα.",
  Computers: "Υπολογιστές",
  "Every digital employee is sharing one computer.":
    "Όλοι οι ψηφιακοί υπάλληλοι μοιράζονται έναν υπολογιστή.",
  COMPUTER_SUPERVISOR_URL: "COMPUTER_SUPERVISOR_URL",
  "Each digital employee has a computer of its own: its own container, its own files and its own browser profile.":
    "Κάθε ψηφιακός υπάλληλος έχει δικό του υπολογιστή: δικό του κοντέινερ, δικά του αρχεία και δικό του προφίλ περιηγητή.",
  "Computers in this deployment": "Υπολογιστές σε αυτή την εγκατάσταση",
  "The list could not be loaded.": "Δεν ήταν δυνατή η φόρτωση της λίστας.",
  "No computers yet. One appears the first time a digital employee opens a page.":
    "Δεν υπάρχουν ακόμη υπολογιστές. Ένας εμφανίζεται την πρώτη φορά που ένας ψηφιακός υπάλληλος ανοίγει σελίδα.",
  "Its profile is deleted, so the digital employee is signed out of every service it had logged into and starts clean. This cannot be undone.":
    "Το προφίλ του διαγράφεται, οπότε ο ψηφιακός υπάλληλος αποσυνδέεται από κάθε υπηρεσία και ξεκινά από την αρχή. Δεν μπορεί να αναιρεθεί.",
  Audit: "Ιστορικό ελέγχου",
  "Let a digital employee work in your own Chrome or Edge, in a separate ArkAgent profile with none of your saved passwords. Payments, sending, form submissions and deletions wait for your approval, and every action is recorded.":
    "Αφήστε έναν ψηφιακό υπάλληλο να δουλεύει στον δικό σας Chrome ή Edge, σε ξεχωριστό προφίλ ArkAgent χωρίς τους αποθηκευμένους κωδικούς σας. Πληρωμές, αποστολές, υποβολές φορμών και διαγραφές περιμένουν την έγκρισή σας, και κάθε ενέργεια καταγράφεται.",
  "Your own browser": "Ο δικός σας περιηγητής",
  "Let digital employees use my browser":
    "Οι ψηφιακοί υπάλληλοι μπορούν να χρησιμοποιούν τον περιηγητή μου",
  "No digital employees yet.": "Δεν υπάρχουν ακόμη ψηφιακοί υπάλληλοι.",
  "Choose folders a digital employee can read on this computer. The desktop app asks before each edit or command. Access ends when you stop OpenBot.":
    "Επιλέξτε φακέλους που μπορεί να διαβάζει ένας ψηφιακός υπάλληλος σε αυτόν τον υπολογιστή. Η εφαρμογή ρωτά πριν από κάθε αλλαγή ή εντολή. Η πρόσβαση λήγει όταν κλείσετε την εφαρμογή.",
  "Folders on this computer": "Φάκελοι σε αυτόν τον υπολογιστή",
  "The desktop app is offline. Folders can only be approved from the desktop app, and command access stays unavailable while it is offline.":
    "Η εφαρμογή υπολογιστή είναι εκτός σύνδεσης. Οι φάκελοι εγκρίνονται μόνο από την εφαρμογή, και η εκτέλεση εντολών δεν είναι διαθέσιμη όσο είναι εκτός σύνδεσης.",
  "No digital employees yet. Create a digital employee before choosing folders.":
    "Δεν υπάρχουν ακόμη ψηφιακοί υπάλληλοι. Δημιουργήστε έναν πριν επιλέξετε φακέλους.",
  "Grants are read-only by default. Writes are requested from the native desktop prompt when a digital employee needs them.":
    "Οι άδειες είναι αρχικά μόνο για ανάγνωση. Οι εγγραφές ζητούνται από το παράθυρο της εφαρμογής όταν τις χρειάζεται ένας ψηφιακός υπάλληλος.",
  "View audit": "Προβολή ιστορικού ελέγχου",
  // People and accounts
  "Everybody who has signed in. Administrators reach these screens; everybody else talks to digital employees.":
    "Όλοι όσοι έχουν συνδεθεί. Οι διαχειριστές βλέπουν αυτές τις οθόνες· όλοι οι άλλοι συνομιλούν με ψηφιακούς υπαλλήλους.",
  People: "Άτομα",
  "An address named in INITIAL_ADMIN_EMAILS is an administrator whatever this screen says, so it cannot be changed here.":
    "Μια διεύθυνση που αναφέρεται στο INITIAL_ADMIN_EMAILS είναι διαχειριστής ό,τι κι αν λέει αυτή η οθόνη, οπότε δεν αλλάζει από εδώ.",
  "Who is here": "Ποιοι είναι εδώ",
  "Search people": "Αναζήτηση ατόμων",
  "Search by name or address": "Αναζήτηση με όνομα ή διεύθυνση",
  "Could not load people.": "Δεν ήταν δυνατή η φόρτωση των ατόμων.",
  "Erase data": "Διαγραφή δεδομένων",
  Export: "Εξαγωγή",
  "Erase…": "Διαγραφή…",
  "Every customer account: what it has bought, how much is in use, and whether it is allowed to run.":
    "Κάθε λογαριασμός πελάτη: τι έχει αγοράσει, πόσα χρησιμοποιούνται και αν επιτρέπεται να λειτουργεί.",
  Accounts: "Λογαριασμοί",
  "Changing a plan here sets it by hand and does not charge anyone. Suspending stops every digital employee on the account at its next run and shows the customer the reason.":
    "Η αλλαγή προγράμματος εδώ γίνεται χειροκίνητα και δεν χρεώνει κανέναν. Η αναστολή σταματά κάθε ψηφιακό υπάλληλο του λογαριασμού στην επόμενη εκτέλεση και δείχνει στον πελάτη την αιτία.",
  "Who is paying": "Ποιοι πληρώνουν",
  "Search accounts": "Αναζήτηση λογαριασμών",
  "Could not load accounts.": "Δεν ήταν δυνατή η φόρτωση των λογαριασμών.",
  "Why? The customer is shown this.":
    "Γιατί; Ο πελάτης βλέπει αυτό το κείμενο.",
  Restore: "Επαναφορά",
  Suspend: "Αναστολή",
  // Marketplace review
  "Shared digital employees are read here before anyone else can see them, and reported ones are decided here.":
    "Οι κοινοποιημένοι ψηφιακοί υπάλληλοι διαβάζονται εδώ πριν τους δει οποιοσδήποτε άλλος, και εδώ κρίνονται όσοι αναφέρθηκαν.",
  Marketplace: "Αγορά",
  "Oldest first. Look at what a stranger would read: the role, the instruction and the tool names. Reject anything with a secret, private data or somebody else's work, and say why. The publisher is shown the reason.":
    "Τα παλαιότερα πρώτα. Δείτε ό,τι θα διάβαζε ένας άγνωστος: τον ρόλο, την οδηγία και τα ονόματα των εργαλείων. Απορρίψτε ό,τι περιέχει μυστικό, ιδιωτικά δεδομένα ή ξένη δουλειά, και εξηγήστε γιατί. Ο εκδότης βλέπει την αιτία.",
  "Waiting for review": "Αναμονή για έλεγχο",
  "Could not load the review queue.":
    "Δεν ήταν δυνατή η φόρτωση της ουράς ελέγχου.",
  "Nothing is waiting.": "Τίποτα δεν περιμένει.",
  "Taking a listing down settles every report about it. Dismiss a report that is not a problem.":
    "Η αφαίρεση μιας καταχώρισης κλείνει κάθε αναφορά γι’ αυτήν. Απορρίψτε μια αναφορά που δεν αποτελεί πρόβλημα.",
  Reports: "Αναφορές",
  "Could not load the reports.": "Δεν ήταν δυνατή η φόρτωση των αναφορών.",
  "No open reports.": "Δεν υπάρχουν ανοιχτές αναφορές.",
  "Why? The publisher is shown this.":
    "Γιατί; Ο εκδότης βλέπει αυτό το κείμενο.",
  Reject: "Απόρριψη",
  "Read the listing": "Ανάγνωση της καταχώρισης",
  "Take down": "Αφαίρεση",
  Dismiss: "Παράβλεψη",
  // Credentials
  "Add credential": "Προσθήκη διαπιστευτηρίου",
  "Credentials are write-only. ArkAgent never displays their secret values.":
    "Τα διαπιστευτήρια μόνο αποθηκεύονται. Το ArkAgent δεν εμφανίζει ποτέ τις μυστικές τιμές τους.",
  Credentials: "Διαπιστευτήρια",
  "Held for this deployment and never shown again once saved.":
    "Φυλάσσονται για αυτή την εγκατάσταση και δεν εμφανίζονται ξανά μετά την αποθήκευση.",
  Type: "Τύπος",
  Connector: "Σύνδεση",
  Provider: "Πάροχος",
  "Key ID": "Αναγνωριστικό κλειδιού",
  Secret: "Μυστικό",
  "This key already holds a live credential. Saving replaces it, and the one it replaces is revoked.":
    "Αυτό το κλειδί έχει ήδη ενεργό διαπιστευτήριο. Η αποθήκευση το αντικαθιστά και το παλιό ανακαλείται.",
  "Could not save the credential. Try again.":
    "Δεν ήταν δυνατή η αποθήκευση του διαπιστευτηρίου. Δοκιμάστε ξανά.",
  "Configured credentials": "Ρυθμισμένα διαπιστευτήρια",
  "Could not load credentials.":
    "Δεν ήταν δυνατή η φόρτωση των διαπιστευτηρίων.",
  "No credentials are configured.": "Δεν έχουν ρυθμιστεί διαπιστευτήρια.",
  Revoke: "Ανάκληση",
  // Skills (deployment)
  "Write a skill": "Σύνταξη δεξιότητας",
  "Named instructions anybody here can invoke with a slash. A skill adds no capability: it can only ask a digital employee to use what that digital employee already holds, and every one of those calls is still decided and recorded.":
    "Επώνυμες οδηγίες που μπορεί να καλέσει οποιοσδήποτε εδώ με κάθετο (/). Μια δεξιότητα δεν προσθέτει δυνατότητες: μπορεί μόνο να ζητήσει από έναν ψηφιακό υπάλληλο να χρησιμοποιήσει ό,τι ήδη έχει, και κάθε τέτοια κλήση ελέγχεται και καταγράφεται.",
  "Written for the whole deployment. People write their own on their Skills page.":
    "Γραμμένες για όλη την εγκατάσταση. Ο καθένας γράφει τις δικές του στη σελίδα Δεξιότητες.",
  Installed: "Εγκατεστημένες",
  "No skills yet.": "Δεν υπάρχουν ακόμη δεξιότητες.",
  "Write a skill for the deployment": "Σύνταξη δεξιότητας για την εγκατάσταση",
  "The slug is what a person types after a slash, and the instructions are added to the run when they do. Everybody here can use it, and you decide which digital employees have it.":
    "Το σύντομο όνομα (slug) είναι ό,τι πληκτρολογεί κάποιος μετά την κάθετο, και τότε προστίθενται οι οδηγίες. Μπορούν να τη χρησιμοποιούν όλοι εδώ, και εσείς αποφασίζετε ποιοι ψηφιακοί υπάλληλοι την έχουν.",
  Slug: "Σύντομο όνομα (slug)",
  Summary: "Σύνοψη",
  "One line": "Μία γραμμή",
  "What the digital employee should do when this skill is used.":
    "Τι πρέπει να κάνει ο ψηφιακός υπάλληλος όταν χρησιμοποιείται αυτή η δεξιότητα.",
  "Install skill": "Εγκατάσταση δεξιότητας",
  // Cloud costs
  "What running in Ark's cloud costs us, what it is priced at, and what has been charged. Set the prices from measured cost.":
    "Πόσο μας κοστίζει η λειτουργία στο νέφος της Ark, σε ποια τιμή διατίθεται και τι έχει χρεωθεί. Ορίστε τις τιμές με βάση το μετρημένο κόστος.",
  "Cloud costs": "Κόστος νέφους",
  Prices: "Τιμές",
  "Could not load the prices.": "Δεν ήταν δυνατή η φόρτωση των τιμών.",
  "Prices for cloud running": "Τιμές για λειτουργία στο νέφος",
  Usage: "Χρήση",
  Month: "Μήνας",
  "Could not load the usage.": "Δεν ήταν δυνατή η φόρτωση της χρήσης.",
  "Nothing ran in the cloud this month.":
    "Τίποτα δεν λειτούργησε στο νέφος αυτόν τον μήνα.",
  "A month the payment service refused, or that it did not answer for. A refused month is tried again by itself. One that was not answered is never sent again by a machine: look at the payment service's own record, then say what happened.":
    "Μήνας που απέρριψε η υπηρεσία πληρωμών ή για τον οποίο δεν απάντησε. Ένας μήνας που απορρίφθηκε ξαναδοκιμάζεται αυτόματα. Ένας που δεν απαντήθηκε δεν ξαναστέλνεται ποτέ αυτόματα: ελέγξτε το αρχείο της υπηρεσίας πληρωμών και δηλώστε τι συνέβη.",
  "Needs a decision": "Χρειάζεται απόφαση",
  "Could not load the charges.": "Δεν ήταν δυνατή η φόρτωση των χρεώσεων.",
  "Recent months": "Πρόσφατοι μήνες",
  "No months have been charged yet.": "Δεν έχει χρεωθεί ακόμη κανένας μήνας.",
  "Where you saw it": "Πού το είδατε",
  "It was charged": "Χρεώθηκε",
  Waive: "Χαρίζεται",
  "Customers see these exactly, and agree to them before anything is charged. A customer who agreed to earlier prices is asked again. A month is charged at the prices they agreed to, worked out from the time the digital employees ran.":
    "Οι πελάτες βλέπουν ακριβώς αυτές τις τιμές και τις αποδέχονται πριν χρεωθεί οτιδήποτε. Όποιος είχε αποδεχτεί παλαιότερες τιμές ερωτάται ξανά. Κάθε μήνας χρεώνεται με τις τιμές που αποδέχτηκε ο πελάτης, βάσει του χρόνου λειτουργίας των ψηφιακών υπαλλήλων.",
  // Identity providers
  "Add a provider": "Προσθήκη παρόχου",
  "A company's own identity provider, by SAML or OpenID Connect. Somebody types their email address and the domain decides which one they are sent to.":
    "Ο πάροχος ταυτότητας μιας εταιρείας, μέσω SAML ή OpenID Connect. Κάποιος πληκτρολογεί το email του και ο τομέας καθορίζει σε ποιον πάροχο οδηγείται.",
  "Identity providers": "Πάροχοι ταυτότητας",
  "Google, Microsoft and Okta are configured in the environment instead and do not appear here.":
    "Τα Google, Microsoft και Okta ρυθμίζονται στο περιβάλλον της εγκατάστασης και δεν εμφανίζονται εδώ.",
  Registered: "Καταχωρισμένοι",
  "Could not load identity providers.":
    "Δεν ήταν δυνατή η φόρτωση των παρόχων ταυτότητας.",
  "No identity providers are registered. Add one with the metadata your identity team supplied.":
    "Δεν έχουν καταχωριστεί πάροχοι ταυτότητας. Προσθέστε έναν με τα μεταδεδομένα που έδωσε η ομάδα ταυτότητας.",
  "Add an identity provider": "Προσθήκη παρόχου ταυτότητας",
  "Email domain": "Τομέας email",
  "Anybody signing in with an address at this domain is sent here. Separate several with commas.":
    "Όποιος συνδέεται με διεύθυνση αυτού του τομέα οδηγείται εδώ. Χωρίστε πολλούς με κόμμα.",
  Issuer: "Εκδότης",
  "Sign-on URL": "Διεύθυνση σύνδεσης",
  "Metadata XML": "Μεταδεδομένα XML",
  "<EntityDescriptor …>": "<EntityDescriptor …>",
  "The document your identity team supplied. It carries the signing certificate.":
    "Το έγγραφο που έδωσε η ομάδα ταυτότητας. Περιέχει το πιστοποιητικό υπογραφής.",
  "Client ID": "Αναγνωριστικό πελάτη (Client ID)",
  "Client secret": "Μυστικό πελάτη (Client secret)",
  // Boundaries (rules stay in code as written)
  Boundaries: "Όρια",
  "Enforce stops the action. Record it and allow it writes the same row and lets the action through, which is how a rule is tried on real traffic before it starts refusing anybody.":
    "Η «Εφαρμογή» σταματά την ενέργεια. Η «Καταγραφή και άδεια» γράφει την ίδια εγγραφή και αφήνει την ενέργεια να γίνει — έτσι δοκιμάζεται ένας κανόνας σε πραγματική κίνηση πριν αρχίσει να αρνείται.",
  "When a rule matches": "Όταν ταιριάζει ένας κανόνας",
  intent: "intent",
  key: "key",
  command: "command",
  person: "person",
  routine: "routine",
  handoff: "handoff",
  "It may never": "Δεν επιτρέπεται ποτέ",
  "No rules. Every action is allowed and recorded.":
    "Δεν υπάρχουν κανόνες. Κάθε ενέργεια επιτρέπεται και καταγράφεται.",
  "A rule, written in CEL": "Κανόνας, γραμμένος σε CEL",
  'tool.name == "computer_click" && contains(element.name, "submit")':
    'tool.name == "computer_click" && contains(element.name, "submit")',
  "Add rule": "Προσθήκη κανόνα",
  "Checked after the refusals above and before the floor below. A matching action is not done: it waits in the Requests of the person the digital employee is working for, and is carried out exactly as shown only if they approve. If the page has changed by then, nothing is clicked and the employee asks again.":
    "Ελέγχεται μετά τις παραπάνω απαγορεύσεις και πριν από το κατώτατο όριο. Μια ενέργεια που ταιριάζει δεν εκτελείται: περιμένει στα Αιτήματα του ατόμου για το οποίο εργάζεται ο ψηφιακός υπάλληλος και εκτελείται ακριβώς όπως φαίνεται μόνο αν εγκριθεί. Αν η σελίδα έχει αλλάξει στο μεταξύ, δεν γίνεται κλικ και ο υπάλληλος ρωτά ξανά.",
  "Ask a person first": "Ερώτηση σε άνθρωπο πρώτα",
  "No rules. Nothing waits for a person.":
    "Δεν υπάρχουν κανόνες. Τίποτα δεν περιμένει έγκριση.",
  "A rule that asks a person first, written in CEL":
    "Κανόνας που ζητά πρώτα έγκριση, γραμμένος σε CEL",
  'intent == "run_command"': 'intent == "run_command"',
  "The floor, applied to anything the lists above did not catch. It is not a formality: an empty list here permits nothing, so a deployment that clears this refuses every action rather than allowing every action.":
    "Το κατώτατο όριο, για ό,τι δεν κάλυψαν οι παραπάνω λίστες. Δεν είναι τυπικό: μια κενή λίστα εδώ δεν επιτρέπει τίποτα, οπότε μια εγκατάσταση που την αδειάζει αρνείται κάθε ενέργεια αντί να τις επιτρέπει όλες.",
  "Otherwise it may": "Διαφορετικά επιτρέπεται",
  "No recorded computer actions to test against yet. The rule is valid; what it matches will only be known once digital employees have acted.":
    "Δεν υπάρχουν ακόμη καταγεγραμμένες ενέργειες για δοκιμή. Ο κανόνας είναι έγκυρος· τι θα ταιριάξει θα φανεί όταν οι ψηφιακοί υπάλληλοι αρχίσουν να ενεργούν.",
  // Playground
  Playground: "Δοκιμαστικός χώρος",
  "Write a component here and publish it without a deployment. What you edit is a draft; a conversation only ever draws what is published.":
    "Γράψτε ένα στοιχείο εδώ και δημοσιεύστε το χωρίς νέα έκδοση. Ό,τι επεξεργάζεστε είναι πρόχειρο· μια συνομιλία σχεδιάζει μόνο ό,τι έχει δημοσιευτεί.",
  "Save draft": "Αποθήκευση προχείρου",
  Publish: "Δημοσίευση",
  "Refund card": "Κάρτα επιστροφής χρημάτων",
  "What the model is told about it": "Τι μαθαίνει το μοντέλο γι’ αυτό",
  "Show a refund with its amount, reason and status.":
    "Εμφάνισε μια επιστροφή χρημάτων με ποσό, αιτία και κατάσταση.",
  JavaScript: "JavaScript",
  "Arguments (JSON Schema)": "Παράμετροι (JSON Schema)",
  "Sample arguments": "Δείγματα παραμέτρων",
  Preview: "Προεπισκόπηση",
  "Saved here": "Αποθηκευμένα εδώ",
  "Nothing yet.": "Τίποτα ακόμη.",
  "Publishing makes it available to every digital employee. Switch it off for a particular digital employee on the Components page, the same as for a component this build ships.":
    "Η δημοσίευση το κάνει διαθέσιμο σε κάθε ψηφιακό υπάλληλο. Απενεργοποιήστε το για συγκεκριμένο υπάλληλο από τη σελίδα Στοιχεία, όπως και για τα ενσωματωμένα στοιχεία.",
  "It is removed from this deployment. Any digital employee that could draw it no longer can, and this cannot be undone.":
    "Αφαιρείται από αυτή την εγκατάσταση. Κανένας ψηφιακός υπάλληλος δεν μπορεί πια να το σχεδιάσει, και δεν μπορεί να αναιρεθεί.",
  "Delete it": "Διαγραφή",
  // Plugins
  "Composio's own directory. Adding an app makes its tools available to grant; each person still connects their own account before any of them reads anything.":
    "Ο κατάλογος της Composio. Η προσθήκη μιας εφαρμογής κάνει τα εργαλεία της διαθέσιμα για παραχώρηση· κάθε άτομο συνδέει πρώτα τον δικό του λογαριασμό πριν διαβαστεί οτιδήποτε.",
  "Browse Composio": "Περιήγηση στη Composio",
  "Search by name. The directory is too long to read, and nothing here has been reviewed by this deployment.":
    "Αναζήτηση με όνομα. Ο κατάλογος είναι πολύ μεγάλος για ανάγνωση, και τίποτα εδώ δεν έχει ελεγχθεί από αυτή την εγκατάσταση.",
  Apps: "Εφαρμογές",
  "Search Composio apps": "Αναζήτηση εφαρμογών Composio",
  "Search by app name": "Αναζήτηση με όνομα εφαρμογής",
  Added: "Προστέθηκε",
  Tool: "Εργαλείο",
  "This connector does not advertise a tool by that name.":
    "Αυτή η σύνδεση δεν προσφέρει εργαλείο με αυτό το όνομα.",
  "What it does": "Τι κάνει",
  Effect: "Επίδραση",
  "Decided by the connector, not by the tool's name. Anything unrecognised counts as a write.":
    "Το ορίζει η σύνδεση, όχι το όνομα του εργαλείου. Ό,τι δεν αναγνωρίζεται θεωρείται εγγραφή.",
  "When a digital employee calls it": "Όταν το καλεί ένας ψηφιακός υπάλληλος",
  "Use the default": "Χρήση της προεπιλογής",
  "A digital employee may call this tool only while its switch is on. Turning one off takes effect on the next call, with nothing cached in between.":
    "Ένας ψηφιακός υπάλληλος μπορεί να καλεί αυτό το εργαλείο μόνο όσο ο διακόπτης του είναι ενεργός. Η απενεργοποίηση ισχύει από την επόμενη κλήση.",
  Bots: "Ψηφιακοί υπάλληλοι",
  "This deployment has no digital employees yet, so there is nobody to grant this to.":
    "Αυτή η εγκατάσταση δεν έχει ακόμη ψηφιακούς υπαλλήλους, οπότε δεν υπάρχει σε ποιον να δοθεί.",
  "Whether you have connected an account here could not be loaded, so nothing about it is shown rather than something that may be wrong. Reload the page, and check this deployment’s logs if it persists.":
    "Δεν ήταν δυνατό να φορτωθεί αν έχετε συνδέσει λογαριασμό εδώ, οπότε δεν εμφανίζεται τίποτα αντί για κάτι που μπορεί να είναι λάθος. Ανανεώστε τη σελίδα και ελέγξτε τα αρχεία καταγραφής της εγκατάστασης αν συνεχίζεται.",
  Plugin: "Πρόσθετο",
  "This deployment does not have a plugin by that name, and the catalogue does not offer one.":
    "Αυτή η εγκατάσταση δεν έχει πρόσθετο με αυτό το όνομα, και ο κατάλογος δεν προσφέρει κάποιο.",
  "Not a plugin": "Δεν είναι πρόσθετο",
  "Nothing to configure.": "Δεν υπάρχει κάτι να ρυθμιστεί.",
  "Enable for this deployment": "Ενεργοποίηση για αυτή την εγκατάσταση",
  Connection: "Σύνδεση",
  "Nothing to configure. These tools run inside this deployment, on the tables it already owns.":
    "Δεν υπάρχει κάτι να ρυθμιστεί. Αυτά τα εργαλεία λειτουργούν μέσα στην εγκατάσταση, στα δικά της δεδομένα.",
  "Built in": "Ενσωματωμένο",
  "How this is reached": "Πώς γίνεται η πρόσβαση",
  "This app is reached through Composio, which holds the account. This deployment sends one key and the name of whoever is asking, so each person connects their own and a Digital employee sees only what that person can see. There is no token to paste.":
    "Η πρόσβαση γίνεται μέσω Composio, που κρατά τον λογαριασμό. Η εγκατάσταση στέλνει ένα κλειδί και το όνομα αυτού που ρωτά, οπότε ο καθένας συνδέει τον δικό του και ο ψηφιακός υπάλληλος βλέπει μόνο ό,τι βλέπει εκείνος. Δεν χρειάζεται να επικολλήσετε διακριτικό.",
  "Through Composio": "Μέσω Composio",
  "Access token": "Διακριτικό πρόσβασης",
  "Sent as a bearer token on every call to this vendor.":
    "Στέλνεται ως bearer token σε κάθε κλήση προς αυτόν τον πάροχο.",
  "OAuth client": "Πελάτης OAuth",
  "This deployment registers itself with the vendor on first connect. There is nothing to paste.":
    "Η εγκατάσταση εγγράφεται μόνη της στον πάροχο με την πρώτη σύνδεση. Δεν χρειάζεται να επικολλήσετε τίποτα.",
  "Self-registered": "Αυτοεγγραφή",
  "Identifies this deployment to the vendor. It reaches nobody's documents on its own.":
    "Ταυτοποιεί την εγκατάσταση στον πάροχο. Από μόνο του δεν δίνει πρόσβαση στα έγγραφα κανενός.",
  "Instance host": "Διακομιστής παρουσίας",
  "This vendor gives every customer their own hostname, checked against its pattern before anything is stored.":
    "Αυτός ο πάροχος δίνει σε κάθε πελάτη δικό του όνομα διακομιστή, που ελέγχεται πριν αποθηκευτεί οτιδήποτε.",
  "The deployment registers its redirect URI itself, so there is nothing to add at the vendor.":
    "Η εγκατάσταση καταχωρίζει μόνη της τη διεύθυνση επιστροφής, οπότε δεν χρειάζεται να προσθέσετε κάτι στον πάροχο.",
  "Add this to the client's authorised redirect URIs at the vendor, exactly as written. A single wrong character fails there, with a message that does not mention OpenBot.":
    "Προσθέστε αυτό στις εξουσιοδοτημένες διευθύνσεις επιστροφής του πελάτη στον πάροχο, ακριβώς όπως είναι γραμμένο. Ένας λάθος χαρακτήρας προκαλεί αποτυχία εκεί, με μήνυμα που δεν αναφέρει την εφαρμογή.",
  "This deployment has no public URL, so nobody can complete a consent flow. Set OPENBOT_PUBLIC_URL.":
    "Αυτή η εγκατάσταση δεν έχει δημόσια διεύθυνση, οπότε κανείς δεν μπορεί να ολοκληρώσει τη συναίνεση. Ορίστε το OPENBOT_PUBLIC_URL.",
  "Refresh tools": "Ανανέωση εργαλείων",
  "Grant tools…": "Παραχώρηση εργαλείων…",
  "A digital employee is told about a tool only when it holds it. Every call is decided again when it happens, so removing a grant takes effect on the next one.":
    "Ένας ψηφιακός υπάλληλος μαθαίνει για ένα εργαλείο μόνο όταν το έχει. Κάθε κλήση κρίνεται ξανά τη στιγμή που γίνεται, οπότε η αφαίρεση μιας άδειας ισχύει από την επόμενη.",
  Tools: "Εργαλεία",
  "By digital employee": "Ανά ψηφιακό υπάλληλο",
  "Every action this app offers, switched one at a time.":
    "Κάθε ενέργεια που προσφέρει αυτή η εφαρμογή, με ξεχωριστό διακόπτη.",
  "This vendor no longer lists these, so no digital employee is told about them and no model can call one. The grant is still recorded, and the tool would be offered again if the vendor started listing it. Revoke from the digital employee's own page if that is not what you want.":
    "Ο πάροχος δεν τα προσφέρει πια, οπότε κανένας ψηφιακός υπάλληλος δεν τα μαθαίνει και κανένα μοντέλο δεν μπορεί να τα καλέσει. Η άδεια παραμένει καταγεγραμμένη, και το εργαλείο θα ξαναπροσφερθεί αν το διαθέσει ξανά ο πάροχος. Ανακαλέστε την από τη σελίδα του υπαλλήλου αν δεν το θέλετε.",
  "Held but not offered": "Διαθέσιμα αλλά δεν προσφέρονται",
  "Grant tools": "Παραχώρηση εργαλείων",
  "Each grant is its own entry on the audit trail, and a granted write is still checked against the boundaries on every call.":
    "Κάθε παραχώρηση καταγράφεται χωριστά στο ιστορικό ελέγχου, και μια εγγραφή που παραχωρήθηκε ελέγχεται ξανά με τα όρια σε κάθε κλήση.",
  To: "Προς",
  Reads: "Αναγνώσεις",
  "Select all": "Επιλογή όλων",
  "Changes things": "Αλλάζει δεδομένα",
  Bot: "Ψηφιακός υπάλληλος",
  "This deployment has not enabled an app by that name.":
    "Αυτή η εγκατάσταση δεν έχει ενεργοποιήσει εφαρμογή με αυτό το όνομα.",
  "There is nothing here to grant.": "Δεν υπάρχει κάτι για παραχώρηση εδώ.",
  Plugins: "Πρόσθετα",
  "Plugins could not be loaded.": "Δεν ήταν δυνατή η φόρτωση των πρόσθετων.",
  "This deployment has no digital employee by that name, so there is nobody to grant these actions to.":
    "Η εγκατάσταση δεν έχει ψηφιακό υπάλληλο με αυτό το όνομα, οπότε δεν υπάρχει σε ποιον να δοθούν αυτές οι ενέργειες.",
  "Not a digital employee": "Δεν είναι ψηφιακός υπάλληλος",
  "It may have been deleted since this page was opened.":
    "Μπορεί να έχει διαγραφεί από τότε που άνοιξε αυτή η σελίδα.",
  "destroys things": "διαγράφει δεδομένα",
  "Search by action name": "Αναζήτηση με όνομα ενέργειας",
  "These only read. A boundary written about writes does not apply to them.":
    "Αυτά μόνο διαβάζουν. Ένα όριο για εγγραφές δεν τα αφορά.",
  "These change something at the vendor. A boundary written about writes applies to them, and each call is refused when one matches.":
    "Αυτά αλλάζουν κάτι στον πάροχο. Ένα όριο για εγγραφές τα αφορά, και κάθε κλήση απορρίπτεται όταν ταιριάζει.",
  "What this deployment can reach, and which digital employees may reach it. Adding a plugin is account-wide; which digital employees hold its tools is decided on its own page.":
    "Τι μπορεί να προσεγγίσει αυτή η εγκατάσταση και ποιοι ψηφιακοί υπάλληλοι. Η προσθήκη ενός πρόσθετου ισχύει για όλο τον λογαριασμό· ποιοι υπάλληλοι έχουν τα εργαλεία του ορίζεται στη δική του σελίδα.",
  "Added for the whole deployment. Open one to set what it needs and which digital employees hold its tools.":
    "Προστέθηκαν για όλη την εγκατάσταση. Ανοίξτε ένα για να ορίσετε τι χρειάζεται και ποιοι ψηφιακοί υπάλληλοι έχουν τα εργαλεία του.",
  "Nothing connected yet. Everything available is below.":
    "Δεν έχει συνδεθεί τίποτα ακόμη. Όλα τα διαθέσιμα είναι παρακάτω.",
  "Reviewed, first-party servers this build will talk to. Open one to add it.":
    "Ελεγμένοι διακομιστές με τους οποίους επικοινωνεί αυτή η έκδοση. Ανοίξτε έναν για να τον προσθέσετε.",
  "Explore plugins": "Εξερεύνηση πρόσθετων",
  "Everything in the catalogue is connected.":
    "Όλα τα στοιχεία του καταλόγου είναι συνδεδεμένα.",
  "Not added": "Δεν έχει προστεθεί",
  "A directory this deployment has not reviewed, reached through Composio.":
    "Κατάλογος που δεν έχει ελέγξει αυτή η εγκατάσταση, μέσω Composio.",
  "More apps": "Περισσότερες εφαρμογές",
  "A few hundred apps, reached as whoever is asking. Each person connects their own account.":
    "Μερικές εκατοντάδες εφαρμογές, με πρόσβαση ως αυτός που ρωτά. Ο καθένας συνδέει τον δικό του λογαριασμό.",
  "Add your Composio key to enable a catalogue of tools. Set COMPOSIO_API_KEY on this deployment.":
    "Προσθέστε το κλειδί Composio για να ενεργοποιηθεί ένας κατάλογος εργαλείων. Ορίστε το COMPOSIO_API_KEY σε αυτή την εγκατάσταση.",
  // Audit
  "Every action a digital employee took, and every one this deployment's policy refused.":
    "Κάθε ενέργεια ψηφιακού υπαλλήλου, και κάθε ενέργεια που απέρριψε η πολιτική της εγκατάστασης.",
  "The audit trail could not be loaded.":
    "Δεν ήταν δυνατή η φόρτωση του ιστορικού ελέγχου.",
  "No events match this filter yet.":
    "Κανένα συμβάν δεν ταιριάζει ακόμη με αυτό το φίλτρο.",
  When: "Πότε",
  What: "Τι",
  "Started by": "Ξεκίνησε από",
  Decision: "Απόφαση",
  "A routine": "Μια ρουτίνα",
  "This deployment": "Αυτή η εγκατάσταση",
  "A person": "Ένα άτομο",
  ", reported by the digital employee itself":
    ", όπως ανέφερε ο ίδιος ο ψηφιακός υπάλληλος",
  "dry-run: recorded, not enforced": "δοκιμή: καταγράφηκε, δεν εφαρμόστηκε",
};
