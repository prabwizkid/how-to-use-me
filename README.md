# How To Use Me

Make "how to use" instructions for anything — a parking pay station, a tram ticket machine, a horse cart, a fridge, a suitcase lock, a speaker, a plant — and stick a printed QR label on it. Anyone who scans the label sees the instructions.

**Live app:** https://prabwizkid.github.io/how-to-use-me/ (open it on your phone, then "Add to Home Screen")

## What it does

| Brief says | How the app does it |
|---|---|
| Create instructions in multiple ways | **Take photo** (opens the rear camera), **Upload screenshots/photos** (several at once), **Upload file** (PDF, scanned PDF, text, any web page), **paste** a screenshot, or **type**. Text in photos is read on the phone (OCR, works offline) and turned into numbered steps you can edit. |
| Create an HTML page | Every guide becomes a self-contained HTML page (photos embedded) that opens in any browser. |
| Store it on the mobile | Saved in the phone's app storage (survives restarts, works offline). "Download HTML" also saves the file to the phone. |
| Create a QR code, print it, store it | One tap makes a QR label (title + location). Print one label, or a sheet of labels for every guide. Download/share the QR image too. |
| Scan the QR later to get the instructions | In-app live camera scanner, or scan from a photo. A phone's normal camera also works: short guides are packed *inside* the QR code, so they open on any phone, even one without the app or internet. Long guides open from the phone that saved them, or from your cloud link. |
| Store on any cloud of choice | "Share / save to cloud" opens the phone's share sheet → Google Drive, Dropbox, iCloud Drive, OneDrive, Box, etc. Full backup/restore of every guide as one file. Paste a cloud link into a guide so its QR opens the cloud copy. |
| Share with friends | Share the page, the QR image or a link through any app (WhatsApp, Messages, email…). Friends can import a shared page into their own app. |

## Public library (search and download other people's guides)

The **Browse** tab searches every guide people have published, and **Download** saves one to your phone. On your own guides, **Publish to Library** shares them, **Update Public Copy** sends your edits, and **Remove from Library** takes them down. Long guides that don't fit inside a QR code get a short label that opens their public copy.

It runs on a free [Supabase](https://supabase.com) project:

1. Create a project, open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it (safe to re-run; it upgrades in place).
2. In the SQL editor run `select library_private.admin_new_key();` once and keep the key in a password manager.
3. Put the project URL, its publishable (anon) key and a contact e-mail in [`www/config.js`](www/config.js), then publish the site.
4. Moderate at `/admin.html` with the admin key.

### What the database enforces

Everything below is checked by the database itself, so a modified app or a script can't get around it. The app checks the same rules first only to show clear messages.

- **Only guides can be stored.** A fixed set of fields (title, what it's for, location, steps, notes, photos), all plain text: no links, e-mail addresses, hidden or control characters, or long code-like strings. No other fields are accepted.
- **Only real photos.** Up to 4 JPEG/PNG/WebP images of at most 250 KB, verified byte by byte (correct file signature, nothing appended after the image). SVG and anything else are refused. The app also re-draws photos before upload, stripping hidden data. Photos stay hidden until an admin approves them.
- **No duplicates.** The same steps (ignoring case, spaces and punctuation) can't be published twice; the app offers to open the existing guide. Duplicate photos and padded repeated steps are refused.
- **No empty or junk guides.** A real title and 1 to 60 real steps; garbled scanning text and words on the admin's blocked list are refused.
- **Abuse limits.** Publishing and reporting need a small proof-of-work puzzle (about a second on a phone) and are rate limited per network and overall; publishing stops before the free database fills up. Download counts and reports count once per network (a salted hash of the address; addresses aren't stored).
- **Moderation.** 3 reports from different networks hide a guide until reviewed. The admin page can approve or remove photos, restore, mark as fine (reports no longer hide it), hide, delete any guide (e.g. if someone loses their edit key), ban a publisher's network, edit blocked words and change limits.
- **No direct access.** No table can be read or written through the API; internal helpers (including creating admin keys) can't be called. Public results never include edit-key hashes or network hashes.
- **Ownership.** Each published guide has a random edit key kept on the publishing phone; only its hash is stored. Backups contain these keys, so only share backups with people you trust.

The scanner never opens links on its own; it shows which website a label points to first, and marks guides stored inside a label (not from the library) as unchecked.

## Run it

```
npm run serve        # then open http://localhost:8080 on your phone/computer
```

For QR codes to work with other phones' cameras, host the `www/` folder on any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages) and put that address in **Cloud & Settings → Public web address**. The app is also installable from the browser (Add to Home Screen).

## Updating the live site

The site is served by GitHub Pages from the `gh-pages` branch, which holds the contents of `www/`. After changing `www/`, commit and run:

```
git subtree split --prefix www -b gh-pages && git push origin gh-pages
```

## Publish to Google Play / App Store (Capacitor)

```
npm install
npm run android      # opens Android Studio → Build → Generate Signed Bundle
npm run ios          # opens Xcode (needs a Mac) → Product → Archive
```

Before building, add camera permission:
- Android `android/app/src/main/AndroidManifest.xml`: `<uses-permission android:name="android.permission.CAMERA" />`
- iOS `ios/App/App/Info.plist`: `NSCameraUsageDescription` = "Scan QR labels and photograph instructions", plus `NSPhotoLibraryUsageDescription`.

Inside the store app, sharing and saving use the native share sheet and Documents folder (`@capacitor/share`, `@capacitor/filesystem`).

## Tests

`npm test` runs 185 end-to-end checks in a headless phone-sized browser: every capture method (with real OCR and PDF reading), saving, persistence, HTML export, QR generation, printing, scanning from a photo and from a live (simulated) camera, opening on a second "phone", long guides with cloud links, sharing, backup/restore, import, search, delete, offline mode and script-injection safety, plus the public library (publish, search, download, update, reports, removal, offline, admin page) and 66 attack tests against the library's rules, all against a local Postgres + PostgREST set up like Supabase. The library tests need Postgres server binaries and `POSTGREST=/path/to/postgrest` ([PostgREST releases](https://github.com/PostgREST/postgrest/releases)).
