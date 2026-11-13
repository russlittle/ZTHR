# Community resource guide

Staying in college often depends less on coursework than on rent, food, a ride, a sitter or a shut-off notice. A whole community stands ready to help with those: colleges, county and state offices, nonprofits, congregations and neighbors. But it is spread out, and no student can keep track of all of it. The resource guide gathers that community for a region into one place, organized by the barriers students face, kept true by agents, and turned by the Advocate into the few things worth doing now, so a student facing a hard week can see who is there for them.

The student has the whole guide. Nothing in it is hidden from them, and they can browse it by barrier, by kind of provider, by what is open now or near them. The Advocate's job is the opposite of a directory: to turn everything into a small number of clear signals, each with the next step already worked out.

```mermaid
flowchart LR
  subgraph keep[Kept true by agents]
    scouts[Scouts find services<br/>from sources of record] --> gates{Admission gates}
    gates -- pass --> guide[(The guide)]
    gates -- fail --> register[Register,<br/>with a reason and an expiry]
    guide --> verify[Re-verified on a schedule]
    verify --> guide
    feedback[Students say whether<br/>it helped] --> guide
  end
  subgraph use[Used by the student]
    checkin[One-question check-ins] --> barriers[Open barriers]
    student[What the student tells the Advocate] --> barriers
    barriers --> match[Matching]
    guide --> match
    match --> signals[A few signals on Today]
    match --> plans[Support packages,<br/>care plans, success plans]
    guide --> explore[Explore the whole guide]
  end
```

## Who sees what

The guide's entries describe services, not people, so the guide is public: anyone can browse it without signing in, from a student to a counselor to a neighbor looking for help. Everything about a student (their barriers, their check-in answers, their plans and which resources they used) is private to that student and shared only by their choice.

## Barriers: the taxonomy

The guide is organized the way a student experiences trouble, not the way agencies are organized. Each barrier is a service facet in the sense of the Open Eligibility taxonomy (Open Referral, CC BY-SA 3.0); situations, the second facet, describe who is asking.

| Barrier | Covers | Example resources |
| --- | --- | --- |
| Emergency | No safe place tonight, no food today, a crisis | Shelter intake, 2-1-1, crisis lines, emergency food |
| Food | Running short, no money for groceries, no way to cook | Campus pantries, food banks, SNAP, community meals |
| Housing | Behind on rent, facing eviction, unstable, homeless | Rental assistance, eviction help, shelters, housing navigation |
| Utilities | A shut-off notice, a high bill, heat in winter | HEAP and the winter crisis program, utility hardship funds |
| Money | A bill coming due, a gap before payday, an emergency | College emergency grants, assistance funds, tax help |
| Transportation | No reliable way to class or work | Transit passes, ride programs, car repair funds |
| Child care | No care for class or shifts | Child care subsidies, campus care, sick-child options |
| Health | Care, prescriptions, insurance | Clinics, Medicaid, sliding-scale care |
| Mental health | Stress, anxiety, grief, a hard week | Campus counseling, community mental health, warmlines |
| Safety | Not safe at home or in a relationship | Domestic violence services, protection orders, safe housing |
| Legal | Eviction, records, immigration, benefits appeals | Legal aid, clinics, expungement help |
| Digital access | No phone, internet or computer | Lifeline, low-cost internet, device loans |
| Goods | Clothing, hygiene, furniture, school supplies | Closets, drives, congregations |
| Documents | No ID, birth certificate or Social Security card | ID clinics, vital records help |
| Work | Hours cut, job lost, a better job | Workforce centers, job training, unemployment |
| Academic | Falling behind, a disability, tutoring | Tutoring, disability services, advising |

Situations are not barriers; they change which resources fit: student parent, working student, veteran, former foster youth, first in family, returning adult, student with a disability, a student without a car.

## Providers

Every entry says who provides it, because a student deciding whether to walk in somewhere wants to know.

| Kind | Level | Examples |
| --- | --- | --- |
| College | The student's college | Pantry, emergency grant, counseling, disability services |
| Government | Federal, state, county, city | SNAP, HEAP, county job and family services, city programs |
| Nonprofit | Regional or local | Food banks, community action agencies, legal aid |
| Faith-based | Congregations and their charities | Food pantries, rent help, clothing closets |
| Community | Neighborhood groups, mutual aid | Free stores, community fridges, ride shares |
| Health | Hospitals and clinics | Community health centers, behavioral health |

Faith-based providers are listed with what they ask of the people they serve, stated plainly: whether help depends on attending a service, and whether it is open to anyone.

## The data

