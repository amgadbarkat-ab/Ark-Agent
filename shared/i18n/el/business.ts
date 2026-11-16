/**
 * The business connectors (#109, v0.1.43): Skroutz, WooCommerce, BOX NOW and the business's data
 * files, on Settings, then Connect your Data, and what the server says about them.
 */
export const EL_BUSINESS: Record<string, string> = {
  "Shop and delivery": "Κατάστημα και αποστολές",
  "Business data files": "Αρχεία δεδομένων της επιχείρησης",
  "Exports from your ERP or any table you keep, as CSV or XLSX: for example Pylon's items, stock, sales or customer lists. Each has a short name; uploading again under the same name replaces it. Employees given this tool read rows exactly as written.":
    "Εξαγωγές από το ERP σας ή οποιονδήποτε πίνακα κρατάτε, σε CSV ή XLSX: για παράδειγμα είδη, απόθεμα, πωλήσεις ή πελάτες από το Pylon. Κάθε αρχείο έχει ένα σύντομο όνομα· αν ανεβάσετε ξανά με το ίδιο όνομα, αντικαθίσταται. Οι υπάλληλοι με αυτό το εργαλείο διαβάζουν τις γραμμές ακριβώς όπως είναι γραμμένες.",
  "{file}, {rows} rows, uploaded {when}":
    "{file}, {rows} γραμμές, ανέβηκε {when}",

  // Skroutz
  "Skroutz (Smart Cart orders and Skroutz Last Mile)":
    "Skroutz (παραγγελίες Smart Cart και Skroutz Last Mile)",
  "Read Smart Cart orders, their state and their Skroutz Last Mile or courier tracking. Accepting, rejecting or marking an order ready waits for your approval.":
    "Ανάγνωση παραγγελιών Smart Cart, της κατάστασής τους και της παρακολούθησης Skroutz Last Mile ή courier. Η αποδοχή, η απόρριψη ή η σήμανση «έτοιμη» μιας παραγγελίας περιμένει την έγκρισή σας.",
  "In the Skroutz merchant panel: Merchants, then Services, then Skroutz Marketplace, then the API token. Making a new token cancels the old one.":
    "Στο Skroutz merchant panel: Merchants, Υπηρεσίες, Skroutz Marketplace, API token. Ένα νέο token ακυρώνει το παλιό.",
  "API token": "API token",
  "Order inbox address (optional)":
    "Διεύθυνση θυρίδας παραγγελιών (προαιρετικό)",
  "From BlackArk. Paste the same address into the Skroutz panel as the webhook, so new orders reach this computer.":
    "Από την BlackArk. Βάλτε την ίδια διεύθυνση στο Skroutz panel ως webhook, ώστε οι νέες παραγγελίες να φτάνουν σε αυτόν τον υπολογιστή.",
  "Order inbox key (optional)": "Κλειδί θυρίδας παραγγελιών (προαιρετικό)",

  // WooCommerce
  "WooCommerce (orders and stock)": "WooCommerce (παραγγελίες και απόθεμα)",
  "Read the shop's orders, products, prices and stock. Changing a stock level or a price waits for your approval.":
    "Ανάγνωση παραγγελιών, προϊόντων, τιμών και αποθέματος του καταστήματος. Η αλλαγή αποθέματος ή τιμής περιμένει την έγκρισή σας.",
  "In WordPress: WooCommerce, then Settings, then Advanced, then REST API, then Add key. Read for reading only, Read/Write to allow approved changes.":
    "Στο WordPress: WooCommerce, Ρυθμίσεις, Για προχωρημένους, REST API, Προσθήκη κλειδιού. Read μόνο για ανάγνωση, Read/Write για εγκεκριμένες αλλαγές.",
  "Shop address": "Διεύθυνση καταστήματος",
  "Consumer key": "Consumer key",
  "Consumer secret": "Consumer secret",

  // BOX NOW
  "BOX NOW (parcels, tracking and cash on delivery)":
    "BOX NOW (δέματα, παρακολούθηση και αντικαταβολή)",
  "Read parcels, where each one is, and whether cash on delivery was collected and paid over. Read only.":
    "Ανάγνωση δεμάτων, πού βρίσκεται το καθένα, και αν η αντικαταβολή εισπράχθηκε και αποδόθηκε. Μόνο ανάγνωση.",
  "From BOX NOW, after registering as a partner: the API address (API_URL), the client id and the client secret. Use the stage address first.":
    "Από την BOX NOW, μετά την εγγραφή ως συνεργάτης: η διεύθυνση API (API_URL), το client id και το client secret. Χρησιμοποιήστε πρώτα τη διεύθυνση stage.",
  "API address (API_URL)": "Διεύθυνση API (API_URL)",
  "Client id": "Client id",
  "Client secret": "Client secret",

  // The server's sentences.
  "No such connector.": "Δεν υπάρχει τέτοια σύνδεση.",
  "The form sent an unknown field.": "Η φόρμα έστειλε άγνωστο πεδίο.",
  "Fill in {field}.": "Συμπληρώστε: {field}.",
  "The connector could not be connected": "Η σύνδεση δεν ολοκληρώθηκε",
  "The connector could not be disconnected": "Η αποσύνδεση δεν ολοκληρώθηκε",
  "The file could not be uploaded": "Το αρχείο δεν ανέβηκε",
  "The file could not be removed": "Το αρχείο δεν αφαιρέθηκε",
  "Could not load the data files": "Τα αρχεία δεδομένων δεν φορτώθηκαν",
  "Skroutz refused the API token. Make a new one in the merchant panel and connect again in Settings.":
    "Το Skroutz απέρριψε το API token. Φτιάξτε νέο στο merchant panel και συνδεθείτε ξανά στις Ρυθμίσεις.",
  "The shop refused the REST API key. Check it in WooCommerce, then connect again in Settings.":
    "Το κατάστημα απέρριψε το κλειδί REST API. Ελέγξτε το στο WooCommerce και συνδεθείτε ξανά στις Ρυθμίσεις.",
  "The shop has no such item, or this address is not a WooCommerce shop with the REST API on.":
    "Το κατάστημα δεν έχει αυτό το στοιχείο, ή η διεύθυνση δεν είναι κατάστημα WooCommerce με ενεργό REST API.",
  "BOX NOW refused the client id or secret. Check them with BOX NOW, then connect again in Settings.":
    "Η BOX NOW απέρριψε το client id ή το secret. Ελέγξτε τα με την BOX NOW και συνδεθείτε ξανά στις Ρυθμίσεις.",
  "Give the file a short name in lower-case letters, numbers and hyphens, for example stock or customers.":
    "Δώστε στο αρχείο ένα σύντομο όνομα με πεζά λατινικά, αριθμούς και παύλες, για παράδειγμα stock ή customers.",
};
