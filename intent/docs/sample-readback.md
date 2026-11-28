# Read-back: Bill help

This is what will be built. Numbers in brackets stay with each statement, and the evidence will answer each one by number.

## Defaults for everything below

- **language**: English
- **reading**: plain words
- **density**: spacious, because you said "calm" (instead of comfortable)
- **palette**: soft, because you said "calm" (instead of standard, contrast-checked)
- **motion**: reduced, because you said "calm" (instead of full, reduced when the system asks)
- **vision**: standard, with low vision and high contrast available
- **accessibility**: WCAG 2.2 AA
- **layout**: single column, because you said "on a phone" (instead of adapts from a 320-pixel phone to a desktop)
- **feedback**: immediate, because you said "snappy" (instead of within 1 second)
- **itemsPerScreen**: few, because you said "calm"
- **targets**: large, because you said "on a phone"

## The problem

- **[1]** students get their power shut off after missing bills. _my reading, change it if wrong; both readings (gemini, claude)_

## When it works

- **[2]** no shut-off from a missed due date. _my reading, change it if wrong; both readings (gemini, claude)_

## Who it is for, and who else it reaches

- **[3]** student (who it is for). _my reading, change it if wrong; both readings (gemini, claude)_
- **[4]** staff who see this information (on the other side). _a default; follows from "Staff"_

## How everyone will know it worked

- **[5]** when a bill is paid, then reminders stop. _yours; test/fixtures/rough.md:7_
- **[6]** no more than five things to choose on any screen, held to five. _my reading, change it if wrong; from "calm"_
- **[7]** visible response to every tap, held to within 100 milliseconds. _my reading, change it if wrong; from "snappy"_
- **[8]** each screen ready, held to within 1 second on a mid-range phone. _my reading, change it if wrong; from "snappy"_
- **[9]** works on a screen 320 pixels wide, held to no sideways scrolling. _my reading, change it if wrong; from "on a phone"_
- **[10]** usable on a slow connection, held to first screen within 3 seconds. _my reading, change it if wrong; from "on a phone"_

## What it will also need

- **[11]** a way to reach each person, and their consent to be contacted. _a default; follows from "Remind"_
- **[12]** quiet hours and each person's time zone. _a default; follows from "Remind"_
- **[13]** where the amounts and due dates come from, and how current they are. _a default; follows from "bills"_
- **[14]** which staff, and which people each may see. _a default; follows from "Staff"_

## What else this affects

- **[15]** people get messages they did not ask for, so the contact limit and quiet hours apply **(significant)**. _a default; follows from "Remind"_
- **[16]** financial details are sensitive: stored and shown only to the person and whoever they allow **(critical)**. _a default; follows from "bills"_
- **[17]** a second kind of user sees information about the first; every view is recorded **(critical)**. _a default; follows from "Staff"_
- **[18]** every screen must work one-handed on a small screen and a slow connection. _a default; follows from "phone"_

## What it must do, and must never do

- **[19]** Remind students before bills are due. _yours; test/fixtures/rough.md:5_
- **[20]** It should be snappy on a phone. _yours; test/fixtures/rough.md:6_
- **[21]** Staff should see who is struggling. _yours; test/fixtures/rough.md:8_
- **[22]** never message during quiet hours. _my reading, change it if wrong; both readings (gemini, claude)_
- **[23]** "calm", read as soft colours, plenty of space, few things on each screen, and no sudden movement. _my reading, change it if wrong; from "calm"_
- **[24]** "snappy", read as every tap answers at once and every screen is ready within a second. _my reading, change it if wrong; from "snappy"_
- **[25]** "on a phone", read as works one-handed on a small phone screen, on a slow connection. _my reading, change it if wrong; from "on a phone"_

## Left out on purpose

- **[26]** paying bills for students. _my reading, change it if wrong; both readings (gemini, claude)_

## Needs a control before it ships

- **[15]** significant: people get messages they did not ask for, so the contact limit and quiet hours apply
- **[16]** critical: financial details are sensitive: stored and shown only to the person and whoever they allow
- **[17]** critical: a second kind of user sees information about the first; every view is recorded

## Before I can build, I need to know

1. "Staff should see who is struggling": which staff? _It decides a point you marked as undecided._
2. What are you ultimately trying to achieve: "stay housed and in school" or "avoid late fees"? _It decides choosing between ways of meeting it._
3. Should this be one of the outcomes: "a warning when money will be short"? _It decides what counts as done._
4. How strict should "shut-offs avoided" be: "none in a term" or "fewer than last term"? _It decides how anyone will know it worked._
5. Should this be one of the people involved: "advisor (on the other side)"? _It decides who it is built for, and who else it reaches._
