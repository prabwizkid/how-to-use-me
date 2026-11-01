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

The **Browse** tab searches every guide people have published, and **Download** saves one to your phone. On your own guides, **Publish to Library** shares them, **Update Public Copy** sends your edits, and **Remove from Library** takes them down. A guide reported by 3 different phones is hidden automatically. Long guides that don't fit inside a QR code get a short label that opens their public copy.

It runs on a free [Supabase](https://supabase.com) project:

1. Create a project, open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it.
2. Put the project URL and its publishable (anon) key in [`www/config.js`](www/config.js), then publish the site.

No accounts are needed. Each published guide gets a random edit key that stays on the phone that published it (only its hash is stored), so only that phone can change or remove it. The app can only call the functions in `schema.sql`; the tables themselves can't be read or written directly.

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

`npm test` runs 108 end-to-end checks in a headless phone-sized browser: every capture method (with real OCR and PDF reading), saving, persistence, HTML export, QR generation, printing, scanning from a photo and from a live (simulated) camera, opening on a second "phone", long guides with cloud links, sharing, backup/restore, import, search, delete, offline mode and script-injection safety, plus the public library (publish, search, download, update, reports, removal, offline) against a local Postgres + PostgREST set up like Supabase. The library tests need Postgres server binaries and `POSTGREST=/path/to/postgrest` ([PostgREST releases](https://github.com/PostgREST/postgrest/releases)).
