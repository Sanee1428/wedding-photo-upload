// The only file you need to edit for the upload page.
window.WEDDING_CONFIG = Object.freeze({
  // Paste the Web app URL from Apps Script (Deploy → Manage deployments). Ends with /exec
  apiUrl: 'https://script.google.com/macros/s/PASTE-YOUR-DEPLOYMENT-ID/exec',

  // Shown at the top of the page
  coupleNames: 'Bride & Groom',
  tagline: 'Thank you for being part of our celebration',

  // true = try the page without any backend (nothing is uploaded)
  demo: false,
});
