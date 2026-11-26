/**
 * The canonical intent model: what every supported spec form is parsed into. Everything later in the
 * pipeline reads this and nothing else, so a new input form needs only a new parser.
 */

export type Form = 'speckit' | 'kiro' | 'openspec' | 'gherkin' | 'markdown';

/** Where something was written, so every question and check can point back to the sentence it came from. */
export interface Origin {
  readonly path: string;
  readonly line: number;
}

export interface Requirement {
  /** The source's own number when it has one (FR-001, Requirement 2), otherwise derived from its position. */
  readonly id: string;
  readonly text: string;
  readonly origin: Origin;
}

export interface Example {
  readonly id: string;
  /** The requirement or story this example illustrates, when the source says. */
  readonly of: string | null;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly origin: Origin;
}

/** A point the author marked as undecided. It becomes a question without any model being asked. */
export interface Clarification {
  readonly id: string;
  readonly text: string;
  readonly origin: Origin;
}

export interface Source {
  readonly path: string;
  readonly form: Form;
  readonly sha256: string;
  /** Set when the file was a page converted to markdown before parsing; line numbers refer to the conversion. */
  readonly from?: 'html';
}

/** How it is to be made for now, kept apart from what it must do, like a drawing's heat-treat and finish notes. */
export interface Note {
  readonly text: string;
  /** Why this is the how, when the note says. */
  readonly reason: string | null;
  /** The practical choice now, or the ideal to move toward. */
  readonly stance: 'practical' | 'ideal';
  readonly origin: Origin;
}

/** A variant authoritative for its own scope, as a dash number on a tabulated drawing. */
export interface Variant {
  readonly id: string;
  readonly text: string;
  /** Where it applies; a variant without one is refused. */
  readonly effectivity: string | null;
  readonly origin: Origin;
}

/** A line the person labelled with its own slot ("The job I am hiring this for: …"): theirs, verbatim. */
export interface Labelled {
  readonly slot: 'problem' | 'why' | 'outcome' | 'people' | 'measures';
  readonly text: string;
  readonly origin: Origin;
}

export interface IntentModel {
  /** The end the whole product serves, when the source states it. */
  readonly end: string | null;
  readonly notes: readonly Note[];
  readonly variants: readonly Variant[];
  /** Lines the person labelled with their slot. */
  readonly labelled: readonly Labelled[];
  readonly title: string;
  readonly sources: readonly Source[];
  readonly requirements: readonly Requirement[];
  readonly examples: readonly Example[];
  readonly clarifications: readonly Clarification[];
  /** Plain statements a reader may use but that are not requirements: assumptions, entities, context. */
  readonly context: readonly string[];
}

/** What one parser returns for one file. */
export interface Parsed {
  readonly title: string;
  readonly requirements: Requirement[];
  readonly examples: Example[];
  readonly clarifications: Clarification[];
  readonly context: string[];
}
