# Product Lines: Deciding Once for a Family of Products

**Patterns for the defaults a product line hands every product in it, and how a product states only what is different**

Russ Little · Pattern paper · Draft for review · Nov 26, 2026

v0.1 · Request for comments · © 2026 Russ Little. Licensed under CC BY 4.0. Part of the series rolled up in [The Line](the-line.md).

## Abstract

Most decisions about a new product were already made for the last one: which compliance frameworks apply, how people sign in, where tickets and chat go, whether there is an API, how feedback is taken, how use is measured. When each product makes them again, they come out slightly different each time, and the differences are rarely intended. A product line decides them once, for everyone it serves, and hands every product in it the same starting point. It is a family, and one family holds many products, each built separately on the line. A product inherits the line's decisions, sees each as the line's, and states only what is different. This paper sets out six patterns for product lines and the rules that keep inherited decisions visible.

## Where it sits

Product lines sit inside mission control, the front office, and each product line houses an intent studio: the studio is where a product in the line is defined, and it asks only what the line has not already decided. The discipline is product line management, to the standard of APQP planning. It is done by a person. It takes in the plant's priorities from mission control and gives products to define, each with its family's defaults.

```mermaid
flowchart LR
  MC["Mission control<br/><small>priorities</small>"] --> PL
  subgraph PL["Product line: a family"]
    D["Defaults and reference system"]
    IS["Intent studio"]
    D --> IS
  end
  IS -- "signed intent package, per product" --> PE[Product engineering]
```

```mermaid
erDiagram
  PRODUCT_LINE ||--o{ PRODUCT : holds
  PRODUCT_LINE ||--|| DEFAULTS : sets
  PRODUCT_LINE ||--o| REFERENCE_SYSTEM : "measured against"
  PRODUCT ||--o{ OVERRIDE : records
  DEFAULTS ||--o{ OVERRIDE : "changed by"
  PRODUCT_LINE {
    string id
    string serves
    string end
    int revision
  }
  DEFAULTS {
    string compliance
    string identity
    string tickets
    string chat
    string feedback
    string api
    string usage
  }
  PRODUCT {
    string id
    string intent
    int lineRevisionTaken
  }
  OVERRIDE {
    string choice
    string value
    string reason
  }
  REFERENCE_SYSTEM {
    string name
    string version
  }
```

> **Central proposition.** Decide what a family of products shares once, at the line; let each product start from it, see it, and change only what is truly different, on the record.

## 1. The problem

- **Repeated decisions drift.** Ten products decide sign-in ten times and end up with four methods.
- **Hidden defaults.** A default nobody chose is still a decision, and nobody can say who made it.
- **Copying is not inheriting.** A product copied from another keeps its decisions but loses the link: a later fix to the original never reaches the copy.

```mermaid
flowchart TB
  LINE["Product line<br/><small>who it serves, the end it serves,<br/>and the defaults</small>"]
  LINE --> P1[Product A]
  LINE --> P2[Product B]
  LINE --> P3[Files]
  P1 -.states only what differs.-> D1[override: no public API]
  P3 -.states only what differs.-> D3[override: sign-in by app password per device]
```

## 2. Principles

**A product line is a decision, not a template.** Its defaults are choices someone made and answers for. Every product shows each inherited choice as the line's until its holder confirms or changes it.

**Inheritance keeps the link.** A product refers to its line; it does not copy it. A change to the product line is seen by every product in it, and each holder decides whether their product takes it.

## 3. Patterns

### Pattern 1. The Product Line Before the Product

**Problem.** Products are started one at a time, and the family they belong to is discovered later.

**Pattern.** A product is started inside a product line. The line names who its products serve and the end they serve, so every intent in it starts with its end in mind already stated, and the intent studio inside the line opens with the line's defaults in place.

**Consequences.** A product's schematic opens with its why filled in, attributed to the line.

### Pattern 2. Defaults Are Decisions

**Problem.** Defaults that nobody chose become permanent without anyone deciding.

