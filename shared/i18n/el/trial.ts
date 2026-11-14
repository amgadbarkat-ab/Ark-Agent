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
};
