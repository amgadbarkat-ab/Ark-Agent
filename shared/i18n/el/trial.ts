/**
 * The customer trial (#109, v0.1.37): Settings, then Plan; Admin, then Trials; the block on making
 * employees; and every sentence the server says about a trial profile or an unlock code.
 */
export const EL_TRIAL: Record<string, string> = {
  // The block, on every create path and on the buttons.
  "During the trial you cannot create extra digital employees. The trial employees are already set up.":
    "Κατά τη δοκιμή δεν μπορείτε να δημιουργήσετε επιπλέον ψηφιακούς υπαλλήλους. Οι υπάλληλοι της δοκιμής έχουν ήδη οριστεί.",

  // Day 31: the end of the trial.
  "Your {days}-day trial ended on {date}. Your conversations and settings are kept. Enter an unlock code in Settings, then Plan, to continue.":
    "Η δοκιμή {days} ημερών έληξε στις {date}. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται. Για να συνεχίσετε, εισαγάγετε κωδικό ξεκλειδώματος στις Ρυθμίσεις, στο Πρόγραμμα.",
  "The trial has ended. Your conversations and settings are kept. Enter an unlock code to continue.":
    "Η δοκιμή έληξε. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται. Για να συνεχίσετε, εισαγάγετε κωδικό ξεκλειδώματος.",

  // Settings, then Plan.
  Trial: "Δοκιμή",
  "Trial for {customer}, set by BlackArk.":
    "Δοκιμή για {customer}, όπως την όρισε η BlackArk.",
  "If BlackArk sent you a trial profile (a file ending in .arktrial), import it here.":
    "Αν η BlackArk σάς έστειλε προφίλ δοκιμής (αρχείο που τελειώνει σε .arktrial), εισαγάγετέ το εδώ.",
  "{start} to {end}, {days} days": "{start} έως {end}, {days} ημέρες",
  "Converted to paid. No end date, and no limit on new employees.":
    "Έγινε πληρωμένο πρόγραμμα. Χωρίς ημερομηνία λήξης και χωρίς όριο σε νέους υπαλλήλους.",
  "1 day left.": "Απομένει 1 ημέρα.",
  "{days} days left.": "Απομένουν {days} ημέρες.",
  "{count} trial employees are set up; no others can be created.":
    "Έχουν οριστεί {count} υπάλληλοι δοκιμής· δεν μπορούν να δημιουργηθούν άλλοι.",
  "Daily check-in": "Ημερήσιος έλεγχος",
  "Once a day this computer tells {host} the trial status and the days left. Nothing about your conversations or files is sent.":
    "Μία φορά την ημέρα αυτός ο υπολογιστής ενημερώνει το {host} για την κατάσταση της δοκιμής και τις ημέρες που απομένουν. Δεν αποστέλλεται τίποτα από τις συνομιλίες ή τα αρχεία σας.",
  "The last check-in did not go through.":
    "Ο τελευταίος έλεγχος δεν ολοκληρώθηκε.",
  "Last check-in: {when}.": "Τελευταίος έλεγχος: {when}.",
  "Unlock code": "Κωδικός ξεκλειδώματος",
  "From BlackArk, to extend the trial, end it, or turn it into a paid plan. Each code works once.":
    "Από την BlackArk, για παράταση της δοκιμής, λήξη της ή μετατροπή της σε πληρωμένο πρόγραμμα. Κάθε κωδικός ισχύει μία φορά.",
  "Checking…": "Έλεγχος…",
  "Use code": "Χρήση κωδικού",
  "Done. The trial is now a paid plan.":
    "Έγινε. Η δοκιμή είναι πλέον πληρωμένο πρόγραμμα.",
  "Done. The trial has ended.": "Έγινε. Η δοκιμή έληξε.",
  "Done. The trial now ends on {end}.":
    "Έγινε. Η δοκιμή λήγει πλέον στις {end}.",
  "Import trial profile": "Εισαγωγή προφίλ δοκιμής",
  "Only a newer profile for {customer} can replace this one.":
    "Μόνο νεότερο προφίλ για {customer} μπορεί να αντικαταστήσει αυτό.",
  "The trial employees are set up as soon as it is imported.":
    "Οι υπάλληλοι της δοκιμής ορίζονται μόλις εισαχθεί.",
  "Imported. The trial employees are on your Digital Team.":
    "Εισήχθη. Οι υπάλληλοι της δοκιμής είναι στην Ψηφιακή Ομάδα σας.",
  "This profile was already imported. Nothing changed.":
    "Αυτό το προφίλ έχει ήδη εισαχθεί. Δεν άλλαξε τίποτα.",
  "Importing…": "Εισαγωγή…",
  "Choose file": "Επιλογή αρχείου",

  // Admin, then Trials (BlackArk's own server).
  Trials: "Δοκιμές",
  "Customer trials that report to this server: status and days left for each install.":
    "Δοκιμές πελατών που αναφέρονται σε αυτόν τον διακομιστή: κατάσταση και ημέρες που απομένουν για κάθε εγκατάσταση.",
  "Each install of a customer trial reports its status and days left once a day. Nothing else is sent.":
    "Κάθε εγκατάσταση δοκιμής πελάτη αναφέρει μία φορά την ημέρα την κατάστασή της και τις ημέρες που απομένουν. Τίποτε άλλο δεν αποστέλλεται.",
  Installs: "Εγκαταστάσεις",
  "This server does not receive trial check-ins.":
    "Αυτός ο διακομιστής δεν λαμβάνει ελέγχους δοκιμών.",
  "No install has checked in yet.":
    "Καμία εγκατάσταση δεν έχει αναφερθεί ακόμη.",
  "{days} days left · version {version} · last check-in {when}":
    "απομένουν {days} ημέρες · έκδοση {version} · τελευταίος έλεγχος {when}",
  ended: "έληξε",
  paid: "πληρωμένο",

  // The setup window, before ArkAgent opens.
  "Trial profile ready. It is imported when ArkAgent opens.":
    "Το προφίλ δοκιμής είναι έτοιμο. Θα εισαχθεί όταν ανοίξει το ArkAgent.",
  "ArkAgent could not keep the trial profile on this computer.":
    "Το ArkAgent δεν μπόρεσε να κρατήσει το προφίλ δοκιμής σε αυτόν τον υπολογιστή.",
  "The trial profile was not accepted.": "Το προφίλ δοκιμής δεν έγινε δεκτό.",

  // What the server says about a profile or a code.
  "This version of ArkAgent has no BlackArk key yet, so it cannot check a trial profile or code. Ask BlackArk for the current version.":
    "Αυτή η έκδοση του ArkAgent δεν έχει ακόμη κλειδί της BlackArk και δεν μπορεί να ελέγξει προφίλ ή κωδικό δοκιμής. Ζητήστε από την BlackArk την τρέχουσα έκδοση.",
  "This trial profile is not signed by BlackArk.":
    "Αυτό το προφίλ δοκιμής δεν έχει υπογραφεί από την BlackArk.",
  "This unlock code is not signed by BlackArk.":
    "Αυτός ο κωδικός ξεκλειδώματος δεν έχει υπογραφεί από την BlackArk.",
  "This computer already has the trial for {name}. A profile for another customer cannot replace it.":
    "Αυτός ο υπολογιστής έχει ήδη τη δοκιμή για {name}. Προφίλ άλλου πελάτη δεν μπορεί να την αντικαταστήσει.",
  "This trial profile is older than the one already imported.":
    "Αυτό το προφίλ δοκιμής είναι παλαιότερο από αυτό που έχει ήδη εισαχθεί.",
  "This is not an unlock code. Check that it was copied whole.":
    "Αυτός δεν είναι κωδικός ξεκλειδώματος. Ελέγξτε ότι αντιγράφηκε ολόκληρος.",
  "There is no trial on this computer to unlock.":
    "Δεν υπάρχει δοκιμή σε αυτόν τον υπολογιστή για ξεκλείδωμα.",
  "This unlock code is for another customer.":
    "Αυτός ο κωδικός ξεκλειδώματος είναι για άλλον πελάτη.",
  "This trial is already converted to paid.":
    "Αυτή η δοκιμή έχει ήδη γίνει πληρωμένο πρόγραμμα.",
  "This unlock code was already used.":
    "Αυτός ο κωδικός ξεκλειδώματος έχει ήδη χρησιμοποιηθεί.",
  "Choose a trial profile file.": "Επιλέξτε αρχείο προφίλ δοκιμής.",
  "Enter the unlock code.": "Εισαγάγετε τον κωδικό ξεκλειδώματος.",
  "This file is not a trial profile.":
    "Αυτό το αρχείο δεν είναι προφίλ δοκιμής.",
  "This is not a trial profile.": "Αυτό δεν είναι προφίλ δοκιμής.",
  "This trial profile is for a different version of ArkAgent.":
    "Αυτό το προφίλ δοκιμής είναι για άλλη έκδοση του ArkAgent.",
  "The trial profile ends before it starts.":
    "Το προφίλ δοκιμής λήγει πριν ξεκινήσει.",
  "The trial profile names an unknown plan.":
    "Το προφίλ δοκιμής αναφέρει άγνωστο πρόγραμμα.",
  "Could not load the trial": "Δεν ήταν δυνατή η φόρτωση της δοκιμής",
  "Could not load the trials": "Δεν ήταν δυνατή η φόρτωση των δοκιμών",
  "Could not import the trial profile":
    "Δεν ήταν δυνατή η εισαγωγή του προφίλ δοκιμής",
  "Could not use the unlock code":
    "Δεν ήταν δυνατή η χρήση του κωδικού ξεκλειδώματος",

  // Settings, then Models: the trial demos' model choices (#109, 14 Nov).
  "Large models need a large computer: Qwen3.8-Flash-Next, for example, needs 64 GB of memory or more and about 62 GB of disk.":
    "Τα μεγάλα μοντέλα χρειάζονται μεγάλο υπολογιστή: το Qwen3.8-Flash-Next, για παράδειγμα, χρειάζεται 64 GB μνήμης ή περισσότερα και περίπου 62 GB δίσκου.",
  "Edge0-145B running in Edge0's own engine on this computer or your network.":
    "Το Edge0-145B, στη δική του μηχανή Edge0, σε αυτόν τον υπολογιστή ή στο δίκτυό σας.",
  "Needs an NVIDIA graphics card with CUDA 13 and 16–24 GB of graphics memory plus about 20 GB of memory, or an Apple Silicon Mac, and about 50 GB of disk. A 16 GB office PC cannot run it.":
    "Χρειάζεται κάρτα γραφικών NVIDIA με CUDA 13 και 16–24 GB μνήμης γραφικών και περίπου 20 GB μνήμης, ή Mac με Apple Silicon, και περίπου 50 GB δίσκου. Ένας υπολογιστής γραφείου με 16 GB δεν μπορεί να το τρέξει.",
  "Install and start edge0-infer first, then enter the address it shows (ending in /v1).":
    "Εγκαταστήστε και ξεκινήστε πρώτα το edge0-infer και μετά εισαγάγετε τη διεύθυνση που δείχνει (τελειώνει σε /v1).",
  "Edge0 and Qwen licences apply; check them before using it for a business.":
    "Ισχύουν οι άδειες των Edge0 και Qwen· ελέγξτε τις πριν το χρησιμοποιήσετε σε επιχείρηση.",
  "DeepSeek's hosted models, with your own paid key.":
    "Τα φιλοξενούμενα μοντέλα της DeepSeek, με δικό σας πληρωμένο κλειδί.",
  "Your conversations are sent to DeepSeek's servers. Do not use it for health or other sensitive data without the customer's written agreement.":
    "Οι συνομιλίες σας αποστέλλονται στους διακομιστές της DeepSeek. Μην το χρησιμοποιείτε για δεδομένα υγείας ή άλλα ευαίσθητα δεδομένα χωρίς τη γραπτή συμφωνία του πελάτη.",

  // Settings, then Connect your Data: the Mailbox (#109).
  "Mailbox (IMAP/SMTP)": "Γραμματοκιβώτιο (IMAP/SMTP)",
  "Connected as {account}.": "Συνδεδεμένο ως {account}.",
  "Your own mailbox at Zoho Mail, cPanel hosting or any provider with IMAP and SMTP.":
    "Το δικό σας γραμματοκιβώτιο στο Zoho Mail, σε φιλοξενία cPanel ή σε οποιονδήποτε πάροχο με IMAP και SMTP.",
  "Digital employees can read, search and draft. Every email they want to send, and every draft they want to save, waits for your approval. They cannot forward, delete or move mail.":
    "Οι ψηφιακοί υπάλληλοι μπορούν να διαβάζουν, να αναζητούν και να συντάσσουν. Κάθε email που θέλουν να στείλουν και κάθε πρόχειρο που θέλουν να αποθηκεύσουν περιμένει την έγκρισή σας. Δεν μπορούν να προωθήσουν, να διαγράψουν ή να μετακινήσουν μηνύματα.",
  "Zoho Mail": "Zoho Mail",
  "cPanel hosting": "Φιλοξενία cPanel",
  "Incoming server (IMAP)": "Διακομιστής εισερχομένων (IMAP)",
  "IMAP port": "Θύρα IMAP",
  "Outgoing server (SMTP)": "Διακομιστής εξερχομένων (SMTP)",
  "SMTP port": "Θύρα SMTP",
  "User name (usually the email address)":
    "Όνομα χρήστη (συνήθως η διεύθυνση email)",
  "Password or app password": "Κωδικός ή κωδικός εφαρμογής",
  "Send as (optional)": "Αποστολή ως (προαιρετικό)",
  "Connect mailbox": "Σύνδεση γραμματοκιβωτίου",
  "The login is tried first, and kept only if it works: encrypted, on this computer. With Zoho two-step sign-in, use an app password and switch IMAP on in Zoho's settings.":
    "Η σύνδεση δοκιμάζεται πρώτα και κρατιέται μόνο αν λειτουργεί: κρυπτογραφημένη, σε αυτόν τον υπολογιστή. Με τη σύνδεση δύο βημάτων του Zoho, χρησιμοποιήστε κωδικό εφαρμογής και ενεργοποιήστε το IMAP στις ρυθμίσεις του Zoho.",
  "Your own mailbox at any provider that offers IMAP and SMTP, such as Zoho Mail or cPanel hosting.":
    "Το δικό σας γραμματοκιβώτιο σε οποιονδήποτε πάροχο προσφέρει IMAP και SMTP, όπως το Zoho Mail ή η φιλοξενία cPanel.",

  // What the mailbox server says.
  "Fill in the incoming and outgoing server, their ports, the user name and the password.":
    "Συμπληρώστε τον διακομιστή εισερχομένων και εξερχομένων, τις θύρες τους, το όνομα χρήστη και τον κωδικό.",
  "The Mailbox connector is not added to this deployment. An administrator has to add it first.":
    "Η σύνδεση Γραμματοκιβωτίου δεν έχει προστεθεί σε αυτή την εγκατάσταση. Πρέπει πρώτα να την προσθέσει ένας διαχειριστής.",
  "That server name points at this computer, not a mail server.":
    "Αυτό το όνομα διακομιστή δείχνει σε αυτόν τον υπολογιστή, όχι σε διακομιστή αλληλογραφίας.",
  "The mail server refused the user name or password (IMAP). For Zoho with two-step sign-in, use an app password.":
    "Ο διακομιστής αλληλογραφίας απέρριψε το όνομα χρήστη ή τον κωδικό (IMAP). Για Zoho με σύνδεση δύο βημάτων, χρησιμοποιήστε κωδικό εφαρμογής.",
  "The incoming mail server (IMAP) could not be reached. Check the server name and port.":
    "Δεν ήταν δυνατή η σύνδεση με τον διακομιστή εισερχομένων (IMAP). Ελέγξτε το όνομα διακομιστή και τη θύρα.",
  "The mail server refused the user name or password for sending (SMTP).":
    "Ο διακομιστής αλληλογραφίας απέρριψε το όνομα χρήστη ή τον κωδικό για αποστολή (SMTP).",
  "The outgoing mail server (SMTP) could not be reached. Check the server name and port.":
    "Δεν ήταν δυνατή η σύνδεση με τον διακομιστή εξερχομένων (SMTP). Ελέγξτε το όνομα διακομιστή και τη θύρα.",
  "The mailbox could not be connected":
    "Δεν ήταν δυνατή η σύνδεση του γραμματοκιβωτίου",
  "The mailbox could not be disconnected":
    "Δεν ήταν δυνατή η αποσύνδεση του γραμματοκιβωτίου",

  // Read-only instructions for the trial's own employees, and "Propose a change" (#116).
  "This digital employee's role and standing instruction come from BlackArk's signed trial profile, so they cannot be changed on this computer. Use Propose a change to send BlackArk the new text.":
    "Ο ρόλος και οι μόνιμες οδηγίες αυτού του ψηφιακού υπαλλήλου προέρχονται από το υπογεγραμμένο προφίλ δοκιμής της BlackArk, γι' αυτό δεν αλλάζουν σε αυτόν τον υπολογιστή. Πατήστε «Πρόταση αλλαγής» για να στείλετε στην BlackArk το νέο κείμενο.",
  "Set by BlackArk in the signed trial profile, so it cannot be edited here. It changes only when BlackArk sends a new profile.":
    "Ορίζονται από την BlackArk στο υπογεγραμμένο προφίλ δοκιμής, γι' αυτό δεν αλλάζουν εδώ. Αλλάζουν μόνο όταν η BlackArk στείλει νέο προφίλ.",
  "Propose a change": "Πρόταση αλλαγής",
  "For {name}. Write the instruction you want instead and say why. This makes a file to send to BlackArk; nothing on this computer changes until BlackArk sends a new signed trial profile.":
    "Για τον ψηφιακό υπάλληλο {name}. Γράψτε τις οδηγίες που θέλετε στη θέση τους και εξηγήστε γιατί. Δημιουργείται ένα αρχείο για να το στείλετε στην BlackArk· τίποτα δεν αλλάζει σε αυτόν τον υπολογιστή μέχρι η BlackArk να στείλει νέο υπογεγραμμένο προφίλ δοκιμής.",
  "Current instruction": "Τρέχουσες οδηγίες",
  "Proposed instruction": "Προτεινόμενες οδηγίες",
  Why: "Γιατί",
  "BlackArk reads this when it tests the change. The file holds only this employee's name, its instruction, your text and this reason: no conversations, mail or files.":
    "Η BlackArk το διαβάζει όταν δοκιμάζει την αλλαγή. Το αρχείο περιέχει μόνο το όνομα αυτού του υπαλλήλου, τις οδηγίες του, το κείμενό σας και αυτή την αιτιολογία: καμία συνομιλία, κανένα email, κανένα αρχείο.",
  "Download the file": "Λήψη του αρχείου",
  "Could not make the file.": "Δεν ήταν δυνατή η δημιουργία του αρχείου.",
  "Could not copy. Download the file instead.":
    "Δεν ήταν δυνατή η αντιγραφή. Κατεβάστε το αρχείο.",
  "The file is ready": "Το αρχείο είναι έτοιμο",
  "Send it to BlackArk. Nothing on this computer has changed: the new instruction arrives with a new signed trial profile, once BlackArk has tested it.":
    "Στείλτε το στην BlackArk. Τίποτα δεν άλλαξε σε αυτόν τον υπολογιστή: οι νέες οδηγίες έρχονται με νέο υπογεγραμμένο προφίλ δοκιμής, αφού τις δοκιμάσει η BlackArk.",
  // What the proposal file's reader says (shared/instruction-proposal.ts).
  "This is not a proposed change.": "Αυτό δεν είναι πρόταση αλλαγής.",
  "This file is not a proposed change.":
    "Αυτό το αρχείο δεν είναι πρόταση αλλαγής.",
  "This proposed change is for a different version of ArkAgent.":
    "Αυτή η πρόταση αλλαγής είναι για άλλη έκδοση του ArkAgent.",
  "The proposed change does not say which employee it is for.":
    "Η πρόταση αλλαγής δεν λέει για ποιον υπάλληλο είναι.",
  "The proposed change's employee key is not valid.":
    "Το κλειδί υπαλλήλου της πρότασης αλλαγής δεν είναι έγκυρο.",
  "The proposed change does not name the employee.":
    "Η πρόταση αλλαγής δεν αναφέρει το όνομα του υπαλλήλου.",
  "The employee's name is too long.":
    "Το όνομα του υπαλλήλου είναι πολύ μεγάλο.",
  "The proposed change has no current instruction.":
    "Η πρόταση αλλαγής δεν έχει τις τρέχουσες οδηγίες.",
  "The current instruction is too long.":
    "Οι τρέχουσες οδηγίες είναι πολύ μεγάλες.",
  "Write the new instruction.": "Γράψτε τις νέες οδηγίες.",
  "The new instruction can be 20000 characters at most.":
    "Οι νέες οδηγίες μπορούν να έχουν έως 20000 χαρακτήρες.",
  "The new instruction is the same as the current one.":
    "Οι νέες οδηγίες είναι ίδιες με τις τρέχουσες.",
  "Say why the instruction should change.":
    "Εξηγήστε γιατί πρέπει να αλλάξουν οι οδηγίες.",
  "The reason can be 2000 characters at most.":
    "Η αιτιολογία μπορεί να έχει έως 2000 χαρακτήρες.",
  "The proposed change has no date.": "Η πρόταση αλλαγής δεν έχει ημερομηνία.",
  "The proposed change's date is not valid.":
    "Η ημερομηνία της πρότασης αλλαγής δεν είναι έγκυρη.",
  "The proposed change does not say which version of ArkAgent made it.":
    "Η πρόταση αλλαγής δεν λέει ποια έκδοση του ArkAgent τη δημιούργησε.",
  "The proposed change's version is not valid.":
    "Η έκδοση της πρότασης αλλαγής δεν είναι έγκυρη.",
};