**Pattern.** A product line sets each of its spec-sheet choices explicitly: the compliance frameworks in scope; the identity provider people sign in with; where the plant's progress goes (tickets); where notes go as each area finishes (chat); how people report problems (feedback); which interfaces are open (an API per feature, events, agent tools); and how use is measured. Each is recorded with the line, and none is left blank.

**Consequences.** Every product in a line has the same answers to the same questions, and anyone can see who chose them.

| Choice | What it decides for every product in the line |
| --- | --- |
| Compliance | Which frameworks' controls are in scope, and so which evidence every release carries |
| Identity | How people sign in |
| Tickets | Where the plant's progress is reported |
| Chat | Where a note goes as each area finishes |
| Feedback | How people report a problem, and where it lands |
| API | Which interfaces are switched on: per-feature APIs, events, agent tools |
| Usage | How use is measured, with consent |

### Pattern 3. Inherited, and Shown as Inherited

**Problem.** An inherited decision looks the same as one the product made, so nobody questions it.

**Pattern.** On a product's schematic, every line default is shown with its source (the line) and its state (assumed) until the holder confirms it. Confirming makes it the product's own; changing it records an override with a reason.

**Consequences.** A product's specification says exactly which decisions are its own.

### Pattern 4. An Override Says Why

**Problem.** Exceptions accumulate until the line means nothing.

**Pattern.** A product may change any inherited choice, and the change records a reason. Mission control lists every override across the line, so a choice overridden by most products is visibly the wrong default.

**Consequences.** A line's defaults are tested by its products, and a bad default is found by the count of its overrides.

### Pattern 5. One Product, One Intent, One Product Line

**Problem.** A product that belongs to two families inherits contradictions.

**Pattern.** A product belongs to exactly one product line. Something that seems to belong to two is either two products sharing assemblies, or a line that should be split.

**Consequences.** Every product has one set of defaults and one place they come from.

### Pattern 6. Change the Product Line on the Record

**Problem.** Changing a line silently changes every product in it.

**Pattern.** A change to a product line is a revision with a reason, like a change to an intent. Each product in the line sees the change and its holder decides whether to take it into their next revision. Mission control shows which products have and have not.

**Consequences.** A line evolves without surprising any product, and the lag between line and product is a visible reading.

```mermaid
sequenceDiagram
  participant G as Product line owner
  participant L as Product line
  participant P as Each product's holder
  participant M as Mission control
  G->>L: revision 2: compliance adds a framework (reason)
  L-->>P: the change, shown on each schematic as the line's
  P->>P: take it into the next revision, or record why not
  P-->>M: taken / declined with reason
  M-->>G: products on revision 2, products not
```

## 4. Files in its product line

Files is the first product of a product line, file services compatible with Nextcloud, and the line's reference system is Nextcloud. The family it belongs to is self-hosted collaboration services: products that keep people's own information on infrastructure they control, open to the clients they already use. Its defaults are that people sign in with credentials the service issues, that APIs are open and documented, that no usage is measured without consent, and that every product is held to the line's privacy controls. Files inherits them all and records one override: each app signs in with its own app password, issued through a browser sign-in, because the apps it serves expect it.

A second product in the same line (calendars and contacts over CalDAV and CardDAV) would start with all of that already decided, and with the line's blocks for device sessions, grants and the DAV core already built.

## 5. Evaluating it

- **Coverage.** Every spec-sheet choice of every product line is set; none is blank.
- **Visibility.** Every inherited choice on a product's schematic is marked as inherited until confirmed.
- **Fitness.** The share of products overriding each default is a reading; a default most products override is reviewed.

## 6. What it does not claim

A product line does not make products alike. It makes their shared decisions explicit, and their differences deliberate.

The registry of families and their products is a need of this area, held centrally, with defaults per family and a reference system per product to measure against. Whether each is met is shown on [/plant](https://zthr.ai/plant); where the registry is kept in a browser and not centrally, the page says so.
