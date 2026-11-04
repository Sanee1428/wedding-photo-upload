# Wedding Photo Upload

Guests scan a QR code, type their name, and pick photos and videos from their gallery.
Everything lands in your Google Drive:

```
Wedding Photos/
  Sangeet/
    Ravi Kumar/
      Ravi Kumar_20261212_203015_a1b2c3.jpg
      Ravi Kumar_20261212_204502_9f8e7d.mp4
    Sita Devi/
  Wedding/
    ...
```

Originals are stored untouched: full quality, with date and GPS location kept.

## What's in this folder

| Folder | What it is |
|---|---|
| `backend/` | Google Apps Script code. Runs in your Google account, saves files to your Drive. |
| `frontend/` | The page guests see. Static files you host for free. |
| `tools/make_qr_cards.py` | Makes print-ready QR cards (PDF), offline. |
| `tests/security.test.js` | 71 attack tests for the backend. Run with `node tests/security.test.js`. |

---

## Setup (about 30 minutes, once)

Use the Google account whose Drive should hold the photos. Make sure it has enough space
(Google One plans can be upgraded for a month or two around the wedding).

### Step 1 — Create the backend

1. Go to **script.google.com** → **New project**. Name it "Wedding Photos".
2. Delete what's in `Code.gs` and paste the contents of `backend/Code.gs`.
3. Click the gear (**Project Settings**) → tick **Show "appsscript.json" manifest file**.
   Back in the editor, open `appsscript.json` and replace it with `backend/appsscript.json`.
4. At the top of `Code.gs`, edit `SETUP.events`: event names, open/close dates, and an optional PIN.
   Leave `siteUrl` for now.
5. **Deploy → New deployment → Web app.** Execute as: **Me**. Who has access: **Anyone**.
   Click Deploy and approve the permissions.
   - Google will warn "Google hasn't verified this app". That's expected for your own script:
     **Advanced → Go to Wedding Photos**. It asks only for "files this app creates" in Drive,
     not your whole Drive.
6. Copy the **Web app URL** (ends with `/exec`).

### Step 2 — Put the page online

1. Open `frontend/config.js`. Paste the Web app URL into `apiUrl` and set `coupleNames`.
2. Host the `frontend` folder on a free static host that supports the `_headers` file,
   such as **Netlify** (drag-and-drop the folder in the dashboard) or **Cloudflare Pages**.
3. Note the site address, e.g. `https://your-wedding.netlify.app/`.

### Step 3 — Create the QR links

1. Back in Apps Script, set `siteUrl` in `SETUP` to your site address (ending with `/`). Save.
2. Choose the function **setup** in the toolbar and click **Run**.
3. Open **Execution log**. It prints one link per event, **only once**.
   Copy those lines into a text file called `links.txt` and keep it private.

### Step 4 — Make QR cards

```
pip install reportlab
python tools/make_qr_cards.py links.txt --couple "Bride & Groom"
```

Add `--pin Wedding=4821` for each event that has a PIN. This makes `qr-cards.pdf`, one A5 card per event.

**Don't use online QR-code websites** for these links. The link contains the event's key,
and whoever runs that site would get it.

### Step 5 — Test before printing (important)

On an **iPhone and an Android phone**:
1. Scan a card and upload 2–3 photos and one video.
2. Open your Drive and check the folders and files.
3. **Check the GPS location survived.** Download a photo from Drive to a computer and check it:
   Windows: right-click → Properties → Details → GPS. Mac: open in Preview → Tools → Show Inspector → GPS.
   Some phones remove location when sharing to any website, depending on their settings.
   The page and backend never remove it, but if a phone does, it happens before the file leaves the phone.
4. Scan again on the same phone. It should go straight to the upload screen.
5. Try your own name on a second phone. You should see "This name is already here".

To preview the page without any backend, set `demo: true` in `config.js` and open it.

---

## During and after the wedding

- **A QR photo leaked online?** Run `newLinkFor('sangeet')` in Apps Script. The old QR stops
  working immediately. Make a new card from the new link.
