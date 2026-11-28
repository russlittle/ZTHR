End in mind: Anyone who holds an intent can turn it into a drawing a factory builds to, without losing what they meant, and without needing a developer to translate for them.

Datum (what the result must let people do, by balloon):
[1] constraints: Take rough words, a pasted spec, a file or a Claude artifact, and keep the person's words verbatim beside every interpretation
[2] constraints: Let the person speak their intent instead of typing it, where the browser allows
[3] constraints: Have two model families read the words independently, and turn every difference into a question, never a guess
[4] constraints: Ask only questions whose answer changes what is built, each answered in a few taps, with Other always available
[5] constraints: Show where the person is in the process at all times
[6] constraints: Show the drawing: every statement numbered, with its source, its state and its marks
[7] constraints: Save the work so the person can come back to it
[8] constraints: Release a revision as a package the factory can consume, and let the person download it
[9] constraints: A revision after the first must say why it was made
[10] constraints: "calm", read as soft colours, plenty of space, few things on each screen, and no sudden movement
[11] constraints: "snappy", read as every tap answers at once and every screen is ready within a second
[12] constraints: "professional", read as restrained colour, consistent type and spacing, and precise wording
[13] constraints: "on a phone", read as works one-handed on a small phone screen, on a slow connection
[14] constraints: "easy to read", read as plain words at the audience's reading level, large text available, and strong contrast
[15] measures: given rough words with no end stated, when they are read, then the first redline offers the person's own sentence as the end (tolerance: exactly as stated)
[16] measures: given an answer, when it is given, then that redline clears and the statement appears on the drawing with its balloon (tolerance: exactly as stated)
[17] measures: given a revision after the first with no reason, when it is released, then it is refused (tolerance: exactly as stated)
[18] measures: given the same intent, when it is released in the studio and with the command line, then the packages are identical (tolerance: exactly as stated)
[19] measures: no more than five things to choose on any screen (tolerance: at most five)
[20] measures: visible response to every tap (tolerance: within 100 milliseconds)
[21] measures: each screen ready (tolerance: within 1 second on a mid-range phone)
[22] measures: works on a screen 320 pixels wide (tolerance: no sideways scrolling)
[23] measures: usable on a slow connection (tolerance: first screen within 3 seconds)
[24] measures: text at or below the audience's reading level (tolerance: every message)

Engineering notes (how, for now; never the intent):
- Runs as a single page in the browser, because the person should need nothing installed
- Uses the same engine as the command line, so a release made here and one made there are identical
- Ideally reads with two different model families inside the page once a second family is available there
