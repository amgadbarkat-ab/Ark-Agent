/**
 * Activation (#109, v0.1.42): the Activate screen, Settings, then Plan, and every sentence the server
 * says about a trial activation code or a licence key.
 */
export const EL_ACTIVATION: Record<string, string> = {
  // The Activate screen and the one box.
  "Activate ArkAgent": "Ενεργοποίηση ArkAgent",
  Activate: "Ενεργοποίηση",
  Activation: "Ενεργοποίηση",
  "To use ArkAgent, enter your trial activation code or the licence key you received after paying.":
    "Για να χρησιμοποιήσετε το ArkAgent, εισαγάγετε τον κωδικό ενεργοποίησης δοκιμής ή το κλειδί άδειας που λάβατε μετά την πληρωμή.",
  "Trial activation code or licence key":
    "Κωδικός ενεργοποίησης δοκιμής ή κλειδί άδειας",
  "BlackArk gives you a trial activation code for a trial. After you pay, your licence key arrives by email; renewals come in by themselves.":
    "Για τη δοκιμή, η BlackArk σάς δίνει κωδικό ενεργοποίησης δοκιμής. Μετά την πληρωμή, το κλειδί άδειας έρχεται με email· οι ανανεώσεις έρχονται αυτόματα.",
  "Trial setup file (.arktrial)": "Αρχείο ρύθμισης δοκιμής (.arktrial)",
  "Used in the trial setup session: it sets up the trial and the trial employees.":
    "Χρησιμοποιείται στη συνεδρία ρύθμισης της δοκιμής: ορίζει τη δοκιμή και τους υπαλλήλους της.",
  "Done. Your paid licence is active.":
    "Έγινε. Η άδεια επί πληρωμή είναι ενεργή.",
  "Done. Your trial is active.": "Έγινε. Η δοκιμή σας είναι ενεργή.",
  "This licence key is already in use here. Nothing changed.":
    "Αυτό το κλειδί άδειας χρησιμοποιείται ήδη εδώ. Δεν άλλαξε τίποτα.",
  "This trial code is already in use here. Nothing changed.":
    "Αυτός ο κωδικός δοκιμής χρησιμοποιείται ήδη εδώ. Δεν άλλαξε τίποτα.",

  // Where the install stands.
  "ArkAgent is not activated on this computer yet.":
    "Το ArkAgent δεν έχει ενεργοποιηθεί ακόμη σε αυτόν τον υπολογιστή.",
  "Paid licence, valid until {date}.": "Άδεια επί πληρωμή, σε ισχύ έως {date}.",
  "Paid. No end date.": "Επί πληρωμή. Χωρίς ημερομηνία λήξης.",
  "Trial until {date}. 1 day left.": "Δοκιμή έως {date}. Απομένει 1 ημέρα.",
  "Trial until {date}. {days} days left.":
    "Δοκιμή έως {date}. Απομένουν {days} ημέρες.",
  "The trial ended on {date}. Your conversations and settings are kept.":
    "Η δοκιμή έληξε στις {date}. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται.",
  "The licence ended on {date}. Your conversations and settings are kept.":
    "Η άδεια έληξε στις {date}. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται.",
  "ArkAgent works on this computer with a trial activation code, a paid licence key or the trial setup file.":
    "Το ArkAgent λειτουργεί σε αυτόν τον υπολογιστή με κωδικό ενεργοποίησης δοκιμής, κλειδί άδειας επί πληρωμή ή το αρχείο ρύθμισης δοκιμής.",
  "Once a day this computer asks {host} for the renewed licence key. Only the customer id, this computer's random id, the version and the key's number are sent.":
    "Μία φορά την ημέρα αυτός ο υπολογιστής ζητά από το {host} το ανανεωμένο κλειδί άδειας. Στέλνονται μόνο το αναγνωριστικό πελάτη, ένα τυχαίο αναγνωριστικό του υπολογιστή, η έκδοση και ο αριθμός του κλειδιού.",
  "The last renewal check did not go through.":
    "Ο τελευταίος έλεγχος ανανέωσης δεν ολοκληρώθηκε.",
  "Last checked: {when}.": "Τελευταίος έλεγχος: {when}.",
  "Could not use the code": "Ο κωδικός δεν μπόρεσε να χρησιμοποιηθεί",
  "Could not check the activation": "Η ενεργοποίηση δεν μπόρεσε να ελεγχθεί",

  // The server's sentences.
  "ArkAgent is not activated on this computer. Enter your trial activation code or your licence key.":
    "Το ArkAgent δεν έχει ενεργοποιηθεί σε αυτόν τον υπολογιστή. Εισαγάγετε τον κωδικό ενεργοποίησης δοκιμής ή το κλειδί άδειας.",
  "Enter the activation code or the licence key.":
    "Εισαγάγετε τον κωδικό ενεργοποίησης ή το κλειδί άδειας.",
  "This is not an activation code or a licence key. Check that it was copied whole.":
    "Αυτό δεν είναι κωδικός ενεργοποίησης ούτε κλειδί άδειας. Ελέγξτε ότι αντιγράφηκε ολόκληρο.",
  "This version of ArkAgent cannot check a licence key yet. Ask BlackArk for the current version.":
    "Αυτή η έκδοση του ArkAgent δεν μπορεί ακόμη να ελέγξει κλειδί άδειας. Ζητήστε από την BlackArk την τρέχουσα έκδοση.",
  "This version of ArkAgent cannot check a trial activation code yet. Ask BlackArk for the current version.":
    "Αυτή η έκδοση του ArkAgent δεν μπορεί ακόμη να ελέγξει κωδικό ενεργοποίησης δοκιμής. Ζητήστε από την BlackArk την τρέχουσα έκδοση.",
  "This licence key is not signed by BlackArk.":
    "Αυτό το κλειδί άδειας δεν έχει υπογραφεί από την BlackArk.",
  "This trial activation code is not signed by BlackArk.":
    "Αυτός ο κωδικός ενεργοποίησης δοκιμής δεν έχει υπογραφεί από την BlackArk.",
  "This licence key is for another customer than the one this computer is set up for.":
    "Αυτό το κλειδί άδειας είναι για άλλον πελάτη από αυτόν για τον οποίο έχει ρυθμιστεί ο υπολογιστής.",
  "This trial activation code is for another customer than the one this computer is set up for.":
    "Αυτός ο κωδικός ενεργοποίησης δοκιμής είναι για άλλον πελάτη από αυτόν για τον οποίο έχει ρυθμιστεί ο υπολογιστής.",
  "This licence key expired on {date}. The renewed key is sent after each payment.":
    "Αυτό το κλειδί άδειας έληξε στις {date}. Το ανανεωμένο κλειδί αποστέλλεται μετά από κάθε πληρωμή.",
  "This trial activation code ended on {date}.":
    "Αυτός ο κωδικός ενεργοποίησης δοκιμής έληξε στις {date}.",
  "This computer already has a paid licence. A trial code is not needed.":
    "Αυτός ο υπολογιστής έχει ήδη άδεια επί πληρωμή. Δεν χρειάζεται κωδικός δοκιμής.",
  "This computer already has a licence key that lasts as long or longer.":
    "Αυτός ο υπολογιστής έχει ήδη κλειδί άδειας που διαρκεί το ίδιο ή περισσότερο.",
  "This computer already has a trial code that lasts as long or longer.":
    "Αυτός ο υπολογιστής έχει ήδη κωδικό δοκιμής που διαρκεί το ίδιο ή περισσότερο.",
  "Your licence ended on {date}. Your conversations and settings are kept. Enter your renewed licence key to continue.":
    "Η άδειά σας έληξε στις {date}. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται. Για να συνεχίσετε, εισαγάγετε το ανανεωμένο κλειδί άδειας.",
  "Your trial ended on {date}. Your conversations and settings are kept. Enter a licence key or an unlock code to continue.":
    "Η δοκιμή σας έληξε στις {date}. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται. Για να συνεχίσετε, εισαγάγετε κλειδί άδειας ή κωδικό ξεκλειδώματος.",

  // The desktop app closed while the server kept running (#109, DT item 3).
  "ArkAgent is not open, so {name} cannot work right now. Open ArkAgent on this computer, then send your message again.":
    "Το ArkAgent δεν είναι ανοιχτό και ο υπάλληλος {name} δεν μπορεί να εργαστεί αυτή τη στιγμή. Ανοίξτε το ArkAgent σε αυτόν τον υπολογιστή και στείλτε ξανά το μήνυμά σας.",
};