The entries follow the Open Referral Human Services Data Specification (organization, service, location, schedule, eligibility), extended with what the Advocate needs to do the legwork and what the agents need to keep it true.

```mermaid
erDiagram
  ORGANIZATION ||--o{ SERVICE : provides
  ORGANIZATION {
    string id
    string name
    string kind "college government nonprofit faith community health"
    string level "federal state county city local"
    string url
  }
  SERVICE ||--o{ LOCATION : "offered at"
  SERVICE }o--o{ BARRIER : addresses
  SERVICE }o--o{ SITUATION : "fits best"
  SERVICE ||--|| ELIGIBILITY : "who qualifies"
  SERVICE ||--|| HOW_TO_USE : "how to use it"
  SERVICE ||--o{ AVAILABILITY : "what is known now"
  SERVICE ||--o{ VERIFICATION : "checked by"
  SERVICE ||--o{ FEEDBACK : "rated by"
  SERVICE {
    string id
    string name
    string description
    string sourceUrl "the source of record"
    date verifiedOn
    int freshnessDays
    string status "admitted held retired"
  }
  LOCATION {
    string address
    string city
    string county
    string hours "unknown means call ahead"
    string phone
    bool transitNearby
  }
  ELIGIBILITY {
    string rule "machine-checkable when published"
    string text "the source's own words, simplified"
  }
  HOW_TO_USE {
    string steps
    string documents
    string whatToExpect
    string prefill "fields the Advocate can fill"
  }
  AVAILABILITY {
    string fact "rules-match applications-open funding-confirmed response-time"
    string value
    string source
    date checkedOn
  }
  VERIFICATION {
    date ranOn
    string result "confirmed changed gone unreachable"
    string evidence "status, final address, matched terms"
  }
  FEEDBACK {
    string from "student staff"
    string outcome "helped tried-not-helped could-not-reach"
    date on
  }
  STUDENT ||--o{ STUDENT_BARRIER : has
  STUDENT_BARRIER }o--|| BARRIER : of
  STUDENT_BARRIER {
    string openedBy "check-in student advocate"
    string urgency "tonight soon someday"
    string status "open in-progress resolved"
    date openedOn
    date resolvedOn
  }
  STUDENT ||--o{ PLAN : owns
  PLAN }o--o{ SERVICE : includes
  PLAN {
    string kind "support-package care-plan success-plan"
    string steps
    string sharedWith "nobody unless the student chooses"
  }
```

## Keeping it true: agents and their governance

The guide is maintained the way the application is built: agents do the work, and gates decide what is admitted. A person signs only destructive changes.

| Agent | Does | Held to |
| --- | --- | --- |
| Scout | Finds services for one county and one barrier from sources of record: agency pages, college pages, 2-1-1 listings, published directories | Cites a source for every fact; a precision datum (the share of its entries that verify) below which it retires and its entries are held |
| Verifier | Re-reads each entry's source on its freshness schedule | Records what it saw: status, final address, the terms it matched |
| Editor | Writes how to use it: steps, documents, what to expect, in plain language | The reading-level gate; never adds a fact the source does not state |
| Curator | Merges duplicates, assembles support packages, retires what is gone | Merges and removals wait for a person's signature |
| Auditor | Samples admitted entries and checks them by an independent route (a second source, a phone listing) | Its sample results set each scout's precision |

```mermaid
flowchart TD
  found[A scout proposes an entry] --> g1{Source cited and reachable}
  g1 -- no --> held[Held in the register]
  g1 -- yes --> g2{The page still describes the service}
  g2 -- no --> held
  g2 -- yes --> g3{Barrier, provider, county,<br/>eligibility and contact structured}
  g3 -- no --> held
  g3 -- yes --> g4{Not a duplicate}
  g4 -- no --> merge[Merge proposed;<br/>a person signs]
  g4 -- yes --> g5{How to use it is written<br/>at the student's reading level}
  g5 -- no --> held
  g5 -- yes --> admitted[Admitted to the guide]
  admitted --> again[Re-verified when its freshness runs out]
  again --> ok{Result}
  ok -- confirmed --> admitted
  ok -- changed --> found
  ok -- gone or unreachable twice --> retire[Retirement proposed;<br/>a person signs]
```

An entry that cannot be verified is never silently dropped and never shown as current: it goes to the register with a reason and an expiry, and the student sees it marked "not confirmed recently, call first".

## What is known, said separately

A program can exist, match a student and still not help in time. The guide keeps four facts apart, each with its source and the day it was checked, and says "not known" when nobody publishes it.

