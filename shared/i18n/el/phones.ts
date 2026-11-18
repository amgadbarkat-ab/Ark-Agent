/**
 * Settings → Phones (#149): this computer's ArkAgent on a phone, through BlackArk's relay (Ark Link),
 * and every sentence the server says about it.
 */
export const EL_PHONES: Record<string, string> = {
  Phones: "Κινητά",
  "Open this computer's ArkAgent on your phone, wherever you are. The phone connects through BlackArk's relay; you still see your own computer's app.":
    "Ανοίξτε το ArkAgent αυτού του υπολογιστή στο κινητό σας, όπου κι αν βρίσκεστε. Το κινητό συνδέεται μέσω του αναμεταδότη της BlackArk· βλέπετε πάντα την εφαρμογή του δικού σας υπολογιστή.",
  "An administrator pairs phones, at a computer. A phone paired for you appears here for you to accept.":
    "Τα κινητά τα συνδέει ένας διαχειριστής, από υπολογιστή. Ένα κινητό που συνδέθηκε για εσάς εμφανίζεται εδώ για να το αποδεχτείτε.",
  "Your phones": "Τα κινητά σας",
  Me: "Εγώ",
  "This phone is for": "Το κινητό είναι για",
  "The phone acts as {name}, with their role. It works once they accept it on their own computer.":
    "Το κινητό ενεργεί ως {name}, με τον ρόλο του/της. Λειτουργεί όταν το αποδεχτεί στον δικό του/της υπολογιστή.",
  "The phone acts as you, with your role.":
    "Το κινητό ενεργεί ως εσείς, με τον ρόλο σας.",
  you: "εσάς",
  nobody: "κανέναν",
  "For {name}. Waiting for them to accept it.":
    "Για {name}. Περιμένει να το αποδεχτεί.",
  "Acts as {name}.": "Ενεργεί ως {name}.",
  Accept: "Αποδοχή",
  "Could not load your phones": "Δεν φορτώθηκαν τα κινητά σας",
  "The phone could not be accepted": "Η αποδοχή του κινητού απέτυχε",
  "That person cannot have a phone here: they are not an active member of this install.":
    "Αυτό το πρόσωπο δεν μπορεί να έχει κινητό εδώ: δεν είναι ενεργό μέλος αυτής της εγκατάστασης.",
  "No such phone waits for you.": "Κανένα τέτοιο κινητό δεν περιμένει εσάς.",
  "Pair and manage phones on your computer, not from a phone.":
    "Η σύνδεση και η διαχείριση κινητών γίνεται από τον υπολογιστή σας, όχι από κινητό.",
  "Sign in on your computer. This phone acts as the person it was paired for, and never signs in itself.":
    "Συνδεθείτε από τον υπολογιστή σας. Αυτό το κινητό ενεργεί ως το πρόσωπο για το οποίο συνδέθηκε και δεν συνδέεται ποτέ μόνο του.",
  "This phone is no longer paired with this computer.":
    "Αυτό το κινητό δεν είναι πια συνδεδεμένο με αυτόν τον υπολογιστή.",
  "This phone waits for the person it was paired for to accept it on their computer.":
    "Αυτό το κινητό περιμένει να το αποδεχτεί, στον υπολογιστή του, το πρόσωπο για το οποίο συνδέθηκε.",
  "Not set up. BlackArk gives you an install token.":
    "Δεν έχει ρυθμιστεί. Η BlackArk σάς δίνει ένα διακριτικό εγκατάστασης.",
  "Off. No phone can reach this computer.":
    "Ανενεργό. Κανένα κινητό δεν έχει πρόσβαση σε αυτόν τον υπολογιστή.",
  "On. Paired phones can reach this computer.":
    "Ενεργό. Τα συνδεδεμένα κινητά έχουν πρόσβαση σε αυτόν τον υπολογιστή.",
  "Pairing is not signing in: on the phone you still sign in with your own ArkAgent account.":
    "Η σύνδεση του κινητού δεν είναι είσοδος: στο κινητό συνδέεστε πάλι με τον δικό σας λογαριασμό ArkAgent.",
  "Phone access": "Πρόσβαση από κινητό",
  "Relay and install token": "Αναμεταδότης και διακριτικό εγκατάστασης",
  "Not set up": "Δεν έχει ρυθμιστεί",
  "BlackArk gives you both. The token is typed here once and kept encrypted on this computer; it is never shown again.":
    "Και τα δύο σάς τα δίνει η BlackArk. Το διακριτικό πληκτρολογείται εδώ μία φορά και φυλάσσεται κρυπτογραφημένο σε αυτόν τον υπολογιστή· δεν εμφανίζεται ξανά.",
  "Relay address": "Διεύθυνση αναμεταδότη",
  "New install token (leave empty to keep it)":
    "Νέο διακριτικό εγκατάστασης (αφήστε κενό για να μείνει το ίδιο)",
  "Install token": "Διακριτικό εγκατάστασης",
  "Save and switch on": "Αποθήκευση και ενεργοποίηση",
  "Pair a phone": "Σύνδεση κινητού",
  "New code": "Νέος κωδικός",
  "On the phone, open the ArkAgent app (or the address below) and enter the code, or scan the QR code with the camera. The code works once, for 5 minutes.":
    "Στο κινητό, ανοίξτε την εφαρμογή ArkAgent (ή τη διεύθυνση παρακάτω) και γράψτε τον κωδικό, ή σαρώστε τον κωδικό QR με την κάμερα. Ο κωδικός ισχύει μία φορά, για 5 λεπτά.",
  "QR code for pairing a phone": "Κωδικός QR για σύνδεση κινητού",
  Code: "Κωδικός",
  "Valid until {time}.": "Ισχύει έως τις {time}.",
  "On an iPhone, type the code in the ArkAgent app. Scanning it with the Camera opens Safari, which would pair Safari instead of the app.":
    "Σε iPhone, γράψτε τον κωδικό στην εφαρμογή ArkAgent. Αν τον σαρώσετε με την Κάμερα, ανοίγει το Safari και συνδέεται το Safari αντί για την εφαρμογή.",
  "Wants to pair. Is this your phone?": "Ζητά σύνδεση. Είναι το κινητό σας;",
  "Confirm this phone": "Επιβεβαίωση κινητού",
  "Only confirm a phone you are holding, or one you were just told about by its owner. You can rename it.":
    "Επιβεβαιώστε μόνο ένα κινητό που κρατάτε, ή για το οποίο μόλις σας ενημέρωσε ο κάτοχός του. Μπορείτε να το μετονομάσετε.",
  "Phone's name": "Όνομα κινητού",
  "Pair this phone": "Σύνδεση αυτού του κινητού",
  "Paired phones": "Συνδεδεμένα κινητά",
  "No phone is paired with this computer.":
    "Κανένα κινητό δεν είναι συνδεδεμένο με αυτόν τον υπολογιστή.",
  "Paired {paired}. Last used {used}.":
    "Συνδέθηκε {paired}. Τελευταία χρήση {used}.",
  "Paired {paired}. Not used yet.":
    "Συνδέθηκε {paired}. Δεν έχει χρησιμοποιηθεί ακόμα.",
  "Remove {name}?": "Αφαίρεση {name};",
  "It stops reaching this computer at once, even with ArkAgent open on it. To use it again, pair it again.":
    "Χάνει αμέσως την πρόσβαση σε αυτόν τον υπολογιστή, ακόμα κι αν έχει ανοιχτό το ArkAgent. Για να το ξαναχρησιμοποιήσετε, συνδέστε το ξανά.",

  // The app's own fallbacks.
  "Could not load the phones": "Δεν φορτώθηκαν τα κινητά",
  "The phone settings could not be saved":
    "Οι ρυθμίσεις κινητών δεν αποθηκεύτηκαν",
  "Could not get a pairing code": "Δεν δόθηκε κωδικός σύνδεσης",
  "The phone could not be paired": "Το κινητό δεν συνδέθηκε",
  "Could not decline the phone": "Η απόρριψη του κινητού απέτυχε",
  "The phone could not be removed": "Το κινητό δεν αφαιρέθηκε",

  // The server's sentences.
  "Phones can be paired only where people sign in. Switch sign-in on for this install first (Google, Microsoft or your company's directory); then pair a phone here.":
    "Κινητά συνδέονται μόνο όπου οι χρήστες συνδέονται με λογαριασμό. Ενεργοποιήστε πρώτα τη σύνδεση με λογαριασμό σε αυτή την εγκατάσταση (Google, Microsoft ή τον κατάλογο της εταιρείας σας)· μετά συνδέστε ένα κινητό εδώ.",
  "Connect this on your computer: the sign-in returns to the computer, so it cannot finish on a phone.":
    "Συνδέστε το από τον υπολογιστή σας: η σύνδεση επιστρέφει στον υπολογιστή, οπότε δεν μπορεί να ολοκληρωθεί από κινητό.",
  "The relay address must be https://<host>, with nothing after it.":
    "Η διεύθυνση του αναμεταδότη πρέπει να είναι https://<host>, χωρίς τίποτα μετά.",
  "Enter the install token BlackArk gave you.":
    "Γράψτε το διακριτικό εγκατάστασης που σας έδωσε η BlackArk.",
  "Check the relay address and the install token (it starts arki_).":
    "Ελέγξτε τη διεύθυνση του αναμεταδότη και το διακριτικό εγκατάστασης (αρχίζει με arki_).",
  "Phones cannot be paired while the relay is not connected.":
    "Δεν γίνεται σύνδεση κινητών όσο ο αναμεταδότης δεν είναι συνδεδεμένος.",
  "The relay did not answer. Try again.":
    "Ο αναμεταδότης δεν απάντησε. Δοκιμάστε ξανά.",
  "That phone is no longer waiting. Ask for a new code.":
    "Αυτό το κινητό δεν περιμένει πια. Ζητήστε νέο κωδικό.",
  "Give the phone a name.": "Δώστε ένα όνομα στο κινητό.",
  "No such phone.": "Δεν υπάρχει τέτοιο κινητό.",
  "The relay could not be reached. Trying again.":
    "Ο αναμεταδότης δεν είναι προσβάσιμος. Νέα προσπάθεια.",
  "The relay connection dropped. Trying again.":
    "Η σύνδεση με τον αναμεταδότη διακόπηκε. Νέα προσπάθεια.",
  "The relay could not be reached, or it refused this install token. Trying again.":
    "Ο αναμεταδότης δεν είναι προσβάσιμος ή απέρριψε αυτό το διακριτικό εγκατάστασης. Νέα προσπάθεια.",
  "Another computer connected to the relay with this install token.":
    "Άλλος υπολογιστής συνδέθηκε στον αναμεταδότη με αυτό το διακριτικό εγκατάστασης.",
  "BlackArk's relay no longer knows this install.":
    "Ο αναμεταδότης της BlackArk δεν αναγνωρίζει πια αυτή την εγκατάσταση.",
  "The relay speaks a different version of Ark Link. Update ArkAgent.":
    "Ο αναμεταδότης χρησιμοποιεί άλλη έκδοση του Ark Link. Ενημερώστε το ArkAgent.",
};
