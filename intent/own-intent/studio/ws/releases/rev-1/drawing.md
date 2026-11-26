# Read-back: Intent studio

Step 2 of 6: Read. Two independent readings are compared.

~~Rough intent~~ → **Read** → Questions → Read-back → Signed → Released

This is what will be built. Numbers in brackets stay with each statement, and the evidence will answer each one by number.

## The end in mind

Anyone who holds an intent can turn it into a drawing a factory builds to, without losing what they meant, and without needing a developer to translate for them.

## Defaults for everything below

- **reading**: audience level, because you said "easy to read" (instead of plain words)
- **density**: spacious, because you said "calm" (instead of comfortable)
- **palette**: undecided: soft ("calm") or restrained ("professional")
- **motion**: reduced, because you said "calm" (instead of full, reduced when the system asks)
- **vision**: low vision available, because you said "easy to read" (instead of standard, with low vision and high contrast available)
- **layout**: works one-handed from a 320-pixel phone up, because you said "on a phone" (instead of adapts from a 320-pixel phone to a desktop)
- **feedback**: immediate, because you said "snappy" (instead of within 1 second)
- **itemsPerScreen**: few, because you said "calm"
- **style**: consistent, because you said "professional"
- **targets**: large, because you said "on a phone"
- Unchanged: language English; accessibility WCAG 2.2 AA

## How it should feel

- **[10]** "calm", read as soft colours, plenty of space, few things on each screen, and no sudden movement. _my reading, change it if wrong; from "calm"_
- **[11]** "snappy", read as every tap answers at once and every screen is ready within a second. _my reading, change it if wrong; from "snappy"_
- **[12]** "professional", read as restrained colour, consistent type and spacing, and precise wording. _my reading, change it if wrong; from "professional"_
- **[13]** "on a phone", read as works one-handed on a small phone screen, on a slow connection. _my reading, change it if wrong; from "on a phone"_
- **[14]** "easy to read", read as plain words at the audience's reading level, large text available, and strong contrast. _my reading, change it if wrong; from "easy to read"_

## What it must do, and must never do

- **[1]** Take rough words, a pasted spec, a file or a Claude artifact, and keep the person's words verbatim beside every interpretation. _yours; intent.md:9_
- **[2]** Let the person speak their intent instead of typing it, where the browser allows. _yours; intent.md:10_
- **[3]** Have two model families read the words independently, and turn every difference into a question, never a guess. _yours; intent.md:11_
- **[4]** Ask only questions whose answer changes what is built, each answered in a few taps, with Other always available. _yours; intent.md:12_
- **[5]** Show where the person is in the process at all times. _yours; intent.md:13_
- **[6]** Show the drawing: every statement numbered, with its source, its state and its marks. _yours; intent.md:14_
- **[7]** Save the work so the person can come back to it. _yours; intent.md:15_
- **[8]** Release a revision as a package the factory can consume, and let the person download it. _yours; intent.md:16_
- **[9]** A revision after the first must say why it was made. _yours; intent.md:17_

## How everyone will know it worked

- **[15]** given rough words with no end stated, when they are read, then the first redline offers the person's own sentence as the end. _yours; intent.md:31_
- **[16]** given an answer, when it is given, then that redline clears and the statement appears on the drawing with its balloon. _yours; intent.md:32_
- **[17]** given a revision after the first with no reason, when it is released, then it is refused. _yours; intent.md:33_
- **[18]** given the same intent, when it is released in the studio and with the command line, then the packages are identical. _yours; intent.md:34_
- **[19]** no more than five things to choose on any screen, held to at most five. _my reading, change it if wrong; from "calm"_
- **[20]** visible response to every tap, held to within 100 milliseconds. _my reading, change it if wrong; from "snappy"_
- **[21]** each screen ready, held to within 1 second on a mid-range phone. _my reading, change it if wrong; from "snappy"_
- **[22]** works on a screen 320 pixels wide, held to no sideways scrolling. _my reading, change it if wrong; from "on a phone"_
- **[23]** usable on a slow connection, held to first screen within 3 seconds. _my reading, change it if wrong; from "on a phone"_
- **[24]** text at or below the audience's reading level, held to every message. _my reading, change it if wrong; from "easy to read"_

## What else this affects

- **[25]** every screen must work one-handed on a small screen and a slow connection. _a default; follows from "phone"_

## Engineering notes: how, for now

These say how it is to be made, not what it must do. Changing one never changes the intent above.

- Runs as a single page in the browser, because the person should need nothing installed _the practical choice now_
- Uses the same engine as the command line, so a release made here and one made there are identical _the practical choice now_
- Ideally reads with two different model families inside the page once a second family is available there _the ideal_

## Before I can build, I need to know

1. What is going wrong today that this should fix, and for whom? _It decides building the right thing at all._
   - Your answer: ______
2. Is this what will be true when it works? _It decides what counts as done._
   > Anyone who holds an intent can turn it into a drawing a factory builds to, without losing what they meant, and without needing a developer to translate for them.
   - ( ) Yes
   - ( ) Not quite: ______
3. "calm" and "professional" want different things for the palette. Which should win? _It decides that the palette is what you meant._
   - ( ) soft (for "calm")
   - ( ) restrained (for "professional")
   - ( ) Other: ______

## Not read yet

- the free-text parts need readings from two model families; only claude read them
