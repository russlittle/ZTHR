/** Core types for the Student Advocate. */

export type Depth = 'brief' | 'standard' | 'walk-me-through';
export type Channel = 'app' | 'text';
export type Language = 'en' | 'es';

export interface HelpDial {
  depth: Depth;
  channel: Channel;
  readingGrade: number; // target reading grade level
  language: Language;
  maxPerDay: number;
  quietStart: string;
  quietEnd: string;
  briefingTime: string; // "07:30"
}

export const DEFAULT_DIAL: HelpDial = {
  depth: 'standard',
  channel: 'app',
  readingGrade: 8,
  language: 'en',
  maxPerDay: 4,
  quietStart: '22:00',
  quietEnd: '08:00',
  briefingTime: '07:30',
};

export type NeedCategory =
  | 'food'
  | 'housing'
  | 'utilities'
  | 'money'
  | 'childcare'
  | 'transportation'
  | 'health'
  | 'mental-health'
  | 'books'
  | 'legal'
  | 'career'
  | 'phone-internet'
  | 'caregiving'
  | 'academic';

export interface Household {
  size: number;
  monthlyGrossIncome?: number; // dollars, whole household
  monthlyEarnedIncome?: number;
  childrenUnder6?: number;
  childrenUnder12?: number;
  singleParent?: boolean;
}

export interface Enrollment {
  college: string; // college id, e.g. "sinclair"
  creditHours?: number;
  degreeSeeking?: boolean;
  workStudy?: boolean;
  weeklyWorkHours?: number;
}

export interface Student {
  id: string;
  phone?: string;
  chosenName: string;
  pronouns?: string;
  zip: string;
  county?: string;
  age?: number;
  goal?: string;
  dial: HelpDial;
  household: Household;
  enrollment: Enrollment;
  receives?: { snap?: boolean; medicaid?: boolean; ssi?: boolean; tanf?: boolean; pell?: boolean };
  helpAreas: NeedCategory[];
  createdAt: string;
}

export interface Deadline {
  id: string;
  studentId: string;
  title: string;
  due: string; // ISO date or date-time, local
  course?: string;
  kind: 'assignment' | 'exam' | 'reading' | 'college' | 'aid' | 'benefit' | 'bill' | 'appointment' | 'other';
  source: { type: 'syllabus' | 'calendar-feed' | 'email' | 'text' | 'student' | 'playbook'; line?: string; ref?: string };
  confirmed: boolean;
  effortHours?: number;
  done?: boolean;
}

export interface ClassMeeting {
  course: string;
  days: ('Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun')[];
  start: string; // "09:00"
  end: string;
  building?: string;
  room?: string;
  campus?: string;
}

export interface Shift {
  date: string; // YYYY-MM-DD
  start: string;
  end: string;
  employer?: string;
}

export interface Bill {
  name: string;
  amount: number;
  dueDay: number; // day of month
  kind: 'rent' | 'utility' | 'phone' | 'car' | 'childcare' | 'other';
}

export interface Paycheck {
  amount: number;
  /** Next pay date and cadence. */
  next: string;
  everyDays: number;
}

/** Every message the team sends carries a next step the student can take in one tap (PRD P3). */
export interface NextStep {
  label: string;
  action: string; // an action id the app or text channel understands
}

export interface OutboundMessage {
  studentId: string;
  text: string;
  nextSteps: NextStep[];
  urgency: 'safety' | 'time-sensitive' | 'routine';
  why?: string; // CTL-1: why this was sent and what it saw
  author: string; // which agent wrote it
}
