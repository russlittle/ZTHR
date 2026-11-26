# Intent studio

## The end in mind

Anyone who holds an intent can turn it into a drawing a factory builds to, without losing what they meant, and without needing a developer to translate for them.

The job I am hiring this for: turn what someone means into a drawing and a package a factory can build to, without a developer translating
I would know it is doing a good job when: a person with no engineering background releases a package in one sitting, and the factory builds it without asking them anything new
It is for: people who hold an intent and are not developers

## What it should do

- Take rough words, a pasted spec, a file or a Claude artifact, and keep the person's words verbatim beside every interpretation
- Let the person speak their intent instead of typing it, where the browser allows
- Have two model families read the words independently, and turn every difference into a question, never a guess
- Ask only questions whose answer changes what is built, each answered in a few taps, with Other always available
- Show where the person is in the process at all times
- Show the drawing: every statement numbered, with its source, its state and its marks
- Save the work so the person can come back to it
- Release a revision as a package the factory can consume, and let the person download it
- A revision after the first must say why it was made

## Engineering notes

- Runs as a single page in the browser, because the person should need nothing installed
- Uses the same engine as the command line, so a release made here and one made there are identical
- Ideally reads with two different model families inside the page once a second family is available there

## Feel

It should feel calm and professional, easy to read, snappy, and work on a phone.

## Acceptance

- Given rough words with no end stated, when they are read, then the first redline offers the person's own sentence as the end
- Given an answer, when it is given, then that redline clears and the statement appears on the drawing with its balloon
- Given a revision after the first with no reason, when it is released, then it is refused
- Given the same intent, when it is released in the studio and with the command line, then the packages are identical
