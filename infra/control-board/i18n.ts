/**
 * The board in English and Greek. As in the app (app/src/lib/i18n.ts, shared/i18n): the English is
 * the key, and the Greek is polite plural, short on buttons. A word with no Greek here shows in
 * English; `i18n.test.ts` fails when a phrase the pages use has no Greek.
 */
export type Lang = "en" | "el";

export const EL: Record<string, string> = {
  "BlackArk Control Board": "Πίνακας ελέγχου BlackArk",
  Overview: "Επισκόπηση",
  Customers: "Πελάτες",
  Customer: "Πελάτης",
  Cases: "Υποθέσεις",
  Case: "Υπόθεση",
  Services: "Υπηρεσίες",
  Service: "Υπηρεσία",
  "Issues and fixes": "Προβλήματα και διορθώσεις",
  "Audit log": "Αρχείο ενεργειών",
  Accounts: "Λογαριασμοί",
  Account: "Λογαριασμός",
  "Sign out": "Αποσύνδεση",
  "Sign in": "Σύνδεση",
  "User name": "Όνομα χρήστη",
  Password: "Κωδικός",
  "Password again": "Ξανά ο κωδικός",
  "Code from your authenticator app": "Κωδικός από την εφαρμογή επαλήθευσης",
  "Wrong user name, password or code.":
    "Λάθος όνομα χρήστη, κωδικός ή κωδικός επαλήθευσης.",
  "Too many attempts. Try again in 15 minutes.":
    "Πάρα πολλές προσπάθειες. Δοκιμάστε ξανά σε 15 λεπτά.",
  "The form expired. Please try again.": "Η φόρμα έληξε. Δοκιμάστε ξανά.",
  "Your session ended. Please sign in again.":
    "Η σύνδεσή σας έληξε. Συνδεθείτε ξανά.",
  "Set up your account": "Ρύθμιση λογαριασμού",
  "Add this key to your authenticator app (time-based, 6 digits, 30 seconds):":
    "Προσθέστε αυτό το κλειδί στην εφαρμογή επαλήθευσης (με βάση τον χρόνο, 6 ψηφία, 30 δευτερόλεπτα):",
  "Choose a password of at least 12 characters, and type the code your app shows now.":
    "Διαλέξτε κωδικό τουλάχιστον 12 χαρακτήρων και πληκτρολογήστε τον κωδικό που δείχνει τώρα η εφαρμογή σας.",
  "Finish setup": "Ολοκλήρωση ρύθμισης",
  "The password needs at least 12 characters.":
    "Ο κωδικός χρειάζεται τουλάχιστον 12 χαρακτήρες.",
  "The two passwords are not the same.": "Οι δύο κωδικοί δεν είναι ίδιοι.",
  "That code is not right. Check your app's time and try the next code.":
    "Ο κωδικός δεν είναι σωστός. Ελέγξτε την ώρα της εφαρμογής σας και δοκιμάστε τον επόμενο κωδικό.",
  "This setup link is not valid. Ask an admin for a new one.":
    "Αυτός ο σύνδεσμος ρύθμισης δεν ισχύει. Ζητήστε νέο από έναν διαχειριστή.",
  "Setup is done. You can sign in now.":
    "Η ρύθμιση ολοκληρώθηκε. Μπορείτε να συνδεθείτε.",
  "Not allowed": "Δεν επιτρέπεται",
  "Your role does not allow this.": "Ο ρόλος σας δεν το επιτρέπει.",
  "Not found": "Δεν βρέθηκε",
  "There is no such page.": "Δεν υπάρχει τέτοια σελίδα.",
  Owner: "Κάτοχος",
  Admin: "Διαχειριστής",
  Support: "Υποστήριξη",
  "Read-only": "Μόνο ανάγνωση",
  "Could not refresh. Showing data from {time}.":
    "Η ανανέωση απέτυχε. Εμφανίζονται στοιχεία από {time}.",
  "The check-in service could not be reached.":
    "Η υπηρεσία check-in δεν απάντησε.",
  "No check-in data yet.": "Δεν υπάρχουν ακόμη στοιχεία check-in.",
  Installs: "Εγκαταστάσεις",
  Install: "Εγκατάσταση",
  "On trial": "Σε δοκιμή",
  Paid: "Πληρωμένοι",
  "Trial ends within 7 days": "Η δοκιμή λήγει σε 7 ημέρες",
  "Installs silent for 2 days": "Εγκαταστάσεις σιωπηλές 2 ημέρες",
  "Phone balances low": "Χαμηλά υπόλοιπα τηλεφωνίας",
  "Not connected": "Δεν έχει συνδεθεί",
  Up: "Λειτουργεί",
  Down: "Εκτός λειτουργίας",
  Trial: "Δοκιμή",
  "Trial ended": "Η δοκιμή έληξε",
  Low: "Χαμηλό",
  Empty: "Άδειο",
  All: "Όλοι",
  "Ending within 7 days": "Λήγει σε 7 ημέρες",
  "Silent for 2 days": "Σιωπηλοί 2 ημέρες",
  "Phone balance low": "Χαμηλό υπόλοιπο τηλεφωνίας",
  Version: "Έκδοση",
  Plan: "Πρόγραμμα",
  "Days left": "Ημέρες που απομένουν",
  "Phone balance": "Υπόλοιπο τηλεφωνίας",
  "Last seen": "Τελευταία επαφή",
  "First seen": "Πρώτη επαφή",
  "No customers.": "Κανένας πελάτης.",
  "several installs": "πολλές εγκαταστάσεις",
  "{n} silent": "{n} σιωπηλές",
  trial: "δοκιμή",
  paid: "πληρωμένο",
  ended: "έληξε",
  "First check-in from install {id}": "Πρώτο check-in από την εγκατάσταση {id}",
  "Last check-in from install {id}":
    "Τελευταίο check-in από την εγκατάσταση {id}",
  "{n} days left": "απομένουν {n} ημέρες",
  verified: "επαληθευμένο",
  unverified: "χωρίς επαλήθευση",
  "Trial ends on install {id}": "Η δοκιμή λήγει στην εγκατάσταση {id}",
  Licence: "Άδεια",
  active: "ενεργή",
  cancelled: "ακυρώθηκε",
  "{n} seats": "{n} θέσεις",
  "period ends {date}": "η περίοδος λήγει {date}",
  "Phone: 5-hour block credited": "Τηλεφωνία: πιστώθηκε πακέτο 5 ωρών",
  "Phone call": "Κλήση",
  incoming: "εισερχόμενη",
  "put through to a landline": "προώθηση σε σταθερό",
  "put through to a mobile": "προώθηση σε κινητό",
  "{n} min": "{n} λεπτά",
  "written off {amount}": "διαγράφηκαν {amount}",
  Status: "Κατάσταση",
  "Trial employees": "Υπάλληλοι δοκιμής",
  Proof: "Απόδειξη",
  "Check-ins": "Check-in",
  "No check-in data for this customer.":
    "Δεν υπάρχουν στοιχεία check-in για αυτόν τον πελάτη.",
  "Open a case": "Νέα υπόθεση",
  Timeline: "Χρονολόγιο",
  "Nothing yet.": "Τίποτα ακόμη.",
  State: "Κατάσταση",
  Detail: "Λεπτομέρειες",
  "Answered in": "Χρόνος απάντησης",
  "Checked when this page opens, at most once a minute.":
    "Ελέγχεται όταν ανοίγει η σελίδα, το πολύ μία φορά το λεπτό.",
  "Check-in service (blackark.uk)": "Υπηρεσία check-in (blackark.uk)",
  "Phone relay": "Αναμεταδότης τηλεφωνίας",
  GitHub: "GitHub",
  Stripe: "Stripe",
  ok: "εντάξει",
  "not connected": "δεν έχει συνδεθεί",
  unreachable: "δεν απαντά",
  "GitHub is not connected yet. It needs a read-only token, after Amgad's yes.":
    "Το GitHub δεν έχει συνδεθεί ακόμη. Χρειάζεται διακριτικό μόνο για ανάγνωση, μετά το ναι του Amgad.",
  "No label": "Χωρίς ετικέτα",
  Open: "Ανοιχτά",
  Merged: "Συγχωνευμένα",
  Closed: "Κλειστά",
  "No issues.": "Κανένα θέμα.",
  "The chain of entries is intact.": "Η αλυσίδα των εγγραφών είναι ακέραιη.",
  "Entry {n} does not follow from the one before: the log was changed outside the board.":
    "Η εγγραφή {n} δεν ακολουθεί την προηγούμενη: το αρχείο άλλαξε εκτός του πίνακα.",
  When: "Πότε",
  Who: "Ποιος",
  Action: "Ενέργεια",
  On: "Σε",
  Result: "Αποτέλεσμα",
  refused: "απορρίφθηκε",
  Newer: "Νεότερα",
  Older: "Παλαιότερα",
  "Page {n} of {m}": "Σελίδα {n} από {m}",
  "Waiting for setup": "Περιμένει ρύθμιση",
  Active: "Ενεργός",
  Disabled: "Απενεργοποιημένος",
  "Setup link for {name}, valid for 24 hours. It is shown only now: give it to that person yourself, not by email or chat in the clear.":
    "Σύνδεσμος ρύθμισης για {name}, ισχύει 24 ώρες. Εμφανίζεται μόνο τώρα: δώστε τον στο άτομο εσείς, όχι με email ή μήνυμα χωρίς προστασία.",
  Role: "Ρόλος",
  Added: "Προστέθηκε",
  "Reset password and 2FA": "Επαναφορά κωδικού και 2FA",
  Disable: "Απενεργοποίηση",
  "Add an account": "Νέος λογαριασμός",
  "lower-case letters, digits, dot, dash":
    "πεζά γράμματα, ψηφία, τελεία, παύλα",
  "Add and make a setup link": "Προσθήκη και σύνδεσμος ρύθμισης",
  "That user name is not valid.": "Αυτό το όνομα χρήστη δεν είναι έγκυρο.",
  "That user name is taken.": "Αυτό το όνομα χρήστη υπάρχει ήδη.",
  "The last active owner cannot be disabled or reset.":
    "Ο τελευταίος ενεργός κάτοχος δεν μπορεί να απενεργοποιηθεί ή να επαναφερθεί.",
  "No such account.": "Δεν υπάρχει τέτοιος λογαριασμός.",
  Error: "Σφάλμα",
  "Something went wrong. It is in the server log.":
    "Κάτι πήγε στραβά. Έχει καταγραφεί στο αρχείο του διακομιστή.",
  // Milestone 2: support cases.
  "New case": "Νέα υπόθεση",
  Subject: "Θέμα",
  Channel: "Κανάλι",
  Language: "Γλώσσα",
  Priority: "Προτεραιότητα",
  "Assigned to": "Ανατέθηκε σε",
  "Nobody yet": "Σε κανέναν ακόμη",
  "Due by": "Προθεσμία",
  "GitHub issue": "Θέμα GitHub",
  "Internal notes": "Εσωτερικές σημειώσεις",
  "Add a note": "Προσθήκη σημείωσης",
  "Save changes": "Αποθήκευση αλλαγών",
  "Open the case": "Άνοιγμα υπόθεσης",
  "In the app": "Μέσα από την εφαρμογή",
  Email: "Email",
  Phone: "Τηλέφωνο",
  Greek: "Ελληνικά",
  English: "Αγγλικά",
  urgent: "επείγον",
  high: "υψηλή",
  normal: "κανονική",
  low: "χαμηλή",
  new: "νέα",
  open: "ανοιχτή",
  waiting: "σε αναμονή",
  solved: "λύθηκε",
  closed: "κλειστή",
  overdue: "εκπρόθεσμη",
  "No cases.": "Καμία υπόθεση.",
  "Only open": "Μόνο ανοιχτές",
  "Notes are internal: the customer never sees them. Do not paste passwords, keys or a customer's personal data.":
    "Οι σημειώσεις είναι εσωτερικές: ο πελάτης δεν τις βλέπει ποτέ. Μην επικολλάτε κωδικούς, κλειδιά ή προσωπικά δεδομένα πελάτη.",
  "That customer id is not valid.":
    "Αυτό το αναγνωριστικό πελάτη δεν είναι έγκυρο.",
  "Give the case a subject.": "Δώστε θέμα στην υπόθεση.",
  "No notes yet.": "Καμία σημείωση ακόμη.",
  "Linked to GitHub issue #{n}": "Συνδέθηκε με το θέμα GitHub #{n}",
  "Issue number, or empty": "Αριθμός θέματος, ή κενό",
  "Customer id": "Αναγνωριστικό πελάτη",
  Opened: "Άνοιξε",
  "Your role can read cases but not change them.":
    "Ο ρόλος σας μπορεί να διαβάζει υποθέσεις αλλά όχι να τις αλλάζει.",
};

export function t(
  lang: Lang,
  english: string,
  vars?: Record<string, string | number>,
): string {
  let text = lang === "el" ? (EL[english] ?? english) : english;
  if (vars) {
    for (const [name, value] of Object.entries(vars))
      text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

const DATE = {
  en: new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }),
  el: new Intl.DateTimeFormat("el-GR", {
    timeZone: "Europe/Athens",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }),
};

/** A time in Athens, dd/mm/yyyy hh:mm, as the check-in status page shows it. */
export function when(lang: Lang, iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : DATE[lang].format(time).replace(",", "");
}

/** Mils (1/1000 euro) as euros: "EUR 23.40", or "23,40 €" in Greek. */
export function money(lang: Lang, mils: number): string {
  const euros = (mils / 1000).toFixed(2);
  return lang === "el" ? `${euros.replace(".", ",")} €` : `EUR ${euros}`;
}
