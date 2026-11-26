# Files: a Nextcloud-compatible file server

I want people to keep their own files, synced and shared, using the Nextcloud apps they already have, on a server that costs pennies a month and never makes them wait. Make it feel instant and trustworthy.

- The Nextcloud desktop, phone and web apps connect and sync with no change to the apps
- Syncing 25,000 small files finishes in minutes, not days
- Large files upload in pieces and resume after a dropped connection
- A file edited in two places keeps both, and nothing is ever silently lost
- People share a file or folder with another person, or by a link with a password and an expiry date
- Deleted files go to a trash bin and can be restored; old versions of a file can be restored
- Each person has a storage quota and is told before they run out
- Signing in from a new app uses the login flow and gives that device its own app password, which can be revoked or remotely wiped
- An admin adds and removes people and sees how much space each uses
- Thumbnails show for photos and documents
- Runs on Cloud Run and Cloud Storage, scaling to zero when no one is using it
