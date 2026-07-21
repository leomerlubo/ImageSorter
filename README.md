# Park Avenue Appliance Image Sorter

Vercel version of the original Google Apps Script application. The interface and Firebase Authentication remain in the browser. Server operations now run through a Vercel Function using the Firebase Admin SDK.

## What changed

* `google.script.run` is replaced by an authenticated `/api/rpc` bridge.
* The signed in Firebase ID token is verified on every server request.
* The server derives the worker email from the verified token, not from browser input.
* Firestore task claiming and saving use transactions to reduce duplicate work.
* Existing Firestore collections and documents remain compatible.

The old spreadsheet menu and Apps Script trigger are not part of the hosted app. `FirebaseImport.gs` is retained under `legacy/` as a reference for the original one time Google Sheets import.

## Firebase preparation

1. Open Firebase Console for `paa-website-image-sorter`.
2. In Authentication, keep Google as an enabled sign in provider.
3. In Project settings, open Service accounts and generate a new private key.
4. Never place that JSON key in `public/` or commit it to Git.
5. Add the final Vercel domain under Authentication, Settings, Authorized domains.

## Vercel environment variables

Copy the values from the service account JSON into Vercel Project Settings, Environment Variables:

* `FIREBASE_PROJECT_ID`
* `FIREBASE_CLIENT_EMAIL`
* `FIREBASE_PRIVATE_KEY`

For `FIREBASE_PRIVATE_KEY`, paste the full private key. Both literal line breaks and escaped `\\n` values are supported.

Optional access restrictions:

* `ALLOWED_EMAIL_DOMAINS=parkaveappliance.com`
* `ALLOWED_EMAILS=person1@example.com,person2@example.com`

If both optional values are blank, any Google user permitted by Firebase Authentication can enter, matching the original app behavior.

## Deploy

1. Upload this folder to a new GitHub repository.
2. In Vercel, select Add New, Project, then import the repository.
3. Add the environment variables above.
4. Deploy.
5. Add the resulting Vercel domain to Firebase Authentication authorized domains.

For local development, install the Vercel CLI, copy `.env.example` to `.env.local`, fill in the credentials, and run `npm install` followed by `npm run dev`.

## Existing Firestore data

The application continues using these collections:

* `tasks`
* `settings`, document `app`
* `userStats`

No data migration is required if the existing Apps Script app already imported the tasks into the same Firebase project.

## Security note

The Firebase web API key in `public/index.html` is a public client identifier and is expected in a browser app. The service account private key is secret and must exist only in Vercel environment variables.
