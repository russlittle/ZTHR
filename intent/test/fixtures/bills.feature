Feature: Bill warnings

  Background:
    Given a student with bills

  Rule: Warn before a short month

    Scenario: Money short
      Given rent of $900 due on the 1st
      And $700 expected
      When the student opens Today
      Then a warning shows the $200 gap

    Scenario Outline: Gap shown
      Given rent of <rent> and <income> expected
      When the student opens Today
      Then the gap shown is <gap>

      Examples:
        | rent | income | gap  |
        | 900  | 700    | 200  |
        | 500  | 600    | none |