- **Change dates or a PIN:** edit `SETUP`, run `setup()` again. Existing QR codes keep working.
- **Add an event:** add it to `SETUP.events`, run `setup()`. Only the new event gets a link.
- **See how much was uploaded:** run `showUsage()`.
- **Close uploads:** they close automatically at each event's `closes` time.
- **Download everything:** in Drive, right-click the "Wedding Photos" folder → Download.

---

## Security

| Risk | Protection |
|---|---|
| Strangers uploading (QR photo leaked) | Each QR has a random 48-character key; keys are stored only as salted hashes. Optional PIN. Uploads only between each event's open and close times. `newLinkFor()` revokes a link. |
| Guessing the PIN | Locked for 10 minutes after 30 wrong tries per event, across all phones. |
| Seeing or deleting others' photos | There is no list, view, download or delete action at all. The Drive folder stays private to you. "Name exists" answers only yes or no. |
| Uploading into someone else's folder | Possible (that's what "Yes, that's me" means), but the person can only add photos, never see or remove any. |
| Viruses or scripts disguised as photos | The backend reads each file's actual contents and accepts only real JPEG, PNG, HEIC/HEIF, WebP, GIF, AVIF, MP4, MOV, 3GP or WebM. Files are renamed; the phone's filename is never used. |
| Tricks in names (`../`, `<script>`) | Names are cleaned: letters of any language, digits, space and `. ' - ( )` only, 2–40 characters. The page never inserts text as HTML. |
| Your Google login leaking | The browser never gets your login or the private Drive upload links. The script can touch only the files it created, not the rest of your Drive. |
| Someone filling your storage | Limits per file (photo 60 MB, video 1 GB), per guest per event (8 GB) and per event (150 GB). Requests per phone are rate-limited. Change these in `LIMITS`. |
| Page tampering | Strict Content-Security-Policy (no outside scripts, can't be framed), HTTPS only, no referrer, no tracking. The key is removed from the address bar after scanning. |

**Known limits, stated plainly:**
- Anyone who has a valid QR (plus PIN, if set) can upload. That's the point of the QR, so protect the cards' photos and use a PIN if you're worried.
- Rate limits per phone can be bypassed by someone determined, but the storage caps still cap the damage.
- Google Apps Script on a free Gmail account allows 20,000 outside calls per day. This design uses one only per 10 MB of large videos (photos don't use any), so a typical wedding stays far below it. It also allows 30 uploads in progress at once; the page waits and retries automatically when busy.

---

## Switching to another cloud later

The page talks to the backend through 5 actions and nothing else. Any backend that answers
them the same way works with the page unchanged. Change `apiUrl` in `config.js` and you're done.

**Option A — stay on Apps Script, change storage:** replace the `Storage` object at the bottom of
`Code.gs`. It needs four functions: `createFolder`, `saveFile`, `beginLargeFile`, `putChunk`.

**Option B — new backend** (e.g. on AWS, Azure, or your own server). Requests are
`POST` with a JSON body (sent as `text/plain`) containing `action`, `event`, `key`, `device`, and `pin` if needed:

| action | extra fields | reply |
|---|---|---|
| `info` | — | `{ok, title, status: "open"\|"not_open"\|"closed", requiresPin, limits:{maxPhotoBytes, maxVideoBytes, singleShotMaxBytes, chunkBytes}}` |
| `check` | `name` | `{ok, exists}` |
| `upload` | `name, size, data` (base64, whole file ≤ singleShotMaxBytes) | `{ok}` |
| `begin` | `name, size, data` (base64 first chunk) | `{ok, session, received, done}` |
| `chunk` | `session, offset, data` | `{ok, received, done}` |

Errors: `{ok:false, code, message}`. Codes used by the page: `ACCESS, PIN, NOT_OPEN, CLOSED, BAD_NAME,
UNSUPPORTED, TOO_BIG, QUOTA, RATE_LIMITED, OFFSET (with expected), SESSION_EXPIRED, SERVER`.

Run the security tests against any new backend's logic before using it.

Existing photos can be copied from Drive to another cloud with a tool like rclone.
