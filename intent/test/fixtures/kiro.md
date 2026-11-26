# Requirements Document

## Introduction

Bill warnings for students.

## Requirements

### Requirement 1

**User Story:** As a student, I want to know a month will be short, so that I am not shut off.

#### Acceptance Criteria

1. WHEN expected money is below bills due THEN the system SHALL show the gap before the first of the month
2. IF a bill has no due date THEN the system SHALL list it without a warning
3. WHILE quiet hours are on, WHEN a reminder is due THEN the system SHALL hold it until quiet hours end
4. THE system SHALL keep every warning in the student's history

### Requirement 2

**User Story:** As a student, I want reminders to stop when I pay.

#### Acceptance Criteria

1. WHEN a bill is marked paid THEN the system SHALL send no further reminders for it