| Fact | Example | Where it comes from |
| --- | --- | --- |
| The rules match | "You meet the published income rule" | The eligibility engine, from what the student told the Advocate |
| Applications are open | "Taking applications this month" | The provider's page or listing |
| Funding or appointments are available | "Appointments this week" or "not known" | Only a provider or a partner college can confirm this |
| How long it takes | "Usually decides within 10 days" | The provider, or what other students reported |

## How good it is: feedback

After a student uses a resource, the Advocate asks one question: did it help? The answers (helped, tried and it did not help, could not reach them) become the entry's record, shown as plain counts ("helped 14 of 19 students who tried, this term") once there are enough to mean something. A resource that rarely helps is flagged to the curator, not hidden, because it may still be the only one.

## Check-ins: finding barriers without a form

Every so often, at the rhythm the student chose, the Advocate asks one question. A student can skip any question or turn check-ins off.

| Barrier | Question | Source |
| --- | --- | --- |
| Food | Within the past 12 months, did you worry that your food would run out before you got money to buy more? | Hunger Vital Sign (Hager et al., 2010), free to use with citation |
| Housing | What is your living situation today: a steady place, a place but worried about losing it, or no steady place? | Adapted from the CMS Accountable Health Communities screening tool; reuse needs the item author's citation and notice, registered until cleared |
| Housing, tonight | Do you have a safe place to stay tonight? | Written for the Advocate; a "no" is an emergency |
| Utilities | Has a utility company threatened to shut off your electric, gas or water? | Adapted from the CMS screening tool, as above |
| Transportation | Has not having a reliable ride kept you from class or work? | Adapted from the CMS screening tool, as above |
| Money | Is a bill coming up that you are worried about? | Written for the Advocate |

A "yes" opens a barrier. It stays open, and the Advocate includes it in every recommendation and plan, until the student says it is resolved. If the student goes quiet, the Advocate asks again later, gently; a barrier never closes on its own.

```mermaid
stateDiagram-v2
  [*] --> Open: a check-in answer, the student says so, or the Advocate infers it and asks
  Open --> InProgress: the student starts a step
  InProgress --> Open: the step did not help
  InProgress --> Resolved: the student says it is resolved
  Open --> Open: asked again after a quiet stretch
  Resolved --> Open: it comes back
  Resolved --> [*]
```

"No safe place tonight" skips the queue: the answer is shelter intake, 2-1-1 and the crisis line, at the top of the screen, in plain words, with the next step for tomorrow after that.

Barrier answers are sealed like the Advocate's other sensitive fields: never shown to an advisor or a college unless the student shares them, and followed by the planted-marker trace on every build.

## From everything to a few signals

Matching scores each admitted service against each open barrier, and the Advocate shows at most three signals on Today, each with the step already worked out. The order is:

1. **Urgency.** Tonight before this week; a shut-off date before a someday.
2. **Deadlines.** An application that closes before a rent due date.
3. **Fit.** The rules match, applications are open, and nothing known rules it out.
4. **Reach.** Open now, near the student or on a bus line, at a time the student is free.
5. **Record.** How often it has helped students like this one.

Everything else stays one tap away, in the guide, filtered to the student's open barriers.

## Packages and plans

The guide's entries combine into three kinds of plan, each owned by the student.

| Plan | Scope | Example |
| --- | --- | --- |
| Support package | One barrier, the usual combination of help | Short on rent: the college emergency grant, county emergency assistance, 2-1-1, and how to ask the landlord for time |
| Care plan | This student's open barriers together, with steps and dates | Rent short and the car is down: the grant application first, a transit pass to get there, a reminder when a decision is due |
| Success plan | The term: classes, work, care and support together | Shared with an advisor only if the student chooses, and only the parts the student picks |

Each step in a plan is followed to its end: applied, missing information resolved, decided, help received, or another route taken.

## Evidence

| Gate or record | Shows |
| --- | --- |
| Resource admission | Every admitted entry has a cited, reachable source; structured barrier, provider, county and eligibility; and how-to-use text at the reading level |
| Link and content QA | Each verification run, published: what was checked, what was found, what changed |
| Freshness | No entry is shown as current past its freshness; a ratchet on the share of entries verified on time |
| Precision audit | Each scout's sampled precision against its datum |
| Check-in fidelity | Each question matches its cited source's wording, or is marked as written for the Advocate |
| Barrier lifecycle | No sequence of answers closes a barrier the student did not resolve |
| Sensitive trace | Barrier answers never reach an advisor, a college or a log unless the student shares them |
| Matching journeys | Locked journeys for compound situations: a student short on rent, without a ride and with a sick child gets the right three signals |
