/**
 * The business's phone line (#109): Settings, then Connect your Data, then Phone line, and every
 * sentence the server says about it.
 */
export const EL_PHONE_LINE: Record<string, string> = {
  "Phone line": "Τηλεφωνική γραμμή",
  "Not set up.": "Δεν έχει ρυθμιστεί.",
  "Answering calls.": "Απαντά στις κλήσεις.",
  "Connecting to the relay…": "Σύνδεση με τον αναμεταδότη…",
  "Not answering.": "Δεν απαντά.",
  "Switched off.": "Απενεργοποιημένη.",
  "One digital employee answers the business's line: it greets the caller, answers within its instructions, takes callbacks and puts the caller through to a person. It makes no calls, and nothing is recorded.":
    "Ένας ψηφιακός υπάλληλος απαντά στη γραμμή της επιχείρησης: χαιρετά τον καλούντα, απαντά μέσα στις οδηγίες του, σημειώνει επανακλήσεις και συνδέει τον καλούντα με άνθρωπο. Δεν κάνει κλήσεις και δεν ηχογραφείται τίποτα.",
  "Relay address": "Διεύθυνση αναμεταδότη",
  "Line token": "Κλειδί γραμμής",
  "Line token (leave empty to keep)":
    "Κλειδί γραμμής (αφήστε κενό για να διατηρηθεί)",
  "Speech key (OpenAI)": "Κλειδί ομιλίας (OpenAI)",
  "Speech key (leave empty to keep)":
    "Κλειδί ομιλίας (αφήστε κενό για να διατηρηθεί)",
  "Who answers": "Ποιος απαντά",
  "Choose a digital employee": "Επιλέξτε ψηφιακό υπάλληλο",
  "Speech model": "Μοντέλο ομιλίας",
  Voice: "Φωνή",
  Greeting: "Χαιρετισμός",
  "Monday to Friday, from": "Δευτέρα έως Παρασκευή, από",
  "Monday to Friday, until": "Δευτέρα έως Παρασκευή, έως",
  "Saturday, from": "Σάββατο, από",
  "Saturday, until": "Σάββατο, έως",
  "Answer calls": "Απάντηση κλήσεων",
  "Outside the hours, the employee says the business is closed and takes a callback. Leave the hours empty to answer at any time. The line token comes from BlackArk; the speech key is the business's own.":
    "Εκτός ωραρίου, ο υπάλληλος λέει ότι η επιχείρηση είναι κλειστή και σημειώνει επανάκληση. Αφήστε το ωράριο κενό για απάντηση οποιαδήποτε ώρα. Το κλειδί γραμμής το δίνει η BlackArk· το κλειδί ομιλίας είναι της επιχείρησης.",
  Calls: "Κλήσεις",
  "No calls yet.": "Καμία κλήση ακόμη.",
  "Unknown number": "Άγνωστος αριθμός",
  "Call back {name} on {number}: {reason}":
    "Επανάκληση {name} στο {number}: {reason}",
  "Mark as done": "Σήμανση ως ολοκληρωμένη",

  // The call log's outcomes.
  Answered: "Απαντήθηκε",
  Callback: "Επανάκληση",
  "Put through": "Συνδέθηκε με άνθρωπο",
  "After hours": "Εκτός ωραρίου",
  Failed: "Απέτυχε",
  "In progress": "Σε εξέλιξη",

  // What the server says.
  "Another computer is answering this line now.":
    "Αυτή τη γραμμή την απαντά τώρα άλλος υπολογιστής.",
  "The relay could not be reached, or it refused this line token. Trying again.":
    "Δεν ήταν δυνατή η σύνδεση με τον αναμεταδότη ή απέρριψε το κλειδί γραμμής. Νέα προσπάθεια.",
  "The relay address must start with https://.":
    "Η διεύθυνση του αναμεταδότη πρέπει να ξεκινά με https://.",
  "That digital employee is not one of yours.":
    "Αυτός ο ψηφιακός υπάλληλος δεν είναι δικός σας.",
  "Enter the line token and the speech key.":
    "Εισαγάγετε το κλειδί γραμμής και το κλειδί ομιλίας.",
  "Check the relay address, the employee, the voice, the greeting and the hours.":
    "Ελέγξτε τη διεύθυνση του αναμεταδότη, τον υπάλληλο, τη φωνή, τον χαιρετισμό και το ωράριο.",
  "No such callback, or it is already done.":
    "Δεν υπάρχει τέτοια επανάκληση ή έχει ήδη ολοκληρωθεί.",
  "The phone line could not be saved":
    "Δεν ήταν δυνατή η αποθήκευση της τηλεφωνικής γραμμής",
  "The phone line could not be removed":
    "Δεν ήταν δυνατή η αφαίρεση της τηλεφωνικής γραμμής",
  "Could not mark the callback as done":
    "Δεν ήταν δυνατή η σήμανση της επανάκλησης ως ολοκληρωμένης",
  "Could not load the phone line":
    "Δεν ήταν δυνατή η φόρτωση της τηλεφωνικής γραμμής",
  "Could not load the call log":
    "Δεν ήταν δυνατή η φόρτωση του αρχείου κλήσεων",
};
