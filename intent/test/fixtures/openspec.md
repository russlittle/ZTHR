# Bill warnings Specification

## Purpose

Warn students before a short month.

## Requirements

### Requirement: Short-month warning

The system SHALL warn before the first of the month when expected money is below bills due.

#### Scenario: Money short

- **GIVEN** rent of $900 due on the 1st
- **AND** $700 expected
- **WHEN** the student opens Today
- **THEN** a warning shows the $200 gap
- **AND** ways to cover it are offered

#### Scenario: Nothing due

- **WHEN** no bills are due this month
- **THEN** no warning shows

### Requirement: Reminders stop

The system MUST stop reminders once a bill is marked paid.

#### Scenario: Paid bill

- **WHEN** a bill is marked paid
- **THEN** no reminder is sent
