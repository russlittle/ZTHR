# Files

A file server that the Nextcloud apps you already have connect to and sync with, unchanged. It runs on Cloud Run and Cloud Storage, scales to zero, and costs what its storage costs when nobody is using it.

It is the first product of the ZTHR factory's line: almost all of it is the factory's standard blocks, and what is particular to Files is a thin layer of protocol on top. Clean-room: written from the published client protocols and the observed behaviour of a running server, with no Nextcloud code. Apache 2.0.

## How it fits together

```mermaid
flowchart TB
  subgraph Clients["Unchanged Nextcloud clients"]
    D[Desktop sync]
    M[Phone apps]
    W[Any WebDAV client]
  end
  subgraph Files["Files: the protocol layer"]
    R[Router and sign-in]
    DAV[WebDAV: files, uploads, trash, versions, locks]
    OCS[OCS: capabilities, sharing, people, app passwords]
    P[Pages: login flow, public links, status]
    V[Each person's view: own files plus shares, permission letters, quota]
  end
  subgraph Blocks["Standard blocks"]
    T[tree]
    O[objects]
    U[uploads]
    L[leases]
    G[grants]
    DV[devices]
    X[dav]
    RT[retention]
    RS[resilience]
  end
  subgraph Store["Google Cloud"]
    B[(Cloud Storage\nbytes)]
    S[(Cloud Storage\nstate log and snapshots)]
  end
  Clients --> R --> DAV & OCS & P
  DAV & OCS & P --> V
  V --> T & O & U & L & G & DV
  DAV --> X
  V --> RT
  O --> B
  T & G & DV & U --> S
  O -. retries .-> RS
```

| Block | What it does in Files |
| --- | --- |
| tree | Folders and files with stable ids; a change re-tags every folder above it, so an app skips unchanged folders in one comparison |
| objects | Bytes streamed once with checksums computed on the way; byte ranges; joins done in the bucket |
| uploads | Chunked uploads in any order, resumable, quota checked before the first byte, idle uploads swept |
| leases | WebDAV locks that end on their own |
| grants | Shares with people, groups and links: never more than the giver has; link passwords hashed and throttled; expiry |
| devices | The browser sign-in for a new app, an app password per device, revoke one, wipe one |
| dav | The XML reader (no DTDs, so no external entities) and the multistatus writer |
| retention | Plans what the trash and old versions give up each night |
| resilience | Timeouts and jittered retries on every call to Cloud Storage |
| oracle | Checks Files against a real Nextcloud, request by request |

## What it keeps

Bytes are objects in the bucket, named by random keys, never by file names. Everything else is records in one state, kept as a log.

```mermaid
erDiagram
  PERSON ||--o{ NODE : owns
  PERSON ||--o{ DEVICE : "signs in with"
  NODE ||--o{ NODE : contains
  NODE ||--o{ GRANT : "shared by"
  NODE ||--o{ VERSION : "earlier copies"
  PERSON ||--o{ TRASHED : deleted
  PERSON ||--o{ SESSION : uploading
  PERSON {
    string id
    string display
    string passwordHash "scrypt"
    int quota "null is no limit"
    bool admin
    string[] groups
  }
  NODE {
    int id "stable; kept through moves and restores"
    int parent
    string name
    string kind "file or folder"
    int size "a folder's is everything inside"
    string etag "changes with it and every folder above"
    int mtime
    string blob "object key, for a file"
    string[] checksums
  }
  GRANT {
    int id
    int resource
    string kind "person, group or link"
    int permissions "read 1, update 2, create 4, delete 8, share 16"
    string token "for a link"
    string passwordHash "for a link, optional"
    int expires
  }
  DEVICE {
    int id
    string name
    string hash "sha256 of the app password"
    bool wipe
  }
  VERSION {
    string id
    string blob
    int size
    int closedAt
  }
  TRASHED {
    string id
    string original
    int deletedAt
  }
  SESSION {
    string id
    string destination
    map chunks
  }
```

The state is a write-ahead log: each change appends only the records it touched, a snapshot every 2,000 entries lets the older ones go, and a restart replays the snapshot and what follows it. A request that changes anything is answered only after its entry is written, so nothing a client was told is saved can be lost. A second writer is refused rather than interleaved.

## How an app signs in

```mermaid
sequenceDiagram
  participant A as Desktop app
  participant F as Files
  participant B as Browser
  A->>F: POST /index.php/login/v2
  F-->>A: poll token, and a sign-in page address
  A->>B: opens the sign-in page
  loop until approved
    A->>F: POST /login/v2/poll (token)
    F-->>A: 404 not yet
  end
  B->>F: login name and password
  F->>F: issue an app password for this device, keep only its hash
  A->>F: POST /login/v2/poll (token)
  F-->>A: server, login name, app password (once)
  A->>F: every request after: Basic login name : app password
```

## How a large file arrives

```mermaid
sequenceDiagram
  participant A as App
  participant F as Files
  participant S as Cloud Storage
  A->>F: MKCOL /uploads/ana/id (Destination, total length)
  F->>F: quota checked now, before any bytes
  par chunks, in any order
    A->>F: PUT /uploads/ana/id/00002
    F->>S: one object
  and
    A->>F: PUT /uploads/ana/id/00001
    F->>S: one object
  end
  A->>F: MOVE /uploads/ana/id/.file
  F->>S: compose (32 at a time)
  F->>F: one log entry: the file node and its folders
  F-->>A: 201, etag, file id
```

## Measured

| Journey | Result | Where |
| --- | --- | --- |
| 25,000 small files, six at a time, as the desktop app sends them | 14.1 s (1,779 a second; p95 7.3 ms) | This machine, disk store, server in process (`node tools/load.ts 25000 disk`) |
| Listing all 100 folders of those files | 0.4 s | Same run |
| Checking that nothing changed | 0.7 ms: one root etag | Same run |
| One small file write, logged | under 2 KB, whatever the tree's size | `test/state.test.ts` |

On Cloud Run each write adds an object upload and a log entry to the bucket; those numbers come from the first deployed run, and the CI job records the in-process run on every change.

## What works, and what does not yet

| Works | Not yet |
| --- | --- |
| Login flow v2, app passwords, revoke, remote wipe | The Nextcloud web interface (it is server-rendered PHP; Files has its own pages only for sign-in and links) |
| Files over WebDAV: list, read, ranges, write, folders, move, copy, delete | Thumbnails and previews (`has-preview` is false) |
| Chunked upload v2, resumable, with quota up front | Bulk upload, and the older chunking v1 |
| If-Match and If-None-Match: no silent overwrite | Downloading a whole folder as a ZIP |
| Versions: every overwrite kept, restore keeps the replaced copy | Calendars and contacts (CalDAV, CardDAV: the dav block is ready for them) |
| Trash: delete, list, restore with the same id, purge, nightly sweep | Push notifications of changes (apps poll instead) |
| Shares with people, groups and links; permissions; passwords; expiry | Federation, end-to-end encryption, group folders, the app store |
| Quotas, admins adding and removing people | Comments and tags beyond favourites |
| WebDAV locks with time limits | |
| Cloud Storage for bytes and state, on Cloud Run | A document database for state at more than one instance |

## Run it

```bash
cd files
FILES_STORE=disk FILES_DIR=./data FILES_ADMIN=admin FILES_ADMIN_PASSWORD='a long password' node src/main.ts
node --test "test/**/*.test.ts"
node tools/load.ts 25000 disk
```

Node 22.18 or later runs it directly: there is no build step and no dependency. Deploying: [deploy/README.md](deploy/README.md).
