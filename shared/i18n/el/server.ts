/** Sentences the server sends that a person reads: errors, refusals, status. Keyed by the English exactly as the server writes it. */
export const EL_SERVER: Record<string, string> = {
  "{plural} where the payment service did not say whether it took the money. Look at Paddle's own record, then settle each one.":
    "{plural} όπου η υπηρεσία πληρωμών δεν είπε αν πήρε τα χρήματα. Δείτε το αρχείο της Paddle και διευθετήστε το καθένα.",
  "{plural} started over an hour ago and never recorded an answer. They are not retried; check Paddle, then settle them.":
    "{plural} ξεκίνησαν πριν από πάνω από μία ώρα και δεν κατέγραψαν απάντηση. Δεν ξαναδοκιμάζονται· ελέγξτε την Paddle και διευθετήστε τα.",
  "{plural} not visible to anyone until you approve or reject {value2}.":
    "{plural} δεν είναι ορατά σε κανέναν μέχρι να εγκρίνετε ή να απορρίψετε {value2}.",
  "{plural} open against shared digital employees.":
    "{plural} ανοιχτές για κοινοποιημένους ψηφιακούς υπαλλήλους.",
  "{plural} ran out of attempts and will not run again. The reason is in the work_items table and the server log.":
    "{plural} εξάντλησαν τις προσπάθειες και δεν θα εκτελεστούν ξανά. Η αιτία βρίσκεται στον πίνακα work_items και στο αρχείο καταγραφής του διακομιστή.",
  "{plural} a failed payment. The provider is retrying; they lose access if it does not clear.":
    "{plural} αποτυχημένη πληρωμή. Ο πάροχος ξαναδοκιμάζει· αν δεν εκκαθαριστεί, χάνουν την πρόσβαση.",
  "{plural} suspended and cannot run digital employees.":
    "{plural} σε αναστολή και δεν μπορούν να λειτουργήσουν ψηφιακούς υπαλλήλους.",
  "This deployment runs for one company and takes no payments (ARK_BILLING_MODE is not subscriptions).":
    "Αυτή η εγκατάσταση λειτουργεί για μία εταιρεία και δεν δέχεται πληρωμές (το ARK_BILLING_MODE δεν είναι subscriptions).",
  "Customers cannot pay: the payment provider is manual. Set ARK_BILLING_PROVIDER=paddle (docs/ark/12-paddle.md).":
    "Οι πελάτες δεν μπορούν να πληρώσουν: ο πάροχος πληρωμών είναι χειροκίνητος. Ορίστε ARK_BILLING_PROVIDER=paddle (docs/ark/12-paddle.md).",
  "The payment provider (stripe) is in test mode, so no real money is taken. Stripe is supported in test mode only for now (docs/ark/26-stripe.md).":
    "Ο πάροχος πληρωμών (stripe) είναι σε δοκιμαστική λειτουργία, οπότε δεν χρεώνονται πραγματικά χρήματα. Το Stripe υποστηρίζεται προς το παρόν μόνο σε δοκιμαστική λειτουργία (docs/ark/26-stripe.md).",
  "The payment provider ({id}) is in test mode, so no real money is taken. Switch to the live Paddle account once the sandbox run has passed.":
    "Ο πάροχος πληρωμών ({id}) είναι σε δοκιμαστική λειτουργία, οπότε δεν χρεώνονται πραγματικά χρήματα. Περάστε στον πραγματικό λογαριασμό Paddle μόλις πετύχει η δοκιμαστική εκτέλεση.",
  "Taking real payments through {id}.": "Πραγματικές πληρωμές μέσω {id}.",
  "New customers must accept the current terms before using Ark.":
    "Οι νέοι πελάτες πρέπει να αποδεχτούν τους τρέχοντες όρους πριν χρησιμοποιήσουν την Ark.",
  "Customers are not asked to accept the terms. Once a lawyer has reviewed the text, set TERMS_ACCEPTANCE=required.":
    "Δεν ζητείται από τους πελάτες να αποδεχτούν τους όρους. Όταν ελέγξει το κείμενο νομικός, ορίστε TERMS_ACCEPTANCE=required.",
  "Prices are set, so customers can switch cloud running on.":
    "Οι τιμές έχουν οριστεί, οπότε οι πελάτες μπορούν να ενεργοποιήσουν τη λειτουργία στο νέφος.",
  "Cloud running is an add-on but has no prices, so nobody can switch it on. Set them under Cloud costs, from measured cost.":
    "Η λειτουργία στο νέφος είναι πρόσθετη αλλά δεν έχει τιμές, οπότε κανείς δεν μπορεί να την ενεργοποιήσει. Ορίστε τις στο Κόστος νέφους, με βάση το μετρημένο κόστος.",
  "Cloud running is switched off on this deployment.":
    "Η λειτουργία στο νέφος είναι απενεργοποιημένη σε αυτή την εγκατάσταση.",
  "Cloud running is included for everyone, so there is nothing to price.":
    "Η λειτουργία στο νέφος περιλαμβάνεται για όλους, οπότε δεν υπάρχει κάτι να τιμολογηθεί.",
  "Each audit event is also written to the process log, where the application cannot rewrite it.":
    "Κάθε συμβάν ελέγχου γράφεται επίσης στο αρχείο καταγραφής της διεργασίας, όπου η εφαρμογή δεν μπορεί να το αλλάξει.",
  "The audit trail lives only in the database. Set AUDIT_SHIPPING=log so there is a copy the application cannot change.":
    "Το ιστορικό ελέγχου υπάρχει μόνο στη βάση δεδομένων. Ορίστε AUDIT_SHIPPING=log ώστε να υπάρχει αντίγραφο που η εφαρμογή δεν μπορεί να αλλάξει.",
  "Metrics are served on their own port for the monitoring system to read.":
    "Οι μετρήσεις διατίθενται σε δική τους θύρα για το σύστημα παρακολούθησης.",
  "No metrics are served, so there is nothing to graph or alert on. Set METRICS_PORT.":
    "Δεν διατίθενται μετρήσεις, οπότε δεν υπάρχει τίποτα για γραφήματα ή ειδοποιήσεις. Ορίστε METRICS_PORT.",
  "The browser blocks anything the policy does not allow.":
    "Ο περιηγητής μπλοκάρει ό,τι δεν επιτρέπει η πολιτική.",
  "The policy only reports what it would block. Change it to enforce once the reports are quiet (docs/ark/15-security-review.md).":
    "Η πολιτική μόνο αναφέρει τι θα μπλόκαρε. Αλλάξτε την σε εφαρμογή μόλις ησυχάσουν οι αναφορές (docs/ark/15-security-review.md).",
  "No policy is sent beyond frame-ancestors. Use report-only or enforce.":
    "Δεν στέλνεται πολιτική πέρα από το frame-ancestors. Χρησιμοποιήστε report-only ή enforce.",
  "The app is served over HTTPS.": "Η εφαρμογή εξυπηρετείται μέσω HTTPS.",
  "The app address is not HTTPS. Customers' sign-ins and payments must not cross plain HTTP.":
    "Η διεύθυνση της εφαρμογής δεν είναι HTTPS. Οι συνδέσεις και οι πληρωμές των πελατών δεν πρέπει να περνούν από απλό HTTP.",
  "The app address is not set (OPENBOT_APP_URL or TRUSTED_ORIGINS).":
    "Η διεύθυνση της εφαρμογής δεν έχει οριστεί (OPENBOT_APP_URL ή TRUSTED_ORIGINS).",
  "Staff sign in through the company's own directory.":
    "Το προσωπικό συνδέεται μέσω του καταλόγου της εταιρείας.",
  "Staff are not tied to a directory the company controls. Configure a single Entra tenant (or Okta) so only staff can be administrators.":
    "Το προσωπικό δεν συνδέεται με κατάλογο που ελέγχει η εταιρεία. Ρυθμίστε έναν μόνο tenant Entra (ή Okta) ώστε μόνο το προσωπικό να μπορεί να γίνει διαχειριστής.",
  "An older encryption key is still configured, so a key rotation is unfinished. Re-seal what it protects, then remove it (docs/ark/13-azure-hosting.md, key rotation).":
    "Είναι ακόμη ρυθμισμένο παλαιότερο κλειδί κρυπτογράφησης, οπότε η αλλαγή κλειδιού δεν έχει ολοκληρωθεί. Σφραγίστε ξανά ό,τι προστατεύει και μετά αφαιρέστε το (docs/ark/13-azure-hosting.md, αλλαγή κλειδιού).",
  "Only the current encryption key is configured.":
    "Είναι ρυθμισμένο μόνο το τρέχον κλειδί κρυπτογράφησης.",
  "This value was sealed with a key this deployment no longer holds ({kid}).":
    "Αυτή η τιμή σφραγίστηκε με κλειδί που η εγκατάσταση δεν έχει πια ({kid}).",
  "That is not a valid address.": "Αυτή δεν είναι έγκυρη διεύθυνση.",
  "The component {field} must be text.":
    "Το πεδίο {field} του στοιχείου πρέπει να είναι κείμενο.",
  "The component {field} must be an object.":
    "Το πεδίο {field} του στοιχείου πρέπει να είναι αντικείμενο.",
  "Component at index {index} needs a name, a title, a kind and a description.":
    "Το στοιχείο στη θέση {index} χρειάζεται όνομα, τίτλο, είδος και περιγραφή.",
  "There is no such digital employee.":
    "Δεν υπάρχει τέτοιος ψηφιακός υπάλληλος.",
  "The digital employee is required.":
    "Ο ψηφιακός υπάλληλος είναι υποχρεωτικός.",
  "Functions must be a list of function names.":
    "Οι λειτουργίες πρέπει να είναι λίστα ονομάτων λειτουργιών.",
  "The function and the digital employee are both required.":
    "Η λειτουργία και ο ψηφιακός υπάλληλος είναι και τα δύο υποχρεωτικά.",
  "Function arguments must be an object.":
    "Οι παράμετροι της λειτουργίας πρέπει να είναι αντικείμενο.",
  "There is no data function called {functionName} in this deployment.":
    "Δεν υπάρχει λειτουργία δεδομένων με το όνομα {functionName} σε αυτή την εγκατάσταση.",
  "{name} has not been granted the function {functionName}. An administrator grants each function to each component.":
    "Στο {name} δεν έχει δοθεί η λειτουργία {functionName}. Ο διαχειριστής δίνει κάθε λειτουργία σε κάθε στοιχείο.",
  "That data could not be read.":
    "Δεν ήταν δυνατή η ανάγνωση αυτών των δεδομένων.",
  "The agent did not answer in time. It may be starting up, or the address may be unreachable from this server.":
    "Ο πράκτορας δεν απάντησε εγκαίρως. Μπορεί να ξεκινά ή η διεύθυνση να μην είναι προσβάσιμη από αυτόν τον διακομιστή.",
  "This server could not reach that address. If your agent runs on your own machine, it needs to be reachable from here, a tunnel, or somewhere this server can dial.":
    "Ο διακομιστής δεν μπόρεσε να φτάσει σε αυτή τη διεύθυνση. Αν ο πράκτοράς σας λειτουργεί στον δικό σας υπολογιστή, πρέπει να είναι προσβάσιμος από εδώ, μέσω tunnel ή από κάπου όπου μπορεί να συνδεθεί ο διακομιστής.",
  "The agent refused this request. If it needs a key, add it as a header.":
    "Ο πράκτορας αρνήθηκε το αίτημα. Αν χρειάζεται κλειδί, προσθέστε το ως κεφαλίδα.",
  "The agent answered {status}. An AG-UI endpoint answers a POST with a stream of events.":
    "Ο πράκτορας απάντησε {status}. Ένα σημείο AG-UI απαντά σε POST με ροή συμβάντων.",
  "The agent started answering and the connection broke.":
    "Ο πράκτορας άρχισε να απαντά και η σύνδεση διακόπηκε.",
  "That address answered, but not with AG-UI events (it sent {contentType}). Check it is the agent's AG-UI path and not its home page.":
    "Η διεύθυνση απάντησε, αλλά όχι με συμβάντα AG-UI (έστειλε {contentType}). Ελέγξτε ότι είναι η διαδρομή AG-UI του πράκτορα και όχι η αρχική του σελίδα.",
  "Choose a picture to use as the icon.": "Επιλέξτε εικόνα για εικονίδιο.",
  "That picture is too large. Choose a smaller one.":
    "Η εικόνα είναι πολύ μεγάλη. Επιλέξτε μικρότερη.",
  "The icon must be a PNG, JPEG or WebP picture.":
    "Το εικονίδιο πρέπει να είναι εικόνα PNG, JPEG ή WebP.",
  "That file is not the kind of picture it says.":
    "Το αρχείο δεν είναι το είδος εικόνας που δηλώνει.",
  "That was not put to anybody: say what you need a person to answer.":
    "Δεν ρωτήθηκε κανείς: πείτε τι χρειάζεστε να απαντήσει ένας άνθρωπος.",
  "Agent input must be a JSON object.":
    "Τα δεδομένα του πράκτορα πρέπει να είναι αντικείμενο JSON.",
  "Instructions must be text.": "Οι οδηγίες πρέπει να είναι κείμενο.",
  "Instructions must be {MAX_INSTRUCTIONS} characters or fewer.":
    "Οι οδηγίες πρέπει να είναι έως {MAX_INSTRUCTIONS} χαρακτήρες.",
  "Visibility must be public or private.":
    "Η ορατότητα πρέπει να είναι δημόσια ή ιδιωτική.",
  "Where it runs must be Ark's cloud or your computer.":
    "Το πού λειτουργεί πρέπει να είναι το νέφος της Ark ή ο υπολογιστής σας.",
  "That is not a valid header name.": "Αυτό δεν είναι έγκυρο όνομα κεφαλίδας.",
  "That key contains {unsendable}, so it cannot be sent as a header.":
    "Το κλειδί περιέχει {unsendable}, οπότε δεν μπορεί να σταλεί ως κεφαλίδα.",
  "Headers must be an object of name to value.":
    "Οι κεφαλίδες πρέπει να είναι αντικείμενο ονόματος προς τιμή.",
  "Headers must have at most 32 entries.":
    "Οι κεφαλίδες μπορούν να είναι έως 32.",
  "That is not a valid header name: {value1}.":
    "Αυτό δεν είναι έγκυρο όνομα κεφαλίδας: {value1}.",
  'Header "{name}" must be a string value.':
    "Η κεφαλίδα «{name}» πρέπει να έχει τιμή κειμένου.",
  'Header "{name}" must be at most 4096 characters.':
    "Η κεφαλίδα «{name}» πρέπει να είναι έως 4096 χαρακτήρες.",
  'Header "{name}" contains {unsendable}, so it cannot be sent.':
    "Η κεφαλίδα «{name}» περιέχει {unsendable}, οπότε δεν μπορεί να σταλεί.",
  "Agent not found.": "Ο ψηφιακός υπάλληλος δεν βρέθηκε.",
  "You do not have permission to manage this agent.":
    "Δεν έχετε άδεια διαχείρισης αυτού του ψηφιακού υπαλλήλου.",
  "System-owned agents are protected.":
    "Οι ψηφιακοί υπάλληλοι του συστήματος προστατεύονται.",
  "An agent needs a web address.": "Ο πράκτορας χρειάζεται διεύθυνση ιστού.",
  "That address redirected to another host, and this deployment will not forward the run to it.":
    "Η διεύθυνση ανακατεύθυνε σε άλλο διακομιστή, και η εγκατάσταση δεν θα προωθήσει την εκτέλεση εκεί.",
  "This deployment will not dial {address}: the name {hostname} points at an address inside the deployment's own network.":
    "Η εγκατάσταση δεν θα συνδεθεί στο {address}: το όνομα {hostname} δείχνει σε διεύθυνση μέσα στο δίκτυο της ίδιας της εγκατάστασης.",
  "That address redirected more than {MAX_REDIRECTS} times without arriving anywhere.":
    "Η διεύθυνση ανακατεύθυνε περισσότερες από {MAX_REDIRECTS} φορές χωρίς να καταλήξει πουθενά.",
  "Model credential is not configured.":
    "Δεν έχει ρυθμιστεί διαπιστευτήριο μοντέλου.",
  "Tool arguments must be an object.":
    "Οι παράμετροι του εργαλείου πρέπει να είναι αντικείμενο.",
  "That token is not for this digital employee.":
    "Αυτό το διακριτικό δεν είναι για αυτόν τον ψηφιακό υπάλληλο.",
  "{name} has been deleted and can no longer run. Its conversations remain readable.":
    "Ο/Η {name} έχει διαγραφεί και δεν μπορεί πλέον να λειτουργήσει. Οι συνομιλίες του παραμένουν διαθέσιμες για ανάγνωση.",
  "No digital employee is available.":
    "Δεν υπάρχει διαθέσιμος ψηφιακός υπάλληλος.",
  "That digital employee is not on your roster.":
    "Αυτός ο ψηφιακός υπάλληλος δεν είναι στην ομάδα σας.",
  "No identity provider is configured.":
    "Δεν έχει ρυθμιστεί πάροχος ταυτότητας.",
  "Your access to this deployment has been removed.":
    "Η πρόσβασή σας σε αυτή την εγκατάσταση έχει αφαιρεθεί.",
  "Administrator access required.": "Απαιτείται πρόσβαση διαχειριστή.",
  "Search for at most 200 characters.": "Αναζητήστε έως 200 χαρακτήρες.",
  "That is not a category.": "Αυτή δεν είναι κατηγορία.",
  "Kind is official or shared.": "Το είδος είναι official ή shared.",
  "No such listing.": "Δεν υπάρχει τέτοια καταχώριση.",
  "That is a lot of installs. Try again later.":
    "Πάρα πολλές εγκαταστάσεις. Δοκιμάστε ξανά αργότερα.",
  "Choose a reason.": "Επιλέξτε αιτία.",
  "Too many reports. Try again later.":
    "Πάρα πολλές αναφορές. Δοκιμάστε ξανά αργότερα.",
  "No such publisher.": "Δεν υπάρχει τέτοιος εκδότης.",
  "Give a name to show.": "Δώστε ένα όνομα για εμφάνιση.",
  "That listing is not complete.": "Η καταχώριση δεν είναι πλήρης.",
  "Too many submissions. Try again later.":
    "Πάρα πολλές υποβολές. Δοκιμάστε ξανά αργότερα.",
  "Say why, in a sentence or two.": "Πείτε γιατί, σε μία ή δύο προτάσεις.",
  "No such report.": "Δεν υπάρχει τέτοια αναφορά.",
  "That page cursor is not valid.": "Ο δείκτης σελίδας δεν είναι έγκυρος.",
  "Only our staff can do that.": "Μόνο το προσωπικό μας μπορεί να το κάνει.",
  "This contains a secret. Remove what is listed, then try again.":
    "Περιέχει μυστικό στοιχείο. Αφαιρέστε ό,τι αναφέρεται και δοκιμάστε ξανά.",
  "This may contain private details. Check what is listed, and tick the box to say it is safe to share.":
    "Μπορεί να περιέχει ιδιωτικά στοιχεία. Ελέγξτε ό,τι αναφέρεται και επιλέξτε το πλαίσιο ότι είναι ασφαλές να κοινοποιηθεί.",
  "That listing cannot be installed right now.":
    "Αυτή η καταχώριση δεν μπορεί να εγκατασταθεί αυτή τη στιγμή.",
  "Choose one of your own digital employees to share.":
    "Επιλέξτε έναν δικό σας ψηφιακό υπάλληλο για κοινοποίηση.",
  'The name "Ark" is already taken by another publisher; free it before starting.':
    "Το όνομα «Ark» χρησιμοποιείται ήδη από άλλον εκδότη· ελευθερώστε το πριν ξεκινήσετε.",
  "The introduction can be at most {bio} characters.":
    "Η εισαγωγή μπορεί να είναι έως {bio} χαρακτήρες.",
  "The introduction must not contain an email address, phone number, key or other private detail.":
    "Η εισαγωγή δεν πρέπει να περιέχει διεύθυνση email, τηλέφωνο, κλειδί ή άλλο ιδιωτικό στοιχείο.",
  "The publisher was not saved.": "Ο εκδότης δεν αποθηκεύτηκε.",
  "Somebody already uses that name. Choose another.":
    "Κάποιος χρησιμοποιεί ήδη αυτό το όνομα. Επιλέξτε άλλο.",
  "Choose the name other people will see before you share.":
    "Επιλέξτε το όνομα που θα βλέπουν οι άλλοι πριν κοινοποιήσετε.",
  "You already have {pendingPerAccount} listings waiting for review. Wait for those first.":
    "Έχετε ήδη {pendingPerAccount} καταχωρίσεις σε αναμονή ελέγχου. Περιμένετε πρώτα αυτές.",
  "An account can have at most {listingsPerAccount} listings.":
    "Ένας λογαριασμός μπορεί να έχει έως {listingsPerAccount} καταχωρίσεις.",
  "Could not find a free address for the listing.":
    "Δεν βρέθηκε ελεύθερη διεύθυνση για την καταχώριση.",
  "The listing was not saved.": "Η καταχώριση δεν αποθηκεύτηκε.",
  "Our staff took this listing down, so it cannot be changed. You can share it again as a new listing once it is fixed.":
    "Το προσωπικό μας αφαίρεσε αυτή την καταχώριση, οπότε δεν μπορεί να αλλάξει. Μπορείτε να την κοινοποιήσετε ξανά ως νέα καταχώριση αφού διορθωθεί.",
  "Our staff took this listing down. It stays on record.":
    "Το προσωπικό μας αφαίρεσε αυτή την καταχώριση. Παραμένει στο αρχείο.",
  "Choose a reason from the list.": "Επιλέξτε αιτία από τη λίστα.",
  "Details can be at most {reportDetails} characters.":
    "Οι λεπτομέρειες μπορούν να είναι έως {reportDetails} χαρακτήρες.",
  "This is your own listing. To take it down, withdraw it.":
    "Αυτή είναι δική σας καταχώριση. Για να την αφαιρέσετε, αποσύρετέ την.",
  "You have already reported this listing. Our staff will look at it.":
    "Έχετε ήδη αναφέρει αυτή την καταχώριση. Το προσωπικό μας θα την εξετάσει.",
  "Only a listing that is waiting for review can be approved.":
    "Μόνο καταχώριση σε αναμονή ελέγχου μπορεί να εγκριθεί.",
  "This now looks like it contains a secret. Reject it and say why.":
    "Φαίνεται πλέον ότι περιέχει μυστικό στοιχείο. Απορρίψτε την και εξηγήστε γιατί.",
  "That listing just changed.": "Η καταχώριση μόλις άλλαξε.",
  "Say why, in 1 to {reviewNote} characters. The publisher is shown this.":
    "Πείτε γιατί, σε 1 έως {reviewNote} χαρακτήρες. Ο εκδότης βλέπει αυτό το κείμενο.",
  "No listing is waiting for review with that id.":
    "Δεν υπάρχει καταχώριση σε αναμονή ελέγχου με αυτό το αναγνωριστικό.",
  "No open report with that id.":
    "Δεν υπάρχει ανοιχτή αναφορά με αυτό το αναγνωριστικό.",
  "{field}, line {value2}, {value3}.": "{field}, γραμμή {value2}, {value3}.",
  "Channel not found.": "Η συνομιλία δεν βρέθηκε.",
  "This channel is no longer active.":
    "Αυτή η συνομιλία δεν είναι πλέον ενεργή.",
  "This voice session ID is already in use.":
    "Αυτό το αναγνωριστικό φωνητικής συνεδρίας χρησιμοποιείται ήδη.",
  "Invalid voice history cursor.": "Μη έγκυρος δείκτης ιστορικού φωνής.",
  "Invalid voice summary.": "Μη έγκυρη σύνοψη φωνής.",
  "Voice session not found.": "Η φωνητική συνεδρία δεν βρέθηκε.",
  "Voice history is not configured.": "Το ιστορικό φωνής δεν έχει ρυθμιστεί.",
  "Voice transcript is too large.":
    "Η φωνητική απομαγνητοφώνηση είναι πολύ μεγάλη.",
  "Invalid voice request.": "Μη έγκυρο φωνητικό αίτημα.",
  "Voice transcript saved; summary service is busy. Retry shortly.":
    "Η φωνητική απομαγνητοφώνηση αποθηκεύτηκε· η υπηρεσία σύνοψης είναι απασχολημένη. Δοκιμάστε ξανά σε λίγο.",
  "Voice history could not be saved or loaded. Please retry.":
    "Δεν ήταν δυνατή η αποθήκευση ή η φόρτωση του ιστορικού φωνής. Δοκιμάστε ξανά.",
  "Live voice is not configured.": "Η ζωντανή φωνή δεν έχει ρυθμιστεί.",
  "Too many voice connection attempts. Please retry shortly.":
    "Πάρα πολλές προσπάθειες φωνητικής σύνδεσης. Δοκιμάστε ξανά σε λίγο.",
  "Voice connection request is too large.":
    "Το αίτημα φωνητικής σύνδεσης είναι πολύ μεγάλο.",
  "The channel could not be loaded. Please retry.":
    "Δεν ήταν δυνατή η φόρτωση της συνομιλίας. Δοκιμάστε ξανά.",
  "Live voice requires a channel with exactly one agent.":
    "Η ζωντανή φωνή χρειάζεται συνομιλία με ακριβώς έναν ψηφιακό υπάλληλο.",
  "The agent could not be loaded. Please retry.":
    "Δεν ήταν δυνατή η φόρτωση του ψηφιακού υπαλλήλου. Δοκιμάστε ξανά.",
  "Voice connection timed out or was cancelled. Please retry.":
    "Η φωνητική σύνδεση έληξε ή ακυρώθηκε. Δοκιμάστε ξανά.",
  "The voice service could not start a call. Please retry.":
    "Η φωνητική υπηρεσία δεν μπόρεσε να ξεκινήσει κλήση. Δοκιμάστε ξανά.",
  "The voice service returned an invalid response.":
    "Η φωνητική υπηρεσία έδωσε μη έγκυρη απάντηση.",
  "The voice service is busy. Please retry shortly.":
    "Η φωνητική υπηρεσία είναι απασχολημένη. Δοκιμάστε ξανά σε λίγο.",
  "The voice service could not start a call. Retry or contact your administrator.":
    "Η φωνητική υπηρεσία δεν μπόρεσε να ξεκινήσει κλήση. Δοκιμάστε ξανά ή επικοινωνήστε με τον διαχειριστή.",
  "The voice service could not be reached. Please retry.":
    "Δεν ήταν δυνατή η σύνδεση με τη φωνητική υπηρεσία. Δοκιμάστε ξανά.",
  "The voice service requires an audio SDP offer.":
    "Η φωνητική υπηρεσία χρειάζεται προσφορά ήχου SDP.",
  "Voice summary model returned an invalid summary.":
    "Το μοντέλο σύνοψης φωνής έδωσε μη έγκυρη σύνοψη.",
  "Voice summary model is not configured.":
    "Το μοντέλο σύνοψης φωνής δεν έχει ρυθμιστεί.",
  "Voice summary model request failed ({status}).":
    "Το αίτημα στο μοντέλο σύνοψης φωνής απέτυχε ({status}).",
  "Not a thread id.": "Δεν είναι αναγνωριστικό νήματος.",
  "Could not check thread status.":
    "Δεν ήταν δυνατός ο έλεγχος της κατάστασης του νήματος.",
  "Attachment {namedForFailure} could not be included: this message's attachments come to more than the {limit} bytes one turn may put in front of the model. Send fewer files, or ask about them across more than one message.":
    "Το συνημμένο {namedForFailure} δεν συμπεριλήφθηκε: τα συνημμένα αυτού του μηνύματος ξεπερνούν τα {limit} bytes που μπορεί να δει το μοντέλο σε μία απάντηση. Στείλτε λιγότερα αρχεία ή ρωτήστε γι’ αυτά σε περισσότερα μηνύματα.",
  "Attachment {namedForFailure} could not be loaded: it may have been deleted, or it may belong to another channel or to somebody whose files you cannot see.":
    "Το συνημμένο {namedForFailure} δεν φορτώθηκε: μπορεί να έχει διαγραφεί ή να ανήκει σε άλλη συνομιλία ή σε κάποιον του οποίου τα αρχεία δεν βλέπετε.",
  "This turn was not run, because {value1} could not be recorded as sent ({named}).":
    "Αυτή η απάντηση δεν εκτελέστηκε, επειδή {value1} δεν καταγράφηκε ως απεσταλμένο ({named}).",
  "That file could not be stored just now. Try again.":
    "Δεν ήταν δυνατή η αποθήκευση του αρχείου αυτή τη στιγμή. Δοκιμάστε ξανά.",
  "You are not a member of this channel.":
    "Δεν είστε μέλος αυτής της συνομιλίας.",
  'Send the file as multipart form data under a "file" field.':
    "Στείλτε το αρχείο ως multipart form data στο πεδίο «file».",
  'Attach a file under the "file" field.':
    "Επισυνάψτε αρχείο στο πεδίο «file».",
  "You can attach {MAX_ATTACHMENTS_PER_MESSAGE} files to a message, and {staged} are already waiting to send.":
    "Μπορείτε να επισυνάψετε {MAX_ATTACHMENTS_PER_MESSAGE} αρχεία σε ένα μήνυμα, και {staged} περιμένουν ήδη αποστολή.",
  "You have {held} files waiting to send across your channels, which is as many as one person can hold unsent. Send or remove some before attaching more; any in a channel you can no longer open have to be cleared by whoever runs this deployment.":
    "Έχετε {held} αρχεία σε αναμονή αποστολής στις συνομιλίες σας, το μέγιστο που μπορεί να κρατά ένα άτομο. Στείλτε ή αφαιρέστε μερικά πριν επισυνάψετε άλλα· όσα βρίσκονται σε συνομιλία που δεν ανοίγετε πια πρέπει να τα καθαρίσει ο διαχειριστής της εγκατάστασης.",
  "No such attachment.": "Δεν υπάρχει τέτοιο συνημμένο.",
  "That attachment could not be read just now. Try again.":
    "Δεν ήταν δυνατή η ανάγνωση του συνημμένου αυτή τη στιγμή. Δοκιμάστε ξανά.",
  "That attachment could not be withdrawn just now. Try again.":
    "Δεν ήταν δυνατή η απόσυρση του συνημμένου αυτή τη στιγμή. Δοκιμάστε ξανά.",
  "This attachment is already part of a sent message.":
    "Αυτό το συνημμένο ανήκει ήδη σε απεσταλμένο μήνυμα.",
  "Say which colleagues, and what you are asking them.":
    "Πείτε ποιους συναδέλφους και τι τους ζητάτε.",
  "That digital employee is not in this channel.":
    "Αυτός ο ψηφιακός υπάλληλος δεν είναι σε αυτή τη συνομιλία.",
  "Only colleagues in this channel can be asked together. Add them to it first.":
    "Μόνο συνάδελφοι σε αυτή τη συνομιλία μπορούν να ερωτηθούν μαζί. Προσθέστε τους πρώτα.",
  "This could not be sent just now.":
    "Δεν ήταν δυνατή η αποστολή αυτή τη στιγμή.",
  "Channel input must be a JSON object.":
    "Τα δεδομένα της συνομιλίας πρέπει να είναι αντικείμενο JSON.",
  "Agent IDs must be a non-empty array.":
    "Τα αναγνωριστικά ψηφιακών υπαλλήλων πρέπει να είναι μη κενός πίνακας.",
  "Agent IDs must be non-empty strings.":
    "Τα αναγνωριστικά ψηφιακών υπαλλήλων πρέπει να είναι μη κενά κείμενα.",
  "Agent IDs must be unique.":
    "Τα αναγνωριστικά ψηφιακών υπαλλήλων πρέπει να είναι μοναδικά.",
  "Activity must be a JSON object.":
    "Η δραστηριότητα πρέπει να είναι αντικείμενο JSON.",
  "Text is required.": "Το κείμενο είναι υποχρεωτικό.",
  "Agent ID must be a string or null.":
    "Το αναγνωριστικό ψηφιακού υπαλλήλου πρέπει να είναι κείμενο ή null.",
  "Timestamp is required.": "Η χρονοσφραγίδα είναι υποχρεωτική.",
  "Timestamp must be an ISO-8601 date.":
    "Η χρονοσφραγίδα πρέπει να είναι ημερομηνία ISO-8601.",
  "Pin input must be a JSON object.":
    "Τα δεδομένα καρφιτσώματος πρέπει να είναι αντικείμενο JSON.",
  "Pinned must be true or false.": "Το Pinned πρέπει να είναι true ή false.",
  "Title input must be a JSON object.":
    "Τα δεδομένα τίτλου πρέπει να είναι αντικείμενο JSON.",
  "Give the conversation a name.": "Δώστε όνομα στη συνομιλία.",
  "This channel is defined by the deployment package, so it cannot be deleted here.":
    "Αυτή η συνομιλία ορίζεται από το πακέτο της εγκατάστασης, οπότε δεν μπορεί να διαγραφεί από εδώ.",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the sentence quotes a ${NAME} reference as written
  "{filename} refers to ${{name}}, which is not set in this environment.":
    "Το {filename} αναφέρεται στο ${{name}}, το οποίο δεν έχει οριστεί σε αυτό το περιβάλλον.",
  "The request does not say which tool to call.":
    "Το αίτημα δεν λέει ποιο εργαλείο να καλέσει.",
  "The call was held again instead of being made.":
    "Η κλήση κρατήθηκε ξανά αντί να εκτελεστεί.",
  "This deployment has no computer to carry it out on.":
    "Η εγκατάσταση δεν έχει υπολογιστή για να το εκτελέσει.",
  "The request does not say what to do.": "Το αίτημα δεν λέει τι να γίνει.",
  "There is no such approval.": "Δεν υπάρχει τέτοια έγκριση.",
  "An approval id is required.": "Απαιτείται αναγνωριστικό έγκρισης.",
  "{kind} is not a change anybody can be asked to approve.":
    "Το {kind} δεν είναι αλλαγή για την οποία μπορεί να ζητηθεί έγκριση.",
  "You already have {waiting} requests waiting for a decision. Wait for those before asking for more.":
    "Έχετε ήδη {waiting} αιτήματα που περιμένουν απόφαση. Περιμένετε αυτά πριν ζητήσετε άλλα.",
  "Nothing applies a {kind}.": "Τίποτα δεν εφαρμόζει {kind}.",
  "{label} is missing from the request.": "Από το αίτημα λείπει: {label}.",
  "The request does not change anything about the routine.":
    "Το αίτημα δεν αλλάζει τίποτα στη ρουτίνα.",
  "That digital employee is no longer yours to change.":
    "Αυτός ο ψηφιακός υπάλληλος δεν σας ανήκει πια για αλλαγές.",
  "The instructions were replaced.": "Οι οδηγίες αντικαταστάθηκαν.",
  "The instructions were cleared; the role is the whole instruction again.":
    "Οι οδηγίες καθαρίστηκαν· ο ρόλος είναι ξανά όλη η οδηγία.",
  "User preferences could not be found.": "Δεν βρέθηκαν οι προτιμήσεις χρήστη.",
  "User preferences could not be saved.":
    "Δεν ήταν δυνατή η αποθήκευση των προτιμήσεων χρήστη.",
  "The sandbox billing provider takes no money and is refused under NODE_ENV=production.":
    "Ο δοκιμαστικός πάροχος χρέωσης δεν χρεώνει χρήματα και δεν επιτρέπεται με NODE_ENV=production.",
  "The payment service could not be reached. Try again in a minute.":
    "Δεν ήταν δυνατή η σύνδεση με την υπηρεσία πληρωμών. Δοκιμάστε ξανά σε ένα λεπτό.",
  "The payment service refused that. Try again, or contact us.":
    "Η υπηρεσία πληρωμών το απέρριψε. Δοκιμάστε ξανά ή επικοινωνήστε μαζί μας.",
  "That plan cannot be bought online yet. Contact us.":
    "Αυτό το πρόγραμμα δεν αγοράζεται ακόμη ηλεκτρονικά. Επικοινωνήστε μαζί μας.",
  "The payment service gave no checkout page. Try again, or contact us.":
    "Η υπηρεσία πληρωμών δεν έδωσε σελίδα πληρωμής. Δοκιμάστε ξανά ή επικοινωνήστε μαζί μας.",
  "The payment service sent an unexpected address. Contact us.":
    "Η υπηρεσία πληρωμών έστειλε απρόσμενη διεύθυνση. Επικοινωνήστε μαζί μας.",
  "There is no billing page for this account.":
    "Δεν υπάρχει σελίδα χρέωσης για αυτόν τον λογαριασμό.",
  "There is no subscription to cancel.": "Δεν υπάρχει συνδρομή για ακύρωση.",
  "There is no subscription to change.": "Δεν υπάρχει συνδρομή για αλλαγή.",
  "This subscription cannot be changed online. Contact us.":
    "Αυτή η συνδρομή δεν αλλάζει ηλεκτρονικά. Επικοινωνήστε μαζί μας.",
  "That is a live key. Stripe is set up in test mode only for now. Nothing was created.":
    "Αυτό είναι πραγματικό κλειδί. Το Stripe είναι ρυθμισμένο προς το παρόν μόνο σε δοκιμαστική λειτουργία. Δεν δημιουργήθηκε τίποτα.",
  "That is not a Stripe secret key (sk_test_... or rk_test_...). Nothing was created.":
    "Αυτό δεν είναι μυστικό κλειδί Stripe (sk_test_... ή rk_test_...). Δεν δημιουργήθηκε τίποτα.",
  "The API key is not a {value1} key for PADDLE_ENVIRONMENT={environment}. Nothing was created.":
    "Το κλειδί API δεν είναι κλειδί {value1} για PADDLE_ENVIRONMENT={environment}. Δεν δημιουργήθηκε τίποτα.",
  "The notification address must be https.":
    "Η διεύθυνση ειδοποιήσεων πρέπει να είναι https.",
  "No such billing provider.": "Δεν υπάρχει τέτοιος πάροχος χρέωσης.",
  "That checkout is not for this account.":
    "Αυτή η πληρωμή δεν αφορά αυτόν τον λογαριασμό.",
  "This account is not on a trial. Start one first.":
    "Αυτός ο λογαριασμός δεν είναι σε δοκιμαστική περίοδο. Ξεκινήστε μία πρώτα.",
  "Online payment is not available yet. Contact us to start a plan.":
    "Η ηλεκτρονική πληρωμή δεν είναι ακόμη διαθέσιμη. Επικοινωνήστε μαζί μας για να ξεκινήσετε πρόγραμμα.",
  "There is no subscription to charge.": "Δεν υπάρχει συνδρομή για χρέωση.",
  "Usage charges are not set up with the payment service (PADDLE_PRODUCT_CLOUD).":
    "Οι χρεώσεις χρήσης δεν έχουν ρυθμιστεί στην υπηρεσία πληρωμών (PADDLE_PRODUCT_CLOUD).",
  "That is not an amount that can be charged.":
    "Αυτό δεν είναι ποσό που μπορεί να χρεωθεί.",
  "The payment service refused that charge.":
    "Η υπηρεσία πληρωμών απέρριψε τη χρέωση.",
  "Your model connection could not be opened. Open Settings, then Models, and enter its key again.":
    "Δεν ήταν δυνατό να ανοίξει η σύνδεση του μοντέλου σας. Ανοίξτε Ρυθμίσεις, μετά Μοντέλα, και εισαγάγετε ξανά το κλειδί.",
  'Your model connection "{label}" uses a provider that is no longer available. Choose another in Settings, then Models.':
    "Η σύνδεση μοντέλου «{label}» χρησιμοποιεί πάροχο που δεν είναι πλέον διαθέσιμος. Επιλέξτε άλλον στις Ρυθμίσεις, μετά Μοντέλα.",
  "The connection could not be saved.":
    "Δεν ήταν δυνατή η αποθήκευση της σύνδεσης.",
  "Model connections are not available.":
    "Οι συνδέσεις μοντέλων δεν είναι διαθέσιμες.",
  "Too many tests. Wait a minute and try again.":
    "Πάρα πολλοί έλεγχοι. Περιμένετε ένα λεπτό και δοκιμάστε ξανά.",
  "Choose a provider and a model.": "Επιλέξτε πάροχο και μοντέλο.",
  "No such connection.": "Δεν υπάρχει τέτοια σύνδεση.",
  "Those changes are not valid.": "Αυτές οι αλλαγές δεν είναι έγκυρες.",
  "{name} needs an API key, so it cannot be removed.":
    "Το {name} χρειάζεται κλειδί API, οπότε δεν μπορεί να αφαιρεθεί.",
  "Choose one of your models, or the default.":
    "Επιλέξτε ένα από τα μοντέλα σας ή την προεπιλογή.",
  "No such digital employee.": "Δεν υπάρχει τέτοιος ψηφιακός υπάλληλος.",
  "Choose a provider to test.": "Επιλέξτε πάροχο για έλεγχο.",
  "This deployment will not contact that model address.":
    "Η εγκατάσταση δεν θα επικοινωνήσει με αυτή τη διεύθυνση μοντέλου.",
  "The starter model is not answering right now. Try again in a minute, or add your own model in Settings, then Models.":
    "Το αρχικό μοντέλο δεν απαντά αυτή τη στιγμή. Δοκιμάστε ξανά σε ένα λεπτό ή προσθέστε δικό σας μοντέλο στις Ρυθμίσεις, μετά Μοντέλα.",
  "Could not reach {providerName}. Check the connection in Settings, then Models.":
    "Δεν ήταν δυνατή η σύνδεση με {providerName}. Ελέγξτε τη σύνδεση στις Ρυθμίσεις, μετά Μοντέλα.",
  "{name} refused the key. Check that it is correct and still active.":
    "Το {name} απέρριψε το κλειδί. Ελέγξτε ότι είναι σωστό και ενεργό.",
  "{name} did not recognise that address. Check it ends where the provider says (often /v1).":
    "Το {name} δεν αναγνώρισε τη διεύθυνση. Ελέγξτε ότι τελειώνει όπως ορίζει ο πάροχος (συχνά /v1).",
  "{name} says you have used your allowance for now. Try again shortly.":
    "Το {name} λέει ότι εξαντλήσατε το όριό σας προς το παρόν. Δοκιμάστε ξανά σε λίγο.",
  "{name} had a problem on its side ({status}). Try again shortly.":
    "Το {name} είχε πρόβλημα από τη μεριά του ({status}). Δοκιμάστε ξανά σε λίγο.",
  "{name} sent back far more than a list of models, so it was ignored.":
    "Το {name} έστειλε πολύ περισσότερα από μια λίστα μοντέλων, οπότε αγνοήθηκε.",
  "That address answered, but not like {name}. Check the address.":
    "Η διεύθυνση απάντησε, αλλά όχι όπως το {name}. Ελέγξτε τη διεύθυνση.",
  "That address answered, but not with a list of models. Check the address.":
    "Η διεύθυνση απάντησε, αλλά όχι με λίστα μοντέλων. Ελέγξτε τη διεύθυνση.",
  "{name} did not answer within {value2} seconds.":
    "Το {name} δεν απάντησε μέσα σε {value2} δευτερόλεπτα.",
  "Could not reach {name} at {baseUrl}. {name3} is a program you install and start yourself on this computer, and nothing answered there. Start it, or check the address.":
    "Δεν ήταν δυνατή η σύνδεση με {name} στο {baseUrl}. Το {name3} είναι πρόγραμμα που εγκαθιστάτε και ξεκινάτε μόνοι σας σε αυτόν τον υπολογιστή, και δεν απάντησε τίποτα εκεί. Ξεκινήστε το ή ελέγξτε τη διεύθυνση.",
  "Could not reach {name}. Check the address, and that the server is running.":
    "Δεν ήταν δυνατή η σύνδεση με {name}. Ελέγξτε τη διεύθυνση και ότι ο διακομιστής λειτουργεί.",
  "You are in more than one channel with me — {nameThem}. Say which one.":
    "Είστε σε περισσότερες από μία συνομιλίες μαζί μου — {nameThem}. Πείτε ποια.",
  "Invalid dictation request.": "Μη έγκυρο αίτημα υπαγόρευσης.",
  "Dictation is not configured.": "Η υπαγόρευση δεν έχει ρυθμιστεί.",
  "Recordings must be smaller than 10 MiB.":
    "Οι ηχογραφήσεις πρέπει να είναι μικρότερες από 10 MiB.",
  "An audio recording is required.": "Απαιτείται ηχογράφηση.",
  "This recording format is not supported. Use WebM, MP4, or WAV audio.":
    "Αυτή η μορφή ηχογράφησης δεν υποστηρίζεται. Χρησιμοποιήστε ήχο WebM, MP4 ή WAV.",
  "No speech was detected. Try recording again.":
    "Δεν εντοπίστηκε ομιλία. Δοκιμάστε να ηχογραφήσετε ξανά.",
  "Transcription timed out or was cancelled. Please retry.":
    "Η μεταγραφή έληξε ή ακυρώθηκε. Δοκιμάστε ξανά.",
  "The transcription service could not be reached. Please retry.":
    "Δεν ήταν δυνατή η σύνδεση με την υπηρεσία μεταγραφής. Δοκιμάστε ξανά.",
  "The transcription service is busy. Please retry shortly.":
    "Η υπηρεσία μεταγραφής είναι απασχολημένη. Δοκιμάστε ξανά σε λίγο.",
  "The transcription service could not process this recording. Retry or contact your administrator.":
    "Η υπηρεσία μεταγραφής δεν μπόρεσε να επεξεργαστεί την ηχογράφηση. Δοκιμάστε ξανά ή επικοινωνήστε με τον διαχειριστή.",
  "The transcription service returned an invalid response. Please retry.":
    "Η υπηρεσία μεταγραφής έδωσε μη έγκυρη απάντηση. Δοκιμάστε ξανά.",
  'Query parameter "from" must be a valid date.':
    "Η παράμετρος «from» πρέπει να είναι έγκυρη ημερομηνία.",
  'Query parameter "to" must be a valid date.':
    "Η παράμετρος «to» πρέπει να είναι έγκυρη ημερομηνία.",
  "The private model credential path is not valid.":
    "Η διαδρομή του ιδιωτικού διαπιστευτηρίου μοντέλου δεν είναι έγκυρη.",
  "The private model credential path changed while opening.":
    "Η διαδρομή του ιδιωτικού διαπιστευτηρίου μοντέλου άλλαξε κατά το άνοιγμα.",
  "The private model credential file is not valid.":
    "Το αρχείο ιδιωτικού διαπιστευτηρίου μοντέλου δεν είναι έγκυρο.",
  "The Google model quota project is missing.":
    "Λείπει το έργο ποσόστωσης του μοντέλου Google.",
  "The model OAuth file must be absolute.":
    "Το αρχείο OAuth του μοντέλου πρέπει να έχει απόλυτη διαδρομή.",
  "The local model sign-in is unavailable. Sign in again.":
    "Η σύνδεση του τοπικού μοντέλου δεν είναι διαθέσιμη. Συνδεθείτε ξανά.",
  "The local model proxy requires authentication.":
    "Ο τοπικός διαμεσολαβητής μοντέλου απαιτεί ταυτοποίηση.",
  "The model request body could not be read.":
    "Δεν ήταν δυνατή η ανάγνωση του αιτήματος προς το μοντέλο.",
  "The model credential store is busy or unavailable. Try again.":
    "Ο χώρος διαπιστευτηρίων μοντέλου είναι απασχολημένος ή μη διαθέσιμος. Δοκιμάστε ξανά.",
  "The model sign-in could not be refreshed. Sign in again.":
    "Δεν ήταν δυνατή η ανανέωση της σύνδεσης του μοντέλου. Συνδεθείτε ξανά.",
  "The Google model request has unsupported or invalid content.":
    "Το αίτημα προς το μοντέλο Google έχει μη υποστηριζόμενο ή μη έγκυρο περιεχόμενο.",
  "The model provider rejected the request (HTTP {status}).":
    "Ο πάροχος του μοντέλου απέρριψε το αίτημα (HTTP {status}).",
  "The model provider needs you to sign in again.":
    "Ο πάροχος του μοντέλου χρειάζεται να συνδεθείτε ξανά.",
  "The model provider could not be reached.":
    "Δεν ήταν δυνατή η σύνδεση με τον πάροχο του μοντέλου.",
  "That request is too large.": "Το αίτημα είναι πολύ μεγάλο.",
  "This request came from another website.":
    "Το αίτημα προήλθε από άλλον ιστότοπο.",
  "Permitted by policy.": "Επιτρέπεται από την πολιτική.",
  "No rule in this deployment's policy permits that action, so it was refused.":
    "Κανένας κανόνας της πολιτικής της εγκατάστασης δεν επιτρέπει αυτή την ενέργεια, οπότε απορρίφθηκε.",
  "An administrator can add one.": "Ο διαχειριστής μπορεί να προσθέσει έναν.",
  "Your own browser answered {status}.":
    "Ο δικός σας περιηγητής απάντησε {status}.",
  "This deployment is not running in the desktop app.":
    "Αυτή η εγκατάσταση δεν λειτουργεί στην εφαρμογή υπολογιστή.",
  "Desktop authentication failed.":
    "Η ταυτοποίηση της εφαρμογής υπολογιστή απέτυχε.",
  "Send { url } or { url: null }.": "Στείλτε { url } ή { url: null }.",
  "The person's browser is driven from this computer's loopback address and nowhere else.":
    "Ο περιηγητής σας ελέγχεται μόνο από τη διεύθυνση loopback αυτού του υπολογιστή και από πουθενά αλλού.",
  "Send { use: true } or { use: false }.":
    "Στείλτε { use: true } ή { use: false }.",
  "That digital employee is not available to you.":
    "Αυτός ο ψηφιακός υπάλληλος δεν είναι διαθέσιμος για εσάς.",
  "The text to enter is required.":
    "Το κείμενο για καταχώριση είναι υποχρεωτικό.",
  "Say which field the value goes in, using a ref from your snapshot.":
    "Πείτε σε ποιο πεδίο μπαίνει η τιμή, με ref από το στιγμιότυπό σας.",
  "The snapshotId the ref came from is required.":
    "Απαιτείται το snapshotId από το οποίο προήλθε το ref.",
  "The contents to write are required.":
    "Το περιεχόμενο προς εγγραφή είναι υποχρεωτικό.",
  "That rule could not be saved, so it has not been applied. The previous boundary is still in force.":
    "Ο κανόνας δεν αποθηκεύτηκε, οπότε δεν εφαρμόστηκε. Ισχύει ακόμη το προηγούμενο όριο.",
  "This deployment records no readable trail, so there is no history to test against.":
    "Αυτή η εγκατάσταση δεν καταγράφει αναγνώσιμο ιστορικό, οπότε δεν υπάρχει κάτι για δοκιμή.",
  "Something went wrong.": "Κάτι πήγε στραβά.",
  "That address holds this deployment's own cloud credentials, so it is never called as a computer.":
    "Αυτή η διεύθυνση περιέχει τα διαπιστευτήρια νέφους της εγκατάστασης, οπότε δεν καλείται ποτέ ως υπολογιστής.",
  "That is not a web address.": "Αυτή δεν είναι διεύθυνση ιστού.",
  "Only web addresses are allowed, and that one is {value1}.":
    "Επιτρέπονται μόνο διευθύνσεις ιστού, και αυτή είναι {value1}.",
  "That address holds this deployment's own cloud credentials, so the assistant is never allowed to open it.":
    "Αυτή η διεύθυνση περιέχει τα διαπιστευτήρια νέφους της εγκατάστασης, οπότε ο βοηθός δεν επιτρέπεται ποτέ να την ανοίξει.",
  "That address is inside this deployment's own network, so the assistant is not allowed to open it.":
    "Αυτή η διεύθυνση είναι μέσα στο δίκτυο της εγκατάστασης, οπότε ο βοηθός δεν επιτρέπεται να την ανοίξει.",
  "Approved by a person.": "Εγκρίθηκε από άνθρωπο.",
  "{ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.":
    "Το {ref} δεν υπάρχει στη σελίδα που δείχνει αυτός ο υπολογιστής, οπότε δεν μπορεί να ελεγχθεί πριν από την ενέργεια. Πάρτε νέο στιγμιότυπο και χρησιμοποιήστε τα refs του.",
  "{label} (into {ref})": "{label} (στο {ref})",
  "The action was stopped.": "Η ενέργεια διακόπηκε.",
  "The assistant's computer did not respond in time.":
    "Ο υπολογιστής του βοηθού δεν απάντησε εγκαίρως.",
  "The assistant's computer is not running.":
    "Ο υπολογιστής του βοηθού δεν λειτουργεί.",
  "{value1} not on the page any more. Take a fresh snapshot and use the refs from it.":
    "{value1} δεν υπάρχει πια στη σελίδα. Πάρτε νέο στιγμιότυπο και χρησιμοποιήστε τα refs του.",
  "The computer feature is off. No computer provider is configured.":
    "Η λειτουργία υπολογιστή είναι ανενεργή. Δεν έχει ρυθμιστεί πάροχος υπολογιστή.",
  "Each digital employee gets its own isolated computer with its own /workspace and browser profile.":
    "Κάθε ψηφιακός υπάλληλος έχει δικό του απομονωμένο υπολογιστή με δικό του /workspace και προφίλ περιηγητή.",
  "The shared computer at {base} could not be reached ({value2}).":
    "Δεν ήταν δυνατή η σύνδεση με τον κοινό υπολογιστή στο {base} ({value2}).",
  "The shared computer answered {status}.":
    "Ο κοινός υπολογιστής απάντησε {status}.",
  "{key} must be a list of expressions.":
    "Το {key} πρέπει να είναι λίστα εκφράσεων.",
  "That is not a notification subscription.":
    "Αυτή δεν είναι συνδρομή ειδοποιήσεων.",
  "That address is not one this server sends notifications to.":
    "Σε αυτή τη διεύθυνση ο διακομιστής δεν στέλνει ειδοποιήσεις.",
  "Say which device to stop notifying.":
    "Πείτε ποια συσκευή να σταματήσει να ειδοποιείται.",
  "Wait a few seconds and try again.":
    "Περιμένετε λίγα δευτερόλεπτα και δοκιμάστε ξανά.",
  "The Google model stream failed.": "Η ροή του μοντέλου Google απέτυχε.",
  "That looks like a password, key, card or account number, and those are never kept as memories.":
    "Αυτό μοιάζει με κωδικό, κλειδί, αριθμό κάρτας ή λογαριασμού, και αυτά δεν φυλάσσονται ποτέ ως αναμνήσεις.",
  "Only a digital employee's owner can give it memories.":
    "Μόνο ο κάτοχος ενός ψηφιακού υπαλλήλου μπορεί να του δώσει αναμνήσεις.",
  "Running in the cloud is switched off on this service, so this was not started.":
    "Η λειτουργία στο νέφος είναι ανενεργή σε αυτή την υπηρεσία, οπότε δεν ξεκίνησε.",
  "This digital employee is set to run on your own computer, so it was not started here. Open the Ark desktop app to run it. [Let it run in Ark's cloud instead.]({planPath})":
    "Αυτός ο ψηφιακός υπάλληλος είναι ρυθμισμένος να λειτουργεί στον υπολογιστή σας, οπότε δεν ξεκίνησε εδώ. Ανοίξτε την εφαρμογή Ark για να λειτουργήσει. [Αφήστε τον να λειτουργεί στο νέφος της Ark.]({planPath})",
  "Running in Ark's cloud is not available yet. Run this digital employee on your own computer for now.":
    "Η λειτουργία στο νέφος της Ark δεν είναι ακόμη διαθέσιμη. Προς το παρόν, λειτουργήστε αυτόν τον ψηφιακό υπάλληλο στον υπολογιστή σας.",
  "Running in Ark's cloud is not switched on for this account. [See the prices and switch it on.]({planPath}) You can also run this digital employee on your own computer.":
    "Η λειτουργία στο νέφος της Ark δεν έχει ενεργοποιηθεί για αυτόν τον λογαριασμό. [Δείτε τις τιμές και ενεργοποιήστε την.]({planPath}) Μπορείτε επίσης να λειτουργείτε αυτόν τον ψηφιακό υπάλληλο στον υπολογιστή σας.",
  "The prices for running in Ark's cloud changed, so this was not started. [See the new prices and agree to them.]({planPath}) You can also run this digital employee on your own computer.":
    "Οι τιμές λειτουργίας στο νέφος της Ark άλλαξαν, οπότε δεν ξεκίνησε. [Δείτε τις νέες τιμές και αποδεχτείτε τες.]({planPath}) Μπορείτε επίσης να λειτουργείτε αυτόν τον ψηφιακό υπάλληλο στον υπολογιστή σας.",
  "This month's limit for cloud running has been reached, so this was not started. [Raise the limit.]({planPath}) Otherwise it can run again next month.":
    "Το όριο του μήνα για λειτουργία στο νέφος συμπληρώθηκε, οπότε δεν ξεκίνησε. [Αυξήστε το όριο.]({planPath}) Διαφορετικά μπορεί να λειτουργήσει ξανά τον επόμενο μήνα.",
  "Running in the cloud is not a paid add-on on this service.":
    "Η λειτουργία στο νέφος δεν είναι επί πληρωμή πρόσθετο σε αυτή την υπηρεσία.",
  "Those are not the prices.": "Αυτές δεν είναι οι τιμές.",
  "Choose or fix your plan first: cloud running is charged to your subscription.":
    "Επιλέξτε ή τακτοποιήστε πρώτα το πρόγραμμά σας: η λειτουργία στο νέφος χρεώνεται στη συνδρομή σας.",
  "Switch cloud running on first, then set its limit.":
    "Ενεργοποιήστε πρώτα τη λειτουργία στο νέφος και μετά ορίστε το όριό της.",
  "The month is written 2026-10.": "Ο μήνας γράφεται 2026-10.",
  "That is not a charge status.": "Αυτή δεν είναι κατάσταση χρέωσης.",
  "Say whether it was charged or waived, and why.":
    "Πείτε αν χρεώθηκε ή χαρίστηκε, και γιατί.",
  "No such charge.": "Δεν υπάρχει τέτοια χρέωση.",
  "That month is already final, or does not exist.":
    "Αυτός ο μήνας είναι ήδη οριστικός ή δεν υπάρχει.",
  "Only a month that has ended can be charged.":
    "Μόνο μήνας που έχει τελειώσει μπορεί να χρεωθεί.",
  "User preferences are not available.":
    "Οι προτιμήσεις χρήστη δεν είναι διαθέσιμες.",
  "Choose agent or thread for message list emphasis.":
    "Επιλέξτε ψηφιακό υπάλληλο ή συνομιλία για την έμφαση στη λίστα μηνυμάτων.",
  "Model credential is not configured for {name}. Add the package credential or set {value2}. Or connect your own model in Settings, then Models.":
    "Δεν έχει ρυθμιστεί διαπιστευτήριο μοντέλου για {name}. Προσθέστε το διαπιστευτήριο του πακέτου ή ορίστε {value2}. Ή συνδέστε δικό σας μοντέλο στις Ρυθμίσεις, μετά Μοντέλα.",
  'Mastra endpoint for Bot "{id}" serves no agent named "{wanted}". It serves: {value3}.':
    "Το σημείο Mastra για τον ψηφιακό υπάλληλο «{id}» δεν εξυπηρετεί πράκτορα με όνομα «{wanted}». Εξυπηρετεί: {value3}.",
  "No agents are registered. Add one to the tenant package or the agents table.":
    "Δεν έχουν καταχωριστεί πράκτορες. Προσθέστε έναν στο πακέτο ή στον πίνακα agents.",
  "The conversation service could not be reached.":
    "Δεν ήταν δυνατή η σύνδεση με την υπηρεσία συνομιλιών.",
  "The conversation service refused to list conversations ({status}).":
    "Η υπηρεσία συνομιλιών αρνήθηκε την εμφάνιση των συνομιλιών ({status}).",
  "This person has more conversations than can be handled in one go.":
    "Αυτό το άτομο έχει περισσότερες συνομιλίες από όσες μπορούν να επεξεργαστούν μονομιάς.",
  "The conversation service refused to read a conversation ({status}).":
    "Η υπηρεσία συνομιλιών αρνήθηκε την ανάγνωση μιας συνομιλίας ({status}).",
  "The conversation service refused to remove a conversation ({status}).":
    "Η υπηρεσία συνομιλιών αρνήθηκε τη διαγραφή μιας συνομιλίας ({status}).",
  "Too many requests. Try again later.":
    "Πάρα πολλά αιτήματα. Δοκιμάστε ξανά αργότερα.",
  "Type your email address exactly to confirm.":
    "Πληκτρολογήστε ακριβώς τη διεύθυνση email σας για επιβεβαίωση.",
  "No such person.": "Δεν υπάρχει τέτοιο άτομο.",
  "Type the person's email address exactly to confirm.":
    "Πληκτρολογήστε ακριβώς τη διεύθυνση email του ατόμου για επιβεβαίωση.",
  "Your plan could not be checked just now. Try again in a moment.":
    "Δεν ήταν δυνατός ο έλεγχος του προγράμματός σας αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.",
  "This account cannot run digital employees.":
    "Αυτός ο λογαριασμός δεν μπορεί να λειτουργεί ψηφιακούς υπαλλήλους.",
  "Cloud running could not be checked just now. Try again in a moment.":
    "Δεν ήταν δυνατός ο έλεγχος της λειτουργίας στο νέφος αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.",
  "Plans are not used on this deployment.":
    "Σε αυτή την εγκατάσταση δεν χρησιμοποιούνται προγράμματα.",
  "Choose one of the plans.": "Επιλέξτε ένα από τα προγράμματα.",
  "The last payment did not go through. Update your card from Manage billing, then change your plan.":
    "Η τελευταία πληρωμή δεν ολοκληρώθηκε. Ενημερώστε την κάρτα σας από τη Διαχείριση χρέωσης και μετά αλλάξτε πρόγραμμα.",
  "This plan ends at the end of the period. Choose it again once it has ended.":
    "Αυτό το πρόγραμμα λήγει στο τέλος της περιόδου. Επιλέξτε το ξανά αφού λήξει.",
  "You are already on that plan.": "Είστε ήδη σε αυτό το πρόγραμμα.",
  "There is no billing page for this account yet.":
    "Δεν υπάρχει ακόμη σελίδα χρέωσης για αυτόν τον λογαριασμό.",
  "Contact us to cancel this account.":
    "Επικοινωνήστε μαζί μας για να ακυρώσετε αυτόν τον λογαριασμό.",
  "Choose a plan that exists.": "Επιλέξτε πρόγραμμα που υπάρχει.",
  "No such account.": "Δεν υπάρχει τέτοιος λογαριασμός.",
  "This account is suspended. Contact support to restore it.":
    "Αυτός ο λογαριασμός είναι σε αναστολή. Επικοινωνήστε με την υποστήριξη για επαναφορά.",
  "Your subscription has ended. Choose a plan to start your digital employees again.":
    "Η συνδρομή σας έληξε. Επιλέξτε πρόγραμμα για να ξεκινήσουν ξανά οι ψηφιακοί σας υπάλληλοι.",
  "Choose a plan to start your digital employees.":
    "Επιλέξτε πρόγραμμα για να ξεκινήσουν οι ψηφιακοί σας υπάλληλοι.",
  "Your {FREE_TRIAL_DAYS}-day trial ended on {value2}. Your conversations and settings are kept. Choose a plan to start your digital employees again.":
    "Η δοκιμαστική σας περίοδος {FREE_TRIAL_DAYS} ημερών έληξε στις {value2}. Οι συνομιλίες και οι ρυθμίσεις σας διατηρούνται. Επιλέξτε πρόγραμμα για να ξεκινήσουν ξανά οι ψηφιακοί σας υπάλληλοι.",
  "No such person to make an account for.":
    "Δεν υπάρχει τέτοιο άτομο για δημιουργία λογαριασμού.",
  "The account could not be created.":
    "Δεν ήταν δυνατή η δημιουργία του λογαριασμού.",
  "This account has no subscription record.":
    "Αυτός ο λογαριασμός δεν έχει εγγραφή συνδρομής.",
  "Give the number with its country code, for example +30 69 1234 5678.":
    "Δώστε τον αριθμό με τον κωδικό χώρας, για παράδειγμα +30 69 1234 5678.",
  "Choose a PIN of 4 to 8 digits.": "Επιλέξτε PIN 4 έως 8 ψηφίων.",
  "Give a number, a PIN and employees.":
    "Δώστε αριθμό, PIN και ψηφιακούς υπαλλήλους.",
  "No such call.": "Δεν υπάρχει τέτοια κλήση.",
  "Press digits, * or #.": "Πατήστε ψηφία, * ή #.",
  "No credential was available for this call.":
    "Δεν υπήρχε διαθέσιμο διαπιστευτήριο για αυτή την κλήση.",
  "Gmail did not answer in time.": "Το Gmail δεν απάντησε εγκαίρως.",
  "Gmail answered with something unreadable.":
    "Το Gmail απάντησε με κάτι μη αναγνώσιμο.",
  "{toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.":
    "Το {toolName} δεν είναι εργαλείο αυτής της σύνδεσης. Η αποθηκευμένη λίστα εργαλείων είναι παλιά· ανανεώστε την στη σελίδα Πρόσθετα.",
  "{field} must be one or more email addresses.":
    "Το {field} πρέπει να είναι μία ή περισσότερες διευθύνσεις email.",
  "Microsoft 365 did not answer in time.":
    "Το Microsoft 365 δεν απάντησε εγκαίρως.",
  "The tool returned no content. Nothing was found, so there is nothing here to answer from.":
    "Το εργαλείο δεν επέστρεψε περιεχόμενο. Δεν βρέθηκε τίποτα, οπότε δεν υπάρχει βάση για απάντηση.",
  "The end has to be after the start.":
    "Το τέλος πρέπει να είναι μετά την αρχή.",
  "Name one tool.": "Ονομάστε ένα εργαλείο.",
  "The vendor rejected this credential (401). For a connector reached as the person asking, reconnecting the account is the usual fix; if it persists, the scopes it was granted may not cover this server.":
    "Ο πάροχος απέρριψε το διαπιστευτήριο (401). Για σύνδεση που γίνεται ως το άτομο που ρωτά, η επανασύνδεση του λογαριασμού συνήθως το διορθώνει· αν συνεχίζεται, τα δικαιώματα που δόθηκαν ίσως δεν καλύπτουν αυτόν τον διακομιστή.",
  "The vendor accepted the credential and refused the request (403). The account may lack access, or the API may not be enabled for this project.":
    "Ο πάροχος δέχτηκε το διαπιστευτήριο και απέρριψε το αίτημα (403). Ο λογαριασμός ίσως δεν έχει πρόσβαση ή το API ίσως δεν είναι ενεργό για αυτό το έργο.",
  "The vendor answered {status}.": "Ο πάροχος απάντησε {status}.",
  "Files in the Drive of whoever is asking.":
    "Αρχεία στο Drive του ατόμου που ρωτά.",
  "The mailbox of whoever is asking: search and read, and send a message once they approve it.":
    "Το γραμματοκιβώτιο του ατόμου που ρωτά: αναζήτηση και ανάγνωση, και αποστολή μηνύματος αφού το εγκρίνει.",
  "Pages and databases of whoever is asking.":
    "Σελίδες και βάσεις δεδομένων του ατόμου που ρωτά.",
  "Outlook mail, the calendar, Teams chats and SharePoint and OneDrive files of whoever is asking.":
    "Αλληλογραφία Outlook, ημερολόγιο, συζητήσεις Teams και αρχεία SharePoint και OneDrive του ατόμου που ρωτά.",
  "Standing instructions a digital employee runs on a schedule, as whoever scheduled them.":
    "Μόνιμες οδηγίες που εκτελεί ένας ψηφιακός υπάλληλος με πρόγραμμα, ως το άτομο που τις προγραμμάτισε.",
  "That is not a URL.": "Αυτό δεν είναι URL.",
  "Put the credential in the token field rather than in the address.":
    "Βάλτε το διαπιστευτήριο στο πεδίο token και όχι στη διεύθυνση.",
  "Google Drive did not answer in time.":
    "Το Google Drive δεν απάντησε εγκαίρως.",
  "Google Drive refused this request ({status}).":
    "Το Google Drive αρνήθηκε το αίτημα ({status}).",
  "{value1} is a shortcut that does not name a file.":
    "Το {value1} είναι συντόμευση που δεν οδηγεί σε αρχείο.",
  "{value1} is a {value2} file, which this connector cannot read as text. Its metadata and link are available, and somebody can open it themselves.":
    "Το {value1} είναι αρχείο {value2}, που αυτή η σύνδεση δεν μπορεί να διαβάσει ως κείμενο. Τα μεταδεδομένα και ο σύνδεσμός του είναι διαθέσιμα, και κάποιος μπορεί να το ανοίξει μόνος του.",
  "This deployment built no address for Composio to send you back to, so the connection was not begun rather than begun with nowhere to land. Set OPENBOT_APP_URL to the address this deployment's pages are served from, and connecting an app will have a return leg.":
    "Η εγκατάσταση δεν έχει διεύθυνση επιστροφής από τη Composio, οπότε η σύνδεση δεν ξεκίνησε αντί να ξεκινήσει χωρίς προορισμό. Ορίστε το OPENBOT_APP_URL στη διεύθυνση της εγκατάστασης για να υπάρχει επιστροφή.",
  "The address Composio would send you back to is not a web address, so a consent granted there would end on Composio's own page with no way back here. Set OPENBOT_APP_URL to this deployment's own origin including the scheme — https://openbot.example.com rather than openbot.example.com.":
    "Η διεύθυνση επιστροφής από τη Composio δεν είναι διεύθυνση ιστού, οπότε η συναίνεση θα τελείωνε στη σελίδα της Composio χωρίς επιστροφή. Ορίστε το OPENBOT_APP_URL με το πλήρες origin, μαζί με το σχήμα — https://openbot.example.com αντί για openbot.example.com.",
  "{value1} needs an OAuth application registered by whoever runs this deployment, and this deployment holds no place to put its own OAuth client for a brokered app.":
    "Το {value1} χρειάζεται εφαρμογή OAuth καταχωρισμένη από τον διαχειριστή της εγκατάστασης, και η εγκατάσταση δεν έχει θέση για δικό της πελάτη OAuth σε εφαρμογή μέσω μεσάζοντα.",
  "Composio published no authentication scheme for this app, so there is no flow this deployment could run, and its own OAuth client is not something this deployment can register.":
    "Η Composio δεν δημοσίευσε τρόπο ταυτοποίησης για αυτή την εφαρμογή, οπότε δεν υπάρχει ροή για εκτέλεση, και η εγκατάσταση δεν μπορεί να καταχωρίσει δικό της πελάτη OAuth.",
  "Composio answered the withdrawal of one of this person's {toolkit} accounts with success: false, so it did not delete the account and started no revocation of the grant behind it. Nothing was asked of the provider for that account, whatever this deployment would otherwise have recorded. Disconnecting again asks Composio for it a second time.":
    "Η Composio απάντησε στην απόσυρση ενός λογαριασμού {toolkit} του ατόμου με success: false, οπότε δεν τον διέγραψε και δεν ανακάλεσε την άδεια. Δεν ζητήθηκε τίποτα από τον πάροχο για αυτόν τον λογαριασμό. Μια νέα αποσύνδεση το ζητά ξανά από τη Composio.",
  "Composio answered that this person already holds a connected account for {app}, so {outcome}. That is a settled state at Composio rather than a moment that passes — asking again meets the same answer — and what clears it is disconnecting the account they already hold, on this deployment's Connected accounts page, before another is attached.":
    "Η Composio απάντησε ότι αυτό το άτομο έχει ήδη συνδεδεμένο λογαριασμό για {app}, οπότε {outcome}. Είναι μόνιμη κατάσταση στη Composio — μια νέα προσπάθεια φέρνει την ίδια απάντηση — και διορθώνεται αποσυνδέοντας τον υπάρχοντα λογαριασμό από τη σελίδα Συνδεδεμένοι λογαριασμοί πριν προστεθεί άλλος.",
  "Composio refused account-sharing rules on an account that is not a shared one, so {outcome}. This deployment attaches every account to one person and asks for no sharing, so the rules are on the authorization config rather than on anything sent from here: an operator changing how {app} is shared in Composio's own dashboard is what clears it.":
    "Η Composio αρνήθηκε κανόνες κοινής χρήσης σε λογαριασμό που δεν είναι κοινόχρηστος, οπότε {outcome}. Η εγκατάσταση δίνει κάθε λογαριασμό σε ένα άτομο χωρίς κοινή χρήση, οπότε οι κανόνες βρίσκονται στις ρυθμίσεις ταυτοποίησης: διορθώνεται αλλάζοντας πώς μοιράζεται το {app} στον πίνακα της Composio.",
  "Composio would not mint a connect link for {app} and said nothing about why, so {outcome}. Nobody was sent to a consent screen and no consent was spent. This deployment's key and its authorization config for the app were both read through successfully moments earlier, so neither of those is what to check; Composio's status page is.":
    "Η Composio δεν δημιούργησε σύνδεσμο σύνδεσης για {app} χωρίς να πει γιατί, οπότε {outcome}. Κανείς δεν στάλθηκε σε οθόνη συναίνεσης. Το κλειδί και οι ρυθμίσεις ταυτοποίησης διαβάστηκαν κανονικά λίγο πριν, οπότε δεν είναι αυτά που πρέπει να ελεγχθούν· ελέγξτε τη σελίδα κατάστασης της Composio.",
  "This deployment's @composio/core refused the request or Composio's answer against its own schema, so {outcome} — either before Composio was asked or after it had replied. Nothing an operator can set corrects that and the key is not what to check: upgrading this deployment's @composio/core is what fixes it.":
    "Το @composio/core της εγκατάστασης απέρριψε το αίτημα ή την απάντηση της Composio, οπότε {outcome} — πριν ρωτηθεί η Composio ή αφού απάντησε. Δεν διορθώνεται από ρυθμίσεις και δεν φταίει το κλειδί: διορθώνεται με αναβάθμιση του @composio/core.",
  "The request was cancelled before Composio answered, so {outcome} as far as this deployment can tell — and how far it had got when the cancellation landed is exactly what it cannot tell. Nothing is wrong at Composio and nothing needs setting here; asking for it again is what settles which of the two it was.":
    "Το αίτημα ακυρώθηκε πριν απαντήσει η Composio, οπότε {outcome} όσο μπορεί να ξέρει η εγκατάσταση — και πόσο είχε προχωρήσει δεν είναι γνωστό. Δεν φταίει η Composio ούτε χρειάζεται ρύθμιση· μια νέα προσπάθεια ξεκαθαρίζει τι έγινε.",
  "Composio holds no connected account for this person and {app}, so {outcome}. A grant withdrawn at the provider and an account removed in Composio's own dashboard both read exactly like this, and a retry reaches neither: connecting {app3} again on this deployment's Connected accounts page is what restores it.":
    "Η Composio δεν έχει συνδεδεμένο λογαριασμό για αυτό το άτομο και το {app}, οπότε {outcome}. Μια άδεια που ανακλήθηκε στον πάροχο και ένας λογαριασμός που αφαιρέθηκε από τον πίνακα της Composio φαίνονται ακριβώς έτσι, και μια νέα προσπάθεια δεν βοηθά: η επανασύνδεση του {app3} στη σελίδα Συνδεδεμένοι λογαριασμοί το αποκαθιστά.",
  'Composio refuses a call whose toolkit version is "latest", and that is the version travelling with this one, so {outcome}. A dated version is recorded when an app\'s actions are listed, so refreshing {app}\'s tools on its Plugins page replaces "latest" with a version Composio will accept.':
    "Η Composio αρνείται κλήσεις με έκδοση εργαλείων «latest», και αυτή είναι η έκδοση αυτής της κλήσης, οπότε {outcome}. Η ανανέωση των εργαλείων του {app} στη σελίδα Πρόσθετα αντικαθιστά το «latest» με έκδοση που δέχεται η Composio.",
  "Composio refused {length} of the requests this call made.":
    "Η Composio απέρριψε {length} από τα αιτήματα αυτής της κλήσης.",
  "{slug} was not sent to Composio: this connection is for {toolkit}, and Composio resolves that action to {value3}. Refreshing this app's tools on its Plugins page recovers it where the action was recorded against a url that has since changed.":
    "Το {slug} δεν στάλθηκε στη Composio: η σύνδεση αφορά το {toolkit}, και η Composio αντιστοιχίζει την ενέργεια στο {value3}. Η ανανέωση των εργαλείων στη σελίδα Πρόσθετα το διορθώνει όπου η διεύθυνση έχει αλλάξει.",
  "This deployment has no authorization config at Composio for {toolkit}, so there is nothing to connect an account against. An administrator removing the app on its Plugins page and adding it again creates one.":
    "Η εγκατάσταση δεν έχει ρυθμίσεις ταυτοποίησης στη Composio για το {toolkit}, οπότε δεν υπάρχει κάτι για σύνδεση. Η αφαίρεση και εκ νέου προσθήκη της εφαρμογής από τον διαχειριστή στη σελίδα Πρόσθετα δημιουργεί μία.",
  "Composio began a connection to {toolkit} but answered with no page to visit, so there is nothing to send this person to. An app that is connected by entering a credential rather than by visiting a page cannot be connected from here.":
    "Η Composio ξεκίνησε σύνδεση με το {toolkit} αλλά δεν έδωσε σελίδα, οπότε δεν υπάρχει πού να σταλεί το άτομο. Μια εφαρμογή που συνδέεται με καταχώριση διαπιστευτηρίου και όχι με επίσκεψη σε σελίδα δεν συνδέεται από εδώ.",
  "Composio no longer publishes a {authScheme} connection for {toolkit}, and {toolkit3}'s authorization config here was created as {authScheme4}, so there is nothing to ask this person for — and an empty form is a box they cannot fill in and a connection carrying no credential at all. An administrator removing the app on its Plugins page and adding it again is what records the scheme Composio publishes for it now.":
    "Η Composio δεν δημοσιεύει πλέον σύνδεση {authScheme} για το {toolkit}, ενώ οι ρυθμίσεις του {toolkit3} εδώ δημιουργήθηκαν ως {authScheme4}, οπότε δεν υπάρχει τι να ζητηθεί από το άτομο. Η αφαίρεση και εκ νέου προσθήκη της εφαρμογής από τον διαχειριστή στη σελίδα Πρόσθετα καταγράφει τον τρόπο που δημοσιεύει τώρα η Composio.",
  "{toolkit} asks for {value2} as {sent} under the name {sent4}, which cannot be filled in here: a box this deployment can draw is a string, and a box whose answer can be sent back has a name. Connecting this app is not something this deployment can offer yet.":
    "Το {toolkit} ζητά {value2} ως {sent} με το όνομα {sent4}, που δεν μπορεί να συμπληρωθεί εδώ. Η σύνδεση αυτής της εφαρμογής δεν είναι ακόμη διαθέσιμη σε αυτή την εγκατάσταση.",
  "This deployment has no authorization config at Composio for {toolkit}, so there is nothing to connect an account against and nothing was sent. An administrator removing the app on its Plugins page and adding it again creates one.":
    "Η εγκατάσταση δεν έχει ρυθμίσεις ταυτοποίησης στη Composio για το {toolkit}, οπότε δεν υπάρχει κάτι για σύνδεση και δεν στάλθηκε τίποτα. Η αφαίρεση και εκ νέου προσθήκη της εφαρμογής από τον διαχειριστή στη σελίδα Πρόσθετα δημιουργεί μία.",
  "Composio did not accept the connection to {toolkit} and said nothing this deployment can pass on. The failure arrived through this deployment's @composio/core with no sentence of Composio's on it, which is what an outage, a cancelled request and a reply the package could not read all look like from here — and the failure itself was dropped rather than recorded, because on this one call the object carrying it also carries what was typed into the form. Nothing was attached. Composio's own dashboard logs the attempt, and asking again is what settles whether the request ever landed.":
    "Η Composio δεν δέχτηκε τη σύνδεση με το {toolkit} και δεν είπε κάτι που μπορεί να μεταφερθεί. Μπορεί να είναι διακοπή υπηρεσίας, ακυρωμένο αίτημα ή απάντηση που δεν διαβάστηκε· η αποτυχία δεν καταγράφηκε, γιατί περιείχε ό,τι πληκτρολογήθηκε στη φόρμα. Δεν συνδέθηκε τίποτα. Ο πίνακας της Composio καταγράφει την προσπάθεια, και μια νέα προσπάθεια ξεκαθαρίζει αν έφτασε ποτέ το αίτημα.",
  "Composio refused the connection to {toolkit}: {said} Nothing was attached. Nothing further about this attempt is kept here, because what the failure carried was the value typed into the form — the request id in Composio's own words above is what their dashboard searches on.":
    "Η Composio αρνήθηκε τη σύνδεση με το {toolkit}: {said} Δεν συνδέθηκε τίποτα. Δεν κρατιέται τίποτα άλλο για την προσπάθεια, γιατί η αποτυχία περιείχε την τιμή της φόρμας — το αναγνωριστικό αιτήματος παραπάνω είναι αυτό που αναζητά ο πίνακας της Composio.",
  "Composio answered the withdrawal of the account this connection just made with success: false, so it did not delete the account and started no revocation of the credential behind it. That account is still standing at Composio and the credential behind it is still live there.":
    "Η Composio απάντησε στην απόσυρση του λογαριασμού που μόλις δημιουργήθηκε με success: false, οπότε δεν τον διέγραψε ούτε ανακάλεσε το διαπιστευτήριο. Ο λογαριασμός και το διαπιστευτήριο παραμένουν ενεργά στη Composio.",
  "An instance host must be a non-empty string.":
    "Ο διακομιστής παρουσίας πρέπει να είναι μη κενό κείμενο.",
  "Removing this app did not finish, and neither this deployment nor Composio said why, so the app is still here rather than gone with grants of its own left live at the vendor. Press Remove again: every account is withdrawn at Composio before anything here is deleted, so repeating it is safe and asks only for what is left. Check this deployment's Composio key if it persists.":
    "Η αφαίρεση της εφαρμογής δεν ολοκληρώθηκε, και ούτε η εγκατάσταση ούτε η Composio είπαν γιατί, οπότε η εφαρμογή παραμένει. Πατήστε ξανά Αφαίρεση: κάθε λογαριασμός αποσύρεται στη Composio πριν διαγραφεί οτιδήποτε εδώ, οπότε η επανάληψη είναι ασφαλής. Ελέγξτε το κλειδί Composio αν συνεχίζεται.",
  "{slug} is not an app Composio lists for this deployment.":
    "Το {slug} δεν είναι εφαρμογή που προσφέρει η Composio σε αυτή την εγκατάσταση.",
  "An app is required.": "Απαιτείται εφαρμογή.",
  "{name} was added, and then could not be read back out of this deployment's own servers — so the row and its trail entry stand, and what is on this page may be missing it. Reload the Plugins page: if {name2} is there it is enabled and there is nothing to redo, and if it is not, adding it again is safe.":
    "Το {name} προστέθηκε, αλλά δεν ήταν δυνατό να διαβαστεί ξανά από τους διακομιστές της εγκατάστασης — η εγγραφή και το ιστορικό της υπάρχουν, αλλά αυτή η σελίδα ίσως δεν το δείχνει. Ανανεώστε τη σελίδα Πρόσθετα: αν το {name2} είναι εκεί, είναι ενεργό· αν όχι, η εκ νέου προσθήκη είναι ασφαλής.",
  "{name} could not be enabled, and Composio said nothing about why. Try again, and check this deployment's Composio key if it persists.":
    "Δεν ήταν δυνατή η ενεργοποίηση του {name}, και η Composio δεν είπε γιατί. Δοκιμάστε ξανά και ελέγξτε το κλειδί Composio αν συνεχίζεται.",
  "You have not connected this account.":
    "Δεν έχετε συνδέσει αυτόν τον λογαριασμό.",
  "You already have an account connected to {title}. Disconnect it first if you want to connect a different one.":
    "Έχετε ήδη λογαριασμό συνδεδεμένο στο {title}. Αποσυνδέστε τον πρώτα αν θέλετε να συνδέσετε άλλον.",
  "{title} needs no account, so there is nothing to connect. A digital employee granted its tools can use it as it is.":
    "Το {title} δεν χρειάζεται λογαριασμό, οπότε δεν υπάρχει κάτι για σύνδεση. Ένας ψηφιακός υπάλληλος με τα εργαλεία του μπορεί να το χρησιμοποιεί ως έχει.",
  "Composio would not say what {title} asks for, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.":
    "Η Composio δεν είπε τι ζητά το {title}, ούτε γιατί. Δοκιμάστε ξανά και ζητήστε από τον διαχειριστή να ελέγξει το κλειδί Composio αν συνεχίζεται.",
  "{title} publishes no boxes to fill in, so there is nothing you could type that would reach it and no account was made. An administrator has to look at how {title2} is set up at Composio; removing it on the Plugins page and adding it again is what records the way Composio connects it now.":
    "Το {title} δεν δημοσιεύει πεδία για συμπλήρωση, οπότε δεν υπάρχει τι να πληκτρολογήσετε και δεν δημιουργήθηκε λογαριασμός. Ο διαχειριστής πρέπει να εξετάσει πώς είναι ρυθμισμένο το {title2} στη Composio· η αφαίρεση και εκ νέου προσθήκη του στη σελίδα Πρόσθετα καταγράφει πώς συνδέεται τώρα.",
  "{title} publishes no box it says has to be filled in — only {optional} — so nothing you could type would be a credential it insists on, and no account was made. An app that genuinely needs none is one Composio publishes as needing no authentication, and {title3} is recorded here as an app whose secret you type. An administrator has to look at how {title4} is set up at Composio; removing it on the Plugins page and adding it again is what records the way Composio connects it now.":
    "Το {title} δεν δημοσιεύει υποχρεωτικό πεδίο — μόνο {optional} — οπότε δεν υπάρχει διαπιστευτήριο που να απαιτεί, και δεν δημιουργήθηκε λογαριασμός. Το {title3} είναι καταγεγραμμένο εδώ ως εφαρμογή με μυστικό που πληκτρολογείτε. Ο διαχειριστής πρέπει να εξετάσει πώς είναι ρυθμισμένο το {title4} στη Composio· η αφαίρεση και εκ νέου προσθήκη του στη σελίδα Πρόσθετα καταγράφει πώς συνδέεται τώρα.",
  "That is not the form {title} publishes, so nothing was sent to Composio. Press Connect again to draw it from what the app asks for now, and fill in the boxes it shows; each one holds text.":
    "Αυτή δεν είναι η φόρμα που δημοσιεύει το {title}, οπότε δεν στάλθηκε τίποτα στη Composio. Πατήστε ξανά Σύνδεση για να εμφανιστεί η τρέχουσα φόρμα και συμπληρώστε τα πεδία της· κάθε πεδίο δέχεται κείμενο.",
  "{title} cannot be connected without {value2}, so nothing was sent to Composio. Fill in every box the form marks required — a box holding only spaces is an empty one — and press Connect again.":
    "Το {title} δεν συνδέεται χωρίς {value2}, οπότε δεν στάλθηκε τίποτα στη Composio. Συμπληρώστε κάθε υποχρεωτικό πεδίο — ένα πεδίο μόνο με κενά θεωρείται άδειο — και πατήστε ξανά Σύνδεση.",
  "{title} could not be connected with what you entered, and Composio said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.":
    "Δεν ήταν δυνατή η σύνδεση του {title} με όσα καταχωρίσατε, και η Composio δεν είπε γιατί. Δοκιμάστε ξανά και ζητήστε από τον διαχειριστή να ελέγξει το κλειδί Composio αν συνεχίζεται.",
  "This deployment cannot tell how {title} connects, so nothing was sent to Composio and no account was made. An administrator has to remove it on the Plugins page and add it again, which records the way Composio connects it now.":
    "Η εγκατάσταση δεν ξέρει πώς συνδέεται το {title}, οπότε δεν στάλθηκε τίποτα στη Composio και δεν δημιουργήθηκε λογαριασμός. Ο διαχειριστής πρέπει να το αφαιρέσει από τη σελίδα Πρόσθετα και να το προσθέσει ξανά.",
  "This deployment has no app URL configured, so Composio would have nowhere to send you back to. Set OPENBOT_APP_URL.":
    "Η εγκατάσταση δεν έχει ρυθμισμένη διεύθυνση εφαρμογής, οπότε η Composio δεν θα είχε πού να σας επιστρέψει. Ορίστε το OPENBOT_APP_URL.",
  "Composio would not begin a connection to {title}, and said nothing about why. Try again, and ask an administrator to check this deployment's Composio key if it persists.":
    "Η Composio δεν ξεκίνησε σύνδεση με το {title} και δεν είπε γιατί. Δοκιμάστε ξανά και ζητήστε από τον διαχειριστή να ελέγξει το κλειδί Composio αν συνεχίζεται.",
  "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.":
    "Η εγκατάσταση δεν έχει δημόσια διεύθυνση, οπότε δεν μπορεί να ολοκληρώσει συναίνεση. Ορίστε το OPENBOT_PUBLIC_URL.",
  "{serverId} is not connected as an individual person.":
    "Το {serverId} δεν συνδέεται ανά άτομο.",
  "{title} has not been added to this deployment yet. An administrator has to add it first.":
    "Το {title} δεν έχει προστεθεί ακόμη σε αυτή την εγκατάσταση. Πρέπει πρώτα να το προσθέσει ο διαχειριστής.",
  "{title} would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.":
    "Το {title} δεν καταχώρισε την εγκατάσταση ή δεν ήταν προσβάσιμο. Δοκιμάστε ξανά και ελέγξτε την κατάσταση του παρόχου αν συνεχίζεται.",
  "{title} has no OAuth client registered yet. An administrator has to add one first.":
    "Το {title} δεν έχει ακόμη καταχωρισμένο πελάτη OAuth. Πρέπει πρώτα να προσθέσει έναν ο διαχειριστής.",
  "That app is not reached through a broker.":
    "Αυτή η εφαρμογή δεν συνδέεται μέσω μεσάζοντα.",
  "Composio would not say whether this account is connected, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Try again, and ask an administrator to check this deployment's Composio key if it persists.":
    "Η Composio δεν είπε αν αυτός ο λογαριασμός είναι συνδεδεμένος, ούτε γιατί, οπότε εμφανίζεται η τελευταία της απάντηση. Δοκιμάστε ξανά και ζητήστε από τον διαχειριστή να ελέγξει το κλειδί Composio αν συνεχίζεται.",
  "Composio would not say whether this connection still works, and gave no reason, so what is shown here is the last answer it gave rather than a fresh one. Press Re-check again, and ask an administrator to check this deployment's Composio key if it persists.":
    "Η Composio δεν είπε αν η σύνδεση λειτουργεί ακόμη, ούτε γιατί, οπότε εμφανίζεται η τελευταία της απάντηση. Πατήστε ξανά Επανέλεγχος και ζητήστε από τον διαχειριστή να ελέγξει το κλειδί Composio αν συνεχίζεται.",
  "Composio would not end this account, and gave no reason. Press Disconnect again: the revoke at Composio runs before anything here is deleted, so repeating it is safe and is the whole recovery. Ask an administrator to check this deployment's Composio key if it persists.":
    "Η Composio δεν τερμάτισε αυτόν τον λογαριασμό, ούτε είπε γιατί. Πατήστε ξανά Αποσύνδεση: η ανάκληση στη Composio γίνεται πριν διαγραφεί οτιδήποτε εδώ, οπότε η επανάληψη είναι ασφαλής. Ζητήστε από τον διαχειριστή να ελέγξει το κλειδί Composio αν συνεχίζεται.",
  "Only an administrator writes a skill for the deployment.":
    "Μόνο ο διαχειριστής γράφει δεξιότητες για την εγκατάσταση.",
  "There is no such skill.": "Δεν υπάρχει τέτοια δεξιότητα.",
  "Global must be true or false when it is present.":
    "Το Global πρέπει να είναι true ή false όταν υπάρχει.",
  "Tools are a list of serverId/toolName references.":
    "Τα εργαλεία είναι λίστα αναφορών serverId/toolName.",
  "An administrator decides which digital employees may reach a tool.":
    "Ο διαχειριστής αποφασίζει ποιοι ψηφιακοί υπάλληλοι έχουν πρόσβαση σε ένα εργαλείο.",
  "{serverId} is not an app this deployment has added, so there is nothing for a digital employee to reach. Add it first, and its tools can be granted then.":
    "Το {serverId} δεν είναι εφαρμογή που έχει προσθέσει η εγκατάσταση, οπότε δεν υπάρχει τίποτα για πρόσβαση. Προσθέστε το πρώτα και μετά δώστε τα εργαλεία του.",
  "An administrator decides which digital employees may hand work to another digital employee.":
    "Ο διαχειριστής αποφασίζει ποιοι ψηφιακοί υπάλληλοι μπορούν να αναθέτουν εργασία σε άλλους.",
  "There is no skill called {ref}.": "Δεν υπάρχει δεξιότητα με το όνομα {ref}.",
  "This digital employee already has a different skill called /{slug}. Take that one off first, or give this one another name.":
    "Αυτός ο ψηφιακός υπάλληλος έχει ήδη άλλη δεξιότητα με το όνομα /{slug}. Αφαιρέστε εκείνη πρώτα ή δώστε άλλο όνομα σε αυτή.",
  'An outcome is "allow", "ask", "refuse", or null for the default.':
    "Το αποτέλεσμα είναι «allow», «ask», «refuse» ή null για την προεπιλογή.",
  "That tool is not configured in a way this deployment can act on. An administrator has to look at the server it belongs to.":
    "Το εργαλείο δεν είναι ρυθμισμένο με τρόπο που μπορεί να χειριστεί η εγκατάσταση. Ο διαχειριστής πρέπει να εξετάσει τον διακομιστή του.",
  "The server did not answer.": "Ο διακομιστής δεν απάντησε.",
  "The schema refers back to itself, so it is not a value JSON can hold.":
    "Το σχήμα αναφέρεται στον εαυτό του, οπότε δεν είναι τιμή που χωρά σε JSON.",
  "The vendor answered this renewal with something other than a token.":
    "Ο πάροχος απάντησε στην ανανέωση με κάτι άλλο από διακριτικό.",
  "The vendor renewed this access with no token.":
    "Ο πάροχος ανανέωσε την πρόσβαση χωρίς διακριτικό.",
  "{title} runs in the account of the person asking, and this run is not attributed to anybody.":
    "Το {title} λειτουργεί στον λογαριασμό του ατόμου που ρωτά, και αυτή η εκτέλεση δεν αποδίδεται σε κανέναν.",
  "{id} resolves to a brokered credential with no Composio app in its url.":
    "Το {id} αντιστοιχεί σε διαπιστευτήριο μεσάζοντα χωρίς εφαρμογή Composio στη διεύθυνσή του.",
  "You have not connected your {title} account. Connect it in Settings and ask again.":
    "Δεν έχετε συνδέσει τον λογαριασμό σας {title}. Συνδέστε τον στις Ρυθμίσεις και ρωτήστε ξανά.",
  "{id} resolves to a per-person credential with no user-oauth catalogue entry.":
    "Το {id} αντιστοιχεί σε προσωπικό διαπιστευτήριο χωρίς καταχώριση user-oauth στον κατάλογο.",
  "{id} answers as the person asking, and this run is not attributed to anybody.":
    "Το {id} απαντά ως το άτομο που ρωτά, και αυτή η εκτέλεση δεν αποδίδεται σε κανέναν.",
  "Your {title} access was withdrawn. Connect it again in Settings.":
    "Η πρόσβασή σας στο {title} ανακλήθηκε. Συνδέστε το ξανά στις Ρυθμίσεις.",
  "{serverId} is not reached with an OAuth client.":
    "Το {serverId} δεν συνδέεται με πελάτη OAuth.",
  "{serverTitle} takes no credential when it is added.":
    "Το {serverTitle} δεν δέχεται διαπιστευτήριο όταν προστίθεται.",
  "That is not a credential this server can use. Add the server's own token instead.":
    "Αυτό δεν είναι διαπιστευτήριο που μπορεί να χρησιμοποιήσει ο διακομιστής. Προσθέστε το δικό του διακριτικό.",
  "{serverId} is a Composio app this deployment has enabled, and people may have connected their accounts to it. Remove the app first — which ends those accounts at Composio — and the name is then free.":
    "Το {serverId} είναι εφαρμογή Composio που έχει ενεργοποιήσει η εγκατάσταση, και ίσως έχουν συνδεθεί λογαριασμοί σε αυτήν. Αφαιρέστε πρώτα την εφαρμογή — που τερματίζει αυτούς τους λογαριασμούς στη Composio — και μετά το όνομα είναι ελεύθερο.",
  "{id} is the name of a server this deployment already knows. Choose another.":
    "Το {id} είναι όνομα διακομιστή που ήδη γνωρίζει η εγκατάσταση. Επιλέξτε άλλο.",
  "Names beginning composio- belong to the Composio apps this deployment enables, so {id} is not a name a server added by URL can take. Choose another.":
    "Τα ονόματα που ξεκινούν με composio- ανήκουν στις εφαρμογές Composio της εγκατάστασης, οπότε το {id} δεν μπορεί να χρησιμοποιηθεί για διακομιστή με διεύθυνση. Επιλέξτε άλλο.",
  "{id} is already here at a different address and holds a credential. Remove it and add it again, with the token the new address is meant to have.":
    "Το {id} υπάρχει ήδη σε άλλη διεύθυνση και έχει διαπιστευτήριο. Αφαιρέστε το και προσθέστε το ξανά, με το διακριτικό της νέας διεύθυνσης.",
  "{slug} is not a name a Composio app can have. An app is named in letters, numbers, underscores and hyphens, because that name is read back out of this row's url to decide which app a call is against.":
    "Το {slug} δεν είναι έγκυρο όνομα εφαρμογής Composio. Μια εφαρμογή ονομάζεται με γράμματα, αριθμούς, κάτω παύλες και παύλες.",
  "{id} resolves to a brokered credential with no app in its url, so there is nothing to ask what it offers.":
    "Το {id} αντιστοιχεί σε διαπιστευτήριο μεσάζοντα χωρίς εφαρμογή στη διεύθυνσή του, οπότε δεν υπάρχει τι να ρωτηθεί.",
  "This app was asked and answered with no actions at all, so the {length} already recorded for it were kept rather than deleted. Check whether it still publishes them, then refresh again.":
    "Η εφαρμογή ρωτήθηκε και δεν απάντησε με καμία ενέργεια, οπότε οι {length} που είχαν καταγραφεί διατηρήθηκαν. Ελέγξτε αν τις δημοσιεύει ακόμη και ανανεώστε ξανά.",
  "No tool by that name has been seen here: {value1}. A skill names tools as serverId/toolName, and the server has to have been refreshed at least once.":
    "Δεν έχει εμφανιστεί εδώ εργαλείο με αυτό το όνομα: {value1}. Μια δεξιότητα αναφέρει εργαλεία ως serverId/toolName, και ο διακομιστής πρέπει να έχει ανανεωθεί τουλάχιστον μία φορά.",
  "There is no such skill to change.":
    "Δεν υπάρχει τέτοια δεξιότητα για αλλαγή.",
  "{toolkit} is not an app this deployment connects with values somebody types, so nothing was sent. Open the app on the Plugins page and connect it the way it asks for; if it is not listed there at all, an administrator has to enable it first.":
    "Το {toolkit} δεν είναι εφαρμογή που συνδέεται με τιμές που πληκτρολογεί κάποιος, οπότε δεν στάλθηκε τίποτα. Ανοίξτε την εφαρμογή στη σελίδα Πρόσθετα και συνδέστε την όπως ζητά· αν δεν εμφανίζεται, πρέπει πρώτα να την ενεργοποιήσει ο διαχειριστής.",
  "{toolkit} was connected, and the check this deployment then ran against it did not come back clean: {sentence} That may be the key, and it may be the app — what came back does not say which — so the account is left standing and recorded as unchecked. Re-check it on the Plugins page once, and if it still will not answer, disconnect it and connect it again with a fresh key.":
    "Το {toolkit} συνδέθηκε, αλλά ο έλεγχος που ακολούθησε δεν βγήκε καθαρός: {sentence} Μπορεί να φταίει το κλειδί ή η εφαρμογή, οπότε ο λογαριασμός παραμένει και καταγράφεται ως μη ελεγμένος. Ξαναελέγξτε τον μία φορά στη σελίδα Πρόσθετα, και αν δεν απαντά, αποσυνδέστε τον και συνδέστε τον ξανά με νέο κλειδί.",
  "{toolkit} is not an app this deployment holds a key for, so there is nothing here to re-check. It was connected at {toolkit2}'s own sign-in screen, and if it has stopped working, disconnecting it on the Plugins page and connecting it again is what fixes it.":
    "Το {toolkit} δεν είναι εφαρμογή για την οποία η εγκατάσταση έχει κλειδί, οπότε δεν υπάρχει κάτι για επανέλεγχο. Συνδέθηκε από την οθόνη σύνδεσης του {toolkit2}· αν σταμάτησε να λειτουργεί, αποσυνδέστε το και συνδέστε το ξανά στη σελίδα Πρόσθετα.",
  "You have no connection to {toolkit} here, so there is nothing to re-check. Connect it on the Plugins page and it will be checked as it is made.":
    "Δεν έχετε σύνδεση με το {toolkit} εδώ, οπότε δεν υπάρχει κάτι για επανέλεγχο. Συνδέστε το στη σελίδα Πρόσθετα και θα ελεγχθεί κατά τη σύνδεση.",
  "{toolkit} could not be checked just now: {sentence} Nothing here changed — your connection is still recorded exactly as the last check left it — so pressing Re-check again when Composio is answering is the whole of the retry.":
    "Δεν ήταν δυνατός ο έλεγχος του {toolkit} αυτή τη στιγμή: {sentence} Τίποτα δεν άλλαξε — η σύνδεσή σας παραμένει όπως την άφησε ο τελευταίος έλεγχος — οπότε πατήστε ξανά Επανέλεγχος όταν απαντά η Composio.",
  "Your connection to {toolkit} was disconnected while this check was still running, so nothing was recorded about it: what the check found is about an account you no longer have here. Connect {toolkit2} again on the Plugins page if that was not what you meant.":
    "Η σύνδεσή σας με το {toolkit} αποσυνδέθηκε ενώ γινόταν ο έλεγχος, οπότε δεν καταγράφηκε τίποτα. Συνδέστε ξανά το {toolkit2} στη σελίδα Πρόσθετα αν δεν το θέλατε.",
  "The check this deployment ran against {toolkit} did not come back clean: {sentence} That may be the key and it may be the app — what came back does not say which — so your connection here is recorded as unchecked until a check does come back clean. Nothing was disconnected: press Re-check again in a few minutes, and fix the key at {toolkit3} if it keeps answering the same way.":
    "Ο έλεγχος του {toolkit} δεν βγήκε καθαρός: {sentence} Μπορεί να φταίει το κλειδί ή η εφαρμογή, οπότε η σύνδεσή σας καταγράφεται ως μη ελεγμένη μέχρι να περάσει ένας έλεγχος. Δεν αποσυνδέθηκε τίποτα: πατήστε ξανά Επανέλεγχος σε λίγα λεπτά και διορθώστε το κλειδί στο {toolkit3} αν συνεχίζεται.",
  "This digital employee has not been given the tool {ref}.":
    "Σε αυτόν τον ψηφιακό υπάλληλο δεν έχει δοθεί το εργαλείο {ref}.",
  "This digital employee has not been given the skill {ref}.":
    "Σε αυτόν τον ψηφιακό υπάλληλο δεν έχει δοθεί η δεξιότητα {ref}.",
  "{ref} is not a tool.": "Το {ref} δεν είναι εργαλείο.",
  "This call has no approval that matches it, so it was not made.":
    "Αυτή η κλήση δεν έχει αντίστοιχη έγκριση, οπότε δεν έγινε.",
  "The tool call was refused because its arguments contain credential material.":
    "Η κλήση εργαλείου απορρίφθηκε επειδή οι παράμετροί της περιέχουν διαπιστευτήρια.",
  "The tool call was refused because its arguments could not be inspected safely.":
    "Η κλήση εργαλείου απορρίφθηκε επειδή οι παράμετροί της δεν μπορούσαν να ελεγχθούν με ασφάλεια.",
  "{toolName} on {title} has changed since this call was approved, so it was not made. Ask again.":
    "Το {toolName} στο {title} άλλαξε από τότε που εγκρίθηκε η κλήση, οπότε δεν έγινε. Ζητήστε το ξανά.",
  "{url} does not name a Composio app, so nothing was asked what it offers. A row reached through this transport is one whose provenance says composio, and its url has to be composio:// followed by an app slug; correct the url on the Plugins page.":
    "Το {url} δεν ονομάζει εφαρμογή Composio, οπότε δεν ρωτήθηκε τίποτα. Η διεύθυνση πρέπει να είναι composio:// και το όνομα της εφαρμογής· διορθώστε την στη σελίδα Πρόσθετα.",
  "Composio is not configured for this deployment, so nothing could be asked what {toolkit} offers. That is the expected answer until COMPOSIO_API_KEY is configured, and the actions already recorded for this app are kept rather than cleared.":
    "Η Composio δεν έχει ρυθμιστεί για αυτή την εγκατάσταση, οπότε δεν ρωτήθηκε τι προσφέρει το {toolkit}. Αυτό αναμένεται μέχρι να ρυθμιστεί το COMPOSIO_API_KEY, και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Composio did not answer with an action list for {toolkit}: what came back was not a list of actions at all. Nothing was refreshed and the actions already recorded for this app are kept.":
    "Η Composio δεν απάντησε με λίστα ενεργειών για το {toolkit}. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Composio's action list for {toolkit} carries an input schema for {named} that this deployment could not read to the bottom: it {verdict}. Whether an action stages a file is what decides whether this deployment can offer it at all — one that does is dropped, because a model can only invent the staging key it asks for — so a schema that settles neither is not one to publish an action from. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose schemas could not be read.":
    "Η λίστα ενεργειών της Composio για το {toolkit} έχει σχήμα παραμέτρων για το {named} που η εγκατάσταση δεν μπόρεσε να διαβάσει πλήρως: {verdict}. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Composio's action list for {toolkit} contained an action with no slug, which is the name this deployment would have to record it under and send back to call it. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing this one could not be read from.":
    "Η λίστα ενεργειών της Composio για το {toolkit} περιείχε ενέργεια χωρίς όνομα. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Composio's action list for {toolkit} described {value2}'s tags as something other than a list of labels, and those labels are the only thing that says whether an action reads or writes and whether it destroys anything. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose effects could not be read.":
    "Η λίστα ενεργειών της Composio για το {toolkit} περιέγραψε τις ετικέτες του {value2} με μη αναγνώσιμο τρόπο, και αυτές λένε αν μια ενέργεια διαβάζει ή γράφει. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Composio's action list for {toolkit} described {value2}'s version as something other than a version string, and the version is what this deployment has to send back to call the action at all. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose versions could not be read.":
    "Η λίστα ενεργειών της Composio για το {toolkit} περιέγραψε την έκδοση του {value2} με μη αναγνώσιμο τρόπο, και η έκδοση χρειάζεται για να κληθεί η ενέργεια. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Composio's action list for {toolkit} described {value2}'s description as something other than text, and the description is what a model reads to decide whether to call the action at all. Nothing was refreshed and the actions already recorded for this app are kept rather than replaced by a listing whose descriptions could not be read.":
    "Η λίστα ενεργειών της Composio για το {toolkit} περιέγραψε την περιγραφή του {value2} με μη αναγνώσιμο τρόπο, και αυτήν διαβάζει το μοντέλο για να αποφασίσει. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "Every one of the {length} actions Composio listed for {toolkit} asks for a file upload, which this deployment cannot stage, so there is none it can offer. Recording that would say the app advertises nothing and delete every action, effect and version already held for it, so nothing was refreshed and those are kept.":
    "Και οι {length} ενέργειες που έδωσε η Composio για το {toolkit} ζητούν μεταφόρτωση αρχείου, που η εγκατάσταση δεν υποστηρίζει, οπότε δεν μπορεί να προσφερθεί καμία. Δεν ανανεώθηκε τίποτα και οι ήδη καταγεγραμμένες ενέργειες διατηρούνται.",
  "{toolName} failed and Composio did not say why. Check that this app is still connected on its Plugins page, then try again.":
    "Το {toolName} απέτυχε και η Composio δεν είπε γιατί. Ελέγξτε ότι η εφαρμογή είναι ακόμη συνδεδεμένη στη σελίδα Πρόσθετα και δοκιμάστε ξανά.",
  "Composio's action list for {toolkit} did not match the shape this deployment's @composio/core accepts, so the list was not refreshed and the tools already held are untouched. That is a vendor change rather than a setting: upgrading the package is the fix.":
    "Η λίστα ενεργειών της Composio για το {toolkit} δεν ταίριαζε με το σχήμα που δέχεται το @composio/core της εγκατάστασης, οπότε δεν ανανεώθηκε και τα εργαλεία παραμένουν. Πρόκειται για αλλαγή του παρόχου: διορθώνεται με αναβάθμιση του πακέτου.",
  "Composio did not answer with an action list for {toolkit}.":
    "Η Composio δεν απάντησε με λίστα ενεργειών για το {toolkit}.",
  "The action returned nothing.": "Η ενέργεια δεν επέστρεψε τίποτα.",
  "{toolName} was sent to Composio and Composio answered, but this deployment could not read what it said about the call: the answer's error was neither a sentence nor null, which is all Composio's own schema permits it to be, so nothing here can tell whether the action ran.":
    "Το {toolName} στάλθηκε στη Composio και απάντησε, αλλά η εγκατάσταση δεν μπόρεσε να διαβάσει τι είπε για την κλήση, οπότε δεν είναι γνωστό αν εκτελέστηκε η ενέργεια.",
  "{toolName} was sent to Composio and Composio answered, but this deployment could not read whether the call worked: the answer's successful was neither true nor false, which is all Composio's own schema permits it to be, so nothing here can tell whether the action ran.":
    "Το {toolName} στάλθηκε στη Composio και απάντησε, αλλά η εγκατάσταση δεν μπόρεσε να διαβάσει αν πέτυχε, οπότε δεν είναι γνωστό αν εκτελέστηκε η ενέργεια.",
  "This action runs in the account of the person asking, and this run is not attributed to anybody.":
    "Αυτή η ενέργεια λειτουργεί στον λογαριασμό του ατόμου που ρωτά, και αυτή η εκτέλεση δεν αποδίδεται σε κανέναν.",
  '{toolName} has no recorded version, so it cannot be called: Composio requires a specific one and rejects "latest", so there is nothing to fall back on. Refreshing this app\'s tools on its Plugins page recovers it only if Composio publishes a version for this action. Where Composio publishes none, no refresh will make it callable.':
    "Το {toolName} δεν έχει καταγεγραμμένη έκδοση, οπότε δεν μπορεί να κληθεί: η Composio απαιτεί συγκεκριμένη έκδοση και απορρίπτει το «latest». Η ανανέωση των εργαλείων στη σελίδα Πρόσθετα το διορθώνει μόνο αν η Composio δημοσιεύει έκδοση για αυτή την ενέργεια.",
  "Composio was asked about {toolName} and this deployment's @composio/core would not accept what came back: it did not match the shape that package parses with, so nothing here can say whether the action ran. That is a vendor change rather than a setting on this connection — upgrading the package is the fix.":
    "Η Composio ρωτήθηκε για το {toolName} και το @composio/core της εγκατάστασης δεν δέχτηκε την απάντηση, οπότε δεν είναι γνωστό αν εκτελέστηκε η ενέργεια. Πρόκειται για αλλαγή του παρόχου: διορθώνεται με αναβάθμιση του πακέτου.",
  "{toolName} was sent to Composio and its client resolved, but this deployment could not read what it resolved with: Composio's own schema requires a { data, error, successful } envelope and {gap}, so nothing here can tell whether the action ran. That is a change in what the vendor or this deployment's @composio/core answers with rather than a setting on this connection — upgrading the package is the fix.":
    "Το {toolName} στάλθηκε στη Composio, αλλά η απάντηση δεν είχε το αναμενόμενο σχήμα { data, error, successful } και {gap}, οπότε δεν είναι γνωστό αν εκτελέστηκε η ενέργεια. Διορθώνεται με αναβάθμιση του @composio/core.",
  "{key} is a server this deployment ships an entry for, and a row with that id says its provenance is composio. Nothing can tell an edited column from a brokered app that took the name, so this row is not resolved at all: rename it, or correct its provenance.":
    "Το {key} είναι διακομιστής που περιλαμβάνει η εγκατάσταση, αλλά μια εγγραφή με αυτό το όνομα δηλώνει προέλευση composio. Η εγγραφή δεν επιλύεται: μετονομάστε την ή διορθώστε την προέλευσή της.",
  "{key} is a catalogue entry declaring the composio transport, which is reached from a row's provenance and the app slug in its url — neither of which an entry has. There is no app to broker to and no connection to check, so this entry is not resolved at all: give it the transport it is actually reached over.":
    "Το {key} είναι καταχώριση καταλόγου που δηλώνει μεταφορά composio, ενώ αυτή προκύπτει από την προέλευση και τη διεύθυνση μιας εγγραφής. Η καταχώριση δεν επιλύεται: δώστε της τη σωστή μεταφορά.",
  "The native host worker disconnected before the operation finished.":
    "Η σύνδεση με τον υπολογιστή αποσυνδέθηκε πριν ολοκληρωθεί η ενέργεια.",
  "The native host approval expired before the operation finished.":
    "Η έγκριση στον υπολογιστή έληξε πριν ολοκληρωθεί η ενέργεια.",
  "That folder grant is no longer available.":
    "Αυτή η άδεια φακέλου δεν είναι πλέον διαθέσιμη.",
  "That folder was not granted to this digital employee and person.":
    "Αυτός ο φάκελος δεν έχει δοθεί σε αυτόν τον ψηφιακό υπάλληλο και το άτομο.",
  "The native host operation failed.": "Η ενέργεια στον υπολογιστή απέτυχε.",
  "The native host did not return a folder grant.":
    "Ο υπολογιστής δεν επέστρεψε άδεια φακέλου.",
  "That folder grant is not available to revoke.":
    "Αυτή η άδεια φακέλου δεν είναι διαθέσιμη για ανάκληση.",
  "That folder grant was revoked before the operation finished.":
    "Η άδεια φακέλου ανακλήθηκε πριν ολοκληρωθεί η ενέργεια.",
  "Host access was stopped.": "Η πρόσβαση στον υπολογιστή σταμάτησε.",
  "Desktop host access is not configured.":
    "Η πρόσβαση στον υπολογιστή δεν έχει ρυθμιστεί.",
  "Desktop host access authentication failed.":
    "Η ταυτοποίηση πρόσβασης στον υπολογιστή απέτυχε.",
  "Send a valid desktop operation result.":
    "Στείλτε έγκυρο αποτέλεσμα ενέργειας υπολογιστή.",
  "The folder grant could not be revoked.":
    "Δεν ήταν δυνατή η ανάκληση της άδειας φακέλου.",
  "No host folders are granted to this digital employee.":
    "Δεν έχουν δοθεί φάκελοι του υπολογιστή σε αυτόν τον ψηφιακό υπάλληλο.",
};
