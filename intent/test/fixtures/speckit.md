# Feature Specification: Bill warnings

## User Scenarios & Testing

### User Story 1 - See a short month coming (Priority: P1)

A student sees, before the first of the month, that their money will not cover their bills.

**Acceptance Scenarios**:

1. **Given** rent of $900 due on the 1st and $700 expected, **When** the student opens Today, **Then** a warning shows the $200 gap and ways to cover it.
2. **Given** no bills due this month, **When** the student opens Today, **Then** no warning shows.

### User Story 2 - Reminders that stop (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a bill marked paid, **When** its reminder time comes, **Then** no reminder is sent.

### Edge Cases

- A bill with no due date is listed, never warned about.

## Requirements

- **FR-001**: The system MUST warn before the first of the month when expected money is below bills due.
- **FR-002**: Reminders MUST stop once a bill is marked paid. [NEEDS CLARIFICATION: does "paid" need a receipt?]

```gherkin
Scenario: Quiet hours
  Given quiet hours from 9pm to 8am
  When a reminder falls at 10pm
  Then it is sent at 8am
```
