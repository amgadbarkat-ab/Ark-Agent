/**
 * The price list and video editing (#109): Settings, then Connect your Data, and what the server
 * says about them.
 */
export const EL_BUILTIN_TOOLS: Record<string, string> = {
  "Price list": "Τιμοκατάλογος",
  "No price list yet. Until one is uploaded, employees say the prices are not loaded.":
    "Δεν υπάρχει ακόμη τιμοκατάλογος. Μέχρι να ανεβεί, οι υπάλληλοι λένε ότι οι τιμές δεν έχουν φορτωθεί.",
  "A CSV or Excel (.xlsx) file, up to 8 MB: a header row, then one product per row, for example code, product, size, price, VAT. Employees quote prices only from this list.":
    "Αρχείο CSV ή Excel (.xlsx), έως 8 MB: μια γραμμή επικεφαλίδων και μετά ένα προϊόν ανά γραμμή, για παράδειγμα κωδικός, προϊόν, μέγεθος, τιμή, ΦΠΑ. Οι υπάλληλοι δίνουν τιμές μόνο από αυτόν τον κατάλογο.",
  "{file}: {rows} products, uploaded {date}.":
    "{file}: {rows} προϊόντα, ανέβηκε στις {date}.",
  Replace: "Αντικατάσταση",
  "Video editing": "Επεξεργασία βίντεο",
  "Ready: FFmpeg was found on this computer.":
    "Έτοιμο: το FFmpeg βρέθηκε σε αυτόν τον υπολογιστή.",
  "Not ready.": "Δεν είναι έτοιμο.",
  "Put footage, photos and music in {inDir}. Finished videos appear in {outDir}. Every render waits for your approval, and nothing is published.":
    "Βάλτε πλάνα, φωτογραφίες και μουσική στο {inDir}. Τα έτοιμα βίντεο εμφανίζονται στο {outDir}. Κάθε απόδοση περιμένει την έγκρισή σας και τίποτα δεν δημοσιεύεται.",

  // What the server says.
  "Video editing runs in the ArkAgent desktop app on the business's own computer only.":
    "Η επεξεργασία βίντεο λειτουργεί μόνο στην εφαρμογή ArkAgent στον υπολογιστή της επιχείρησης.",
  "FFmpeg is not installed on this computer. Install it (Windows: winget install Gyan.FFmpeg; Mac: brew install ffmpeg), then restart ArkAgent.":
    "Το FFmpeg δεν είναι εγκατεστημένο σε αυτόν τον υπολογιστή. Εγκαταστήστε το (Windows: winget install Gyan.FFmpeg· Mac: brew install ffmpeg) και επανεκκινήστε το ArkAgent.",
  "No font with Greek letters was found on this computer for captions.":
    "Δεν βρέθηκε γραμματοσειρά με ελληνικούς χαρακτήρες σε αυτόν τον υπολογιστή για τους υπότιτλους.",
  "Upload a .csv or .xlsx file.": "Ανεβάστε αρχείο .csv ή .xlsx.",
  "The file is empty.": "Το αρχείο είναι κενό.",
  "The file is larger than 8 MB.": "Το αρχείο είναι μεγαλύτερο από 8 MB.",
  "That is not an Excel (.xlsx) file.": "Αυτό δεν είναι αρχείο Excel (.xlsx).",
  "The workbook could not be read.":
    "Δεν ήταν δυνατή η ανάγνωση του βιβλίου εργασίας.",
  "The file needs a header row and at least one product row.":
    "Το αρχείο χρειάζεται μια γραμμή επικεφαλίδων και τουλάχιστον μία γραμμή προϊόντος.",
  "The price list could not be uploaded":
    "Δεν ήταν δυνατή η αποστολή του τιμοκαταλόγου",
  "The price list could not be removed":
    "Δεν ήταν δυνατή η αφαίρεση του τιμοκαταλόγου",
  "Could not load the price list":
    "Δεν ήταν δυνατή η φόρτωση του τιμοκαταλόγου",
  "Could not check video editing":
    "Δεν ήταν δυνατός ο έλεγχος της επεξεργασίας βίντεο",
};
