/**
 * The overview's counted sentences, singular and plural written whole, so the Greek agrees with its
 * number. The server writes "3 listings are not visible…"; these entries are longer than the
 * `{plural} …` ones in server.ts, so `translateSentence` picks them first.
 */
export const EL_SERVER_COUNTS: Record<string, string> = {
  "{count} month where the payment service did not say whether it took the money. Look at Paddle's own record, then settle each one.":
    "{count} μήνας όπου η υπηρεσία πληρωμών δεν είπε αν πήρε τα χρήματα. Δείτε το αρχείο της Paddle και διευθετήστε τον.",
  "{count} months where the payment service did not say whether it took the money. Look at Paddle's own record, then settle each one.":
    "{count} μήνες όπου η υπηρεσία πληρωμών δεν είπε αν πήρε τα χρήματα. Δείτε το αρχείο της Paddle και διευθετήστε τον καθένα.",
  "{count} charge started over an hour ago and never recorded an answer. They are not retried; check Paddle, then settle them.":
    "{count} χρέωση ξεκίνησε πριν από πάνω από μία ώρα και δεν κατέγραψε απάντηση. Δεν ξαναδοκιμάζεται· ελέγξτε την Paddle και διευθετήστε τη.",
  "{count} charges started over an hour ago and never recorded an answer. They are not retried; check Paddle, then settle them.":
    "{count} χρεώσεις ξεκίνησαν πριν από πάνω από μία ώρα και δεν κατέγραψαν απάντηση. Δεν ξαναδοκιμάζονται· ελέγξτε την Paddle και διευθετήστε τις.",
  "{count} listing is not visible to anyone until you approve or reject it.":
    "{count} καταχώριση δεν είναι ορατή σε κανέναν μέχρι να την εγκρίνετε ή να την απορρίψετε.",
  "{count} listings are not visible to anyone until you approve or reject them.":
    "{count} καταχωρίσεις δεν είναι ορατές σε κανέναν μέχρι να τις εγκρίνετε ή να τις απορρίψετε.",
  "{count} report is open against shared digital employees.":
    "{count} αναφορά είναι ανοιχτή για κοινοποιημένους ψηφιακούς υπαλλήλους.",
  "{count} reports are open against shared digital employees.":
    "{count} αναφορές είναι ανοιχτές για κοινοποιημένους ψηφιακούς υπαλλήλους.",
  "{count} job ran out of attempts and will not run again. The reason is in the work_items table and the server log.":
    "{count} εργασία εξάντλησε τις προσπάθειες και δεν θα εκτελεστεί ξανά. Η αιτία βρίσκεται στον πίνακα work_items και στο αρχείο καταγραφής του διακομιστή.",
  "{count} jobs ran out of attempts and will not run again. The reason is in the work_items table and the server log.":
    "{count} εργασίες εξάντλησαν τις προσπάθειες και δεν θα εκτελεστούν ξανά. Η αιτία βρίσκεται στον πίνακα work_items και στο αρχείο καταγραφής του διακομιστή.",
  "{count} account has a failed payment. The provider is retrying; they lose access if it does not clear.":
    "{count} λογαριασμός έχει αποτυχημένη πληρωμή. Ο πάροχος ξαναδοκιμάζει· αν δεν εξοφληθεί, χάνεται η πρόσβαση.",
  "{count} accounts have a failed payment. The provider is retrying; they lose access if it does not clear.":
    "{count} λογαριασμοί έχουν αποτυχημένη πληρωμή. Ο πάροχος ξαναδοκιμάζει· αν δεν εξοφληθεί, χάνουν την πρόσβαση.",
  "{count} account is suspended and cannot run digital employees.":
    "{count} λογαριασμός είναι σε αναστολή και δεν μπορεί να εκτελεί ψηφιακούς υπαλλήλους.",
  "{count} accounts are suspended and cannot run digital employees.":
    "{count} λογαριασμοί είναι σε αναστολή και δεν μπορούν να εκτελούν ψηφιακούς υπαλλήλους.",
};
