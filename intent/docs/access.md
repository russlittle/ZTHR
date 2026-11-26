# Who can use the tools on zthr.ai

The studio, the factory console and mission control on zthr.ai sit behind Google sign-in, by invitation. The code is open
source under Apache 2.0, and anyone can run their own copy; the hosted copy is for invited people while it is being proved.

```mermaid
sequenceDiagram
  participant P as Person
  participant S as zthr.ai page
  participant G as Google sign-in
  participant F as Firestore (rules)
  P->>S: opens /intent
  S-->>P: only the bar and "Sign in with Google"
  P->>G: signs in (redirect, zthr.ai as the auth domain)
  G-->>S: a verified Google account
  S->>F: read access/{their email}
  alt invited and active
    F-->>S: the invitation
    S-->>P: the tools open; work saves to workspaces/{uid}
  else not invited, paused or unverified
    F-->>S: denied or missing
    S-->>P: "Not invited yet", and a way to switch account
  end
```

**What holds the line.** Firestore's rules (`firestore.rules`, at the root of the repository), not the page. A signed-in
person may read only their own invitation. Only an invited, active, verified person may read or write their own
workspace. No browser may list invitations or write one, including its own. The page only decides what to show; the
scripts are public, as the code is.

**What the gate does not do.** It does not hide the page's files: the JavaScript is served to anyone, as it is on
GitHub. Anything that must stay private (saved work today; a model reading service or factory runs later) is reached
only through Firestore or a service that checks the person's Google token and their invitation the same way.

## Setting it up, once

The repository holds no project settings: the page reads Firebase's own web configuration from
`/__/firebase/init.json`, which Firebase Hosting serves for the project. These steps are a person's, in the consoles
and Cloud Shell.

1. **Turn on Google sign-in.** Firebase console, Authentication, Sign-in method: enable Google.
2. **Allow the domain.** Authentication, Settings, Authorized domains: make sure `zthr.ai` is listed.
3. **Allow the redirect.** Google Cloud console, APIs and services, Credentials: on the OAuth web client Firebase made,
   add `https://zthr.ai/__/auth/handler` as an authorized redirect URI. The page uses the site's own domain as the
   auth domain, so sign-in works in browsers that block third-party storage.
4. **A second lock, if you want one.** On the OAuth consent screen, keep the app in Testing and list the people as
   test users. Google then refuses anyone else before they ever reach the invitation check.
5. **Create the database, if there is none.** In Cloud Shell:
   `gcloud firestore databases create --location=nam5 --project=zthr-ai`
6. **Check the rules, then deploy them.** In Cloud Shell, from the repository:
   `cd intent/rules-test && npm ci && npm test`, then from the root:
   `npx firebase-tools deploy --only firestore:rules --project zthr-ai`.
   The site's own deploy publishes hosting only; rules change only when a person deploys them.
7. **Invite people.** `bash intent/tools/invite.sh add person@example.com "Their name"`. `pause` closes the door
   without deleting the record; `list` shows who is invited.

8. **Reports and triage.** `bash intent/tools/invite.sh feedback on` turns on Report a problem for everyone invited;
   `off` turns it off at once, with no release. `bash intent/tools/invite.sh admin person@example.com` lets an invited
   person triage. Reporters see their own reports and where each stands; admins see all of them, set status and
   severity, and leave a note the reporter sees. The rules refuse anything else: nobody files as someone else, nobody
   rewrites what a person said, and nobody deletes a report.

Until step 1 is done, the pages say sign-in is not set up and stay closed.

## Running your own copy

`npm run build -- --open` builds the tools with no door, for local checks or a private deployment of your own.
