/** Messages: errors, statuses, form checks, notifications, voice and dictation. */
export const EL_MESSAGES: Record<string, string> = {
  "Could not change the plan": "Δεν ήταν δυνατή η αλλαγή του προγράμματος",
  "Instructions must be 8000 characters or fewer.":
    "Οι οδηγίες πρέπει να είναι έως 8000 χαρακτήρες.",
  "Name is required.": "Το όνομα είναι υποχρεωτικό.",
  "Name must be 80 characters or fewer.":
    "Το όνομα πρέπει να είναι έως 80 χαρακτήρες.",
  "Title is required.": "Ο τίτλος είναι υποχρεωτικός.",
  "Role description is required.": "Η περιγραφή ρόλου είναι υποχρεωτική.",
  "Role description must be 1000 characters or fewer.":
    "Η περιγραφή ρόλου πρέπει να είναι έως 1000 χαρακτήρες.",
  "Enter a web address starting with http:// or https://.":
    "Εισαγάγετε διεύθυνση που ξεκινά με http:// ή https://.",
  "That picture is too large. Choose one under 8 MB.":
    "Η εικόνα είναι πολύ μεγάλη. Επιλέξτε μία κάτω από 8 MB.",
  "This browser cannot resize pictures.":
    "Αυτός ο περιηγητής δεν μπορεί να αλλάξει το μέγεθος εικόνων.",
  "Digital employee operation failed":
    "Η ενέργεια στον ψηφιακό υπάλληλο απέτυχε",
  "The connection could not be tested.":
    "Δεν ήταν δυνατός ο έλεγχος της σύνδεσης.",
  "Approved from Requests.": "Εγκρίθηκε από τα Αιτήματα.",
  "Nobody answered in time, so this lapsed.":
    "Κανείς δεν απάντησε εγκαίρως, οπότε έληξε.",
  "Declined from Requests.": "Απορρίφθηκε από τα Αιτήματα.",
  "Silent for {seconds}s": "Σιωπή για {seconds} δ",
  "Could not start {providerName} sign-in.":
    "Δεν ήταν δυνατή η έναρξη σύνδεσης με {providerName}.",
  "No identity provider is registered for that address.":
    "Δεν υπάρχει καταχωρισμένος πάροχος ταυτότητας για αυτή τη διεύθυνση.",
  "That request failed.": "Το αίτημα απέτυχε.",
  "Could not change cloud running":
    "Δεν ήταν δυνατή η αλλαγή της λειτουργίας στο νέφος",
  "Component operation failed": "Η ενέργεια στο στοιχείο απέτυχε",
  "This deployment could not be asked for that data.":
    "Δεν ήταν δυνατό να ζητηθούν αυτά τα δεδομένα από την εγκατάσταση.",
  "This deployment could not be reached to read that data.":
    "Δεν ήταν δυνατή η σύνδεση με την εγκατάσταση για ανάγνωση των δεδομένων.",
  "This deployment could not be asked whether that component is allowed, so it was not shown.":
    "Δεν ήταν δυνατό να ελεγχθεί αν επιτρέπεται αυτό το στοιχείο, οπότε δεν εμφανίστηκε.",
  "This deployment could not be reached to check whether that component is allowed, so it was not shown.":
    "Δεν ήταν δυνατή η σύνδεση για να ελεγχθεί αν επιτρέπεται αυτό το στοιχείο, οπότε δεν εμφανίστηκε.",
  "That could not be entered.": "Δεν ήταν δυνατή η καταχώριση.",
  "The assistant's computer could not be reached.":
    "Δεν ήταν δυνατή η σύνδεση με τον υπολογιστή του βοηθού.",
  "Your own browser's status could not be read.":
    "Δεν ήταν δυνατή η ανάγνωση της κατάστασης του περιηγητή σας.",
  "Waiting for your approval to fill in":
    "Περιμένει την έγκρισή σας για συμπλήρωση",
  "Filled in": "Συμπλήρωσε",
  "Waiting for your approval to click": "Περιμένει την έγκρισή σας για κλικ",
  "Waiting for your approval to press":
    "Περιμένει την έγκρισή σας για πάτημα πλήκτρου",
  "Added to file": "Πρόσθεσε σε αρχείο",
  "Saved file": "Αποθήκευσε αρχείο",
  "Asked {asked}": "Ρώτησε τον/την {asked}",
  "Asked another digital employee": "Ρώτησε άλλον ψηφιακό υπάλληλο",
  "Constraints: {text}": "Περιορισμοί: {text}",
  "Wanted back: {text}": "Ζητείται: {text}",
  "The digital employee stopped without saying why.":
    "Ο ψηφιακός υπάλληλος σταμάτησε χωρίς να πει γιατί.",
  "Provider is required.": "Ο πάροχος είναι υποχρεωτικός.",
  "Secret is required.": "Το μυστικό είναι υποχρεωτικό.",
  // Data services
  "Outlook mail, Calendar, Teams chats and SharePoint and OneDrive files. Reads, and sends mail only after you approve each message.":
    "Αλληλογραφία Outlook, Ημερολόγιο, συνομιλίες Teams και αρχεία SharePoint και OneDrive. Διαβάζει, και στέλνει email μόνο αφού εγκρίνετε κάθε μήνυμα.",
  "An app registered in Microsoft Entra, with its client id and secret added by an administrator":
    "Μια εφαρμογή καταχωρισμένη στο Microsoft Entra, με client id και secret που προσθέτει ο διαχειριστής",
  "Files in your Drive, including shared drives. Read only.":
    "Αρχεία στο Drive σας, μαζί με τους κοινόχρηστους δίσκους. Μόνο ανάγνωση.",
  "Search and read your mail, and send a message once you approve it. Nothing is deleted or marked read.":
    "Αναζήτηση και ανάγνωση της αλληλογραφίας σας, και αποστολή μηνύματος αφού το εγκρίνετε. Τίποτα δεν διαγράφεται ούτε σημειώνεται ως αναγνωσμένο.",
  "Your events and free time.": "Τα γεγονότα και ο ελεύθερος χρόνος σας.",
  "The pages and databases you choose to share.":
    "Οι σελίδες και οι βάσεις δεδομένων που επιλέγετε να κοινοποιήσετε.",
  "Your files.": "Τα αρχεία σας.",
  "Repositories, issues and pull requests.":
    "Αποθετήρια, ζητήματα και pull requests.",
  "Issues and projects.": "Ζητήματα και έργα.",
  "Jira and Confluence": "Jira και Confluence",
  "Issues, projects and pages.": "Ζητήματα, έργα και σελίδες.",
  "Tasks and projects.": "Εργασίες και έργα.",
  "Channels and messages you can see.": "Κανάλια και μηνύματα που βλέπετε.",
  "Accounts, contacts and deals.": "Λογαριασμοί, επαφές και συμφωνίες.",
  "Contacts, companies and deals.": "Επαφές, εταιρείες και συμφωνίες.",
  // Dictation
  "Dictation requires a supported browser and HTTPS (or localhost).":
    "Η υπαγόρευση χρειάζεται υποστηριζόμενο περιηγητή και HTTPS (ή localhost).",
  "Dictation requires a supported browser and HTTPS (or localhost)":
    "Η υπαγόρευση χρειάζεται υποστηριζόμενο περιηγητή και HTTPS (ή localhost)",
  "This browser cannot record a supported audio format.":
    "Αυτός ο περιηγητής δεν μπορεί να ηχογραφήσει σε υποστηριζόμενη μορφή.",
  "Recording cancelled": "Η ηχογράφηση ακυρώθηκε",
  "Recording is too large. Try a shorter message.":
    "Η ηχογράφηση είναι πολύ μεγάλη. Δοκιμάστε συντομότερο μήνυμα.",
  "The microphone stopped recording. Please try again.":
    "Το μικρόφωνο σταμάτησε να ηχογραφεί. Δοκιμάστε ξανά.",
  "Recording was interrupted. Please try again.":
    "Η ηχογράφηση διακόπηκε. Δοκιμάστε ξανά.",
  "Recording stopped before audio could be collected.":
    "Η ηχογράφηση σταμάτησε πριν συλλεχθεί ήχος.",
  "The recording is empty or unsupported. Please record again.":
    "Η ηχογράφηση είναι κενή ή δεν υποστηρίζεται. Ηχογραφήστε ξανά.",
  "Transcription failed. Please retry.": "Η μεταγραφή απέτυχε. Δοκιμάστε ξανά.",
  "No speech was detected. Try recording again.":
    "Δεν εντοπίστηκε ομιλία. Δοκιμάστε να ηχογραφήσετε ξανά.",
  "Microphone access was denied. Allow it in your browser and try again.":
    "Η πρόσβαση στο μικρόφωνο απορρίφθηκε. Επιτρέψτε την στον περιηγητή σας και δοκιμάστε ξανά.",
  "Could not start recording. Check your microphone and try again.":
    "Δεν ήταν δυνατή η έναρξη ηχογράφησης. Ελέγξτε το μικρόφωνο και δοκιμάστε ξανά.",
  "Could not finish recording. Please record again.":
    "Δεν ήταν δυνατή η ολοκλήρωση της ηχογράφησης. Ηχογραφήστε ξανά.",
  "Start a new chat from anywhere in the app.":
    "Νέα συνομιλία από οποιοδήποτε σημείο της εφαρμογής.",
  "Could not change that identity provider":
    "Δεν ήταν δυνατή η αλλαγή του παρόχου ταυτότητας",
  "Could not save the listing": "Δεν ήταν δυνατή η αποθήκευση της καταχώρισης",
  "This cannot be shared yet.": "Δεν μπορεί να κοινοποιηθεί ακόμη.",
  "That memory could not be saved.":
    "Δεν ήταν δυνατή η αποθήκευση της ανάμνησης.",
  "Choose where the model comes from.":
    "Επιλέξτε από πού προέρχεται το μοντέλο.",
  "Keep the name under 80 characters.":
    "Το όνομα πρέπει να είναι κάτω από 80 χαρακτήρες.",
  "Free models are shared and small. They often ignore a digital employee's role and instructions, or cannot use tools such as asking a colleague. For a demo or real work, choose a paid model.":
    "Τα δωρεάν μοντέλα είναι κοινόχρηστα και μικρά. Συχνά αγνοούν τον ρόλο και τις οδηγίες ενός ψηφιακού υπαλλήλου ή δεν μπορούν να χρησιμοποιήσουν εργαλεία, όπως την ερώτηση σε συνάδελφο. Για παρουσίαση ή πραγματική δουλειά, επιλέξτε επί πληρωμή μοντέλο.",
  "Could not save the model": "Δεν ήταν δυνατή η αποθήκευση του μοντέλου",
  "Could not test that connection.":
    "Δεν ήταν δυνατός ο έλεγχος αυτής της σύνδεσης.",
  "Onboarding could not be saved":
    "Δεν ήταν δυνατή η αποθήκευση της αρχικής ρύθμισης",
  "Could not update that person":
    "Δεν ήταν δυνατή η ενημέρωση αυτού του ατόμου",
  "Paste the whole address from your browser.":
    "Επικολλήστε ολόκληρη τη διεύθυνση από τον περιηγητή σας.",
  "That is not a web address. Copy the whole address from your browser's address bar.":
    "Αυτή δεν είναι διεύθυνση ιστού. Αντιγράψτε ολόκληρη τη διεύθυνση από τη γραμμή διευθύνσεων.",
  "That is not the address sign-in ends on. It ends in {CALLBACK_PATH}?code=…":
    "Αυτή δεν είναι η διεύθυνση όπου ολοκληρώνεται η σύνδεση. Τελειώνει σε {CALLBACK_PATH}?code=…",
  "The sign-in was declined in the browser, so nothing was connected. Press Connect to try again.":
    "Η σύνδεση απορρίφθηκε στον περιηγητή, οπότε δεν συνδέθηκε τίποτα. Πατήστε Σύνδεση για να δοκιμάσετε ξανά.",
  "The sign-in did not finish in the browser, so nothing was connected. Press Connect to try again.":
    "Η σύνδεση δεν ολοκληρώθηκε στον περιηγητή, οπότε δεν συνδέθηκε τίποτα. Πατήστε Σύνδεση για να δοκιμάσετε ξανά.",
  "That address is missing part of the sign-in. Copy the whole address, including everything after the question mark.":
    "Από τη διεύθυνση λείπει μέρος της σύνδεσης. Αντιγράψτε ολόκληρη τη διεύθυνση, μαζί με ό,τι ακολουθεί το ερωτηματικό.",
  "Could not change notifications": "Δεν ήταν δυνατή η αλλαγή των ειδοποιήσεων",
  "This browser gave notification details that are not usable":
    "Ο περιηγητής έδωσε στοιχεία ειδοποιήσεων που δεν μπορούν να χρησιμοποιηθούν",
  "Notifications are blocked for this site. Allow them in the browser's settings and try again.":
    "Οι ειδοποιήσεις έχουν αποκλειστεί για αυτόν τον ιστότοπο. Επιτρέψτε τες από τις ρυθμίσεις του περιηγητή και δοκιμάστε ξανά.",
  "Notifications were not allowed.": "Οι ειδοποιήσεις δεν επιτράπηκαν.",
  "This browser could not register with its notification service. Check your connection and the browser's notification settings, then try again.":
    "Ο περιηγητής δεν μπόρεσε να εγγραφεί στην υπηρεσία ειδοποιήσεων. Ελέγξτε τη σύνδεσή σας και τις ρυθμίσεις ειδοποιήσεων και δοκιμάστε ξανά.",
  "That routine could not be changed.":
    "Δεν ήταν δυνατή η αλλαγή της ρουτίνας.",
  "That did not work.": "Δεν λειτούργησε.",
  "Sign in to save your preferences.":
    "Συνδεθείτε για να αποθηκεύσετε τις προτιμήσεις σας.",
  "Lower-case letters, numbers and hyphens, 2 to 40 characters.":
    "Πεζά λατινικά γράμματα, αριθμοί και παύλες, 2 έως 40 χαρακτήρες.",
  "Title must be 120 characters or fewer.":
    "Ο τίτλος πρέπει να είναι έως 120 χαρακτήρες.",
  "The one-liner must be 200 characters or fewer.":
    "Η σύντομη περιγραφή πρέπει να είναι έως 200 χαρακτήρες.",
  "Instructions are required — this is what the digital employee follows.":
    "Οι οδηγίες είναι υποχρεωτικές — αυτές ακολουθεί ο ψηφιακός υπάλληλος.",
  // Voice
  "This browser does not support WebRTC voice calls.":
    "Αυτός ο περιηγητής δεν υποστηρίζει φωνητικές κλήσεις WebRTC.",
  "Call ended": "Η κλήση τερματίστηκε",
  "Audio playback was blocked. Allow sound in your browser, then call again.":
    "Η αναπαραγωγή ήχου αποκλείστηκε. Επιτρέψτε τον ήχο στον περιηγητή σας και καλέστε ξανά.",
  "The voice connection was lost. Your chat is still available. Call again to reconnect.":
    "Η φωνητική σύνδεση χάθηκε. Η συνομιλία σας παραμένει διαθέσιμη. Καλέστε ξανά για επανασύνδεση.",
  "The microphone disconnected. Check it and call again.":
    "Το μικρόφωνο αποσυνδέθηκε. Ελέγξτε το και καλέστε ξανά.",
  "The voice connection failed. Please call again.":
    "Η φωνητική σύνδεση απέτυχε. Καλέστε ξανά.",
  "The voice call ended. You can call again.":
    "Η φωνητική κλήση τερματίστηκε. Μπορείτε να καλέσετε ξανά.",
  "The voice service returned an unreadable event. Please call again.":
    "Η φωνητική υπηρεσία έστειλε μη αναγνώσιμο συμβάν. Καλέστε ξανά.",
  "Could not connect the voice call. Please try again.":
    "Δεν ήταν δυνατή η σύνδεση της φωνητικής κλήσης. Δοκιμάστε ξανά.",
  "The voice service returned an invalid connection. Please try again.":
    "Η φωνητική υπηρεσία έδωσε μη έγκυρη σύνδεση. Δοκιμάστε ξανά.",
  "The voice call is no longer connected.":
    "Η φωνητική κλήση δεν είναι πλέον συνδεδεμένη.",
  "The call took too long to connect. Check microphone permission and try again.":
    "Η κλήση άργησε πολύ να συνδεθεί. Ελέγξτε την άδεια μικροφώνου και δοκιμάστε ξανά.",
  "This call reached its 15-minute limit. You can start a new call.":
    "Η κλήση έφτασε το όριο των 15 λεπτών. Μπορείτε να ξεκινήσετε νέα κλήση.",
  "Could not start the voice call.":
    "Δεν ήταν δυνατή η έναρξη της φωνητικής κλήσης.",
  "The microphone could not be changed. Please call again.":
    "Δεν ήταν δυνατή η αλλαγή μικροφώνου. Καλέστε ξανά.",
  "The voice connection was lost.": "Η φωνητική σύνδεση χάθηκε.",
  "This call reached its transcript limit. Start a new call to continue.":
    "Η κλήση έφτασε το όριο απομαγνητοφώνησης. Ξεκινήστε νέα κλήση για να συνεχίσετε.",
  "The voice service could not complete its response. Please call again.":
    "Η φωνητική υπηρεσία δεν ολοκλήρωσε την απάντηση. Καλέστε ξανά.",
  "The voice service reported an error. Please end the call and try again.":
    "Η φωνητική υπηρεσία ανέφερε σφάλμα. Τερματίστε την κλήση και δοκιμάστε ξανά.",
  "This browser could not start call audio. Allow sound and try again.":
    "Ο περιηγητής δεν μπόρεσε να ξεκινήσει τον ήχο της κλήσης. Επιτρέψτε τον ήχο και δοκιμάστε ξανά.",
  "Could not connect to Grok Voice. Check your connection and try again.":
    "Δεν ήταν δυνατή η σύνδεση με το Grok Voice. Ελέγξτε τη σύνδεσή σας και δοκιμάστε ξανά.",
  "The voice connection closed. Your chat is still available.":
    "Η φωνητική σύνδεση έκλεισε. Η συνομιλία σας παραμένει διαθέσιμη.",
  "Voice playback could not keep up. Please call again.":
    "Η αναπαραγωγή φωνής δεν μπόρεσε να ακολουθήσει. Καλέστε ξανά.",
  "The voice service sent invalid audio or controls. Please call again.":
    "Η φωνητική υπηρεσία έστειλε μη έγκυρο ήχο ή εντολές. Καλέστε ξανά.",
  "Your connection is too slow for live audio. Please call again.":
    "Η σύνδεσή σας είναι πολύ αργή για ζωντανό ήχο. Καλέστε ξανά.",
  "Voice calls need a supported browser and HTTPS or localhost.":
    "Οι φωνητικές κλήσεις χρειάζονται υποστηριζόμενο περιηγητή και HTTPS ή localhost.",
  "Voice calls are unavailable. Check the deployment's voice configuration.":
    "Οι φωνητικές κλήσεις δεν είναι διαθέσιμες. Ελέγξτε τις ρυθμίσεις φωνής της εγκατάστασης.",
  "This deployment uses an unsupported voice connection.":
    "Αυτή η εγκατάσταση χρησιμοποιεί μη υποστηριζόμενη φωνητική σύνδεση.",
  "Could not save this voice chat.":
    "Δεν ήταν δυνατή η αποθήκευση αυτής της φωνητικής συνομιλίας.",
  " Keep this page open to retry; browser recovery is unavailable.":
    " Κρατήστε τη σελίδα ανοιχτή για νέα προσπάθεια· η ανάκτηση από τον περιηγητή δεν είναι διαθέσιμη.",
  "The page closed before saving was confirmed.":
    "Η σελίδα έκλεισε πριν επιβεβαιωθεί η αποθήκευση.",
};
