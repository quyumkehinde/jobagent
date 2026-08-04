# JobAgent Autofill (Chrome extension)

Fills the ATS application form you're looking at with the answers JobAgent already drafted, attaches your (tailored) resume, and lets you mark the application as applied — all against your local JobAgent instance. You still review the form, solve any captcha, and click the site's own submit button.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select this `extension/` folder.
3. Make sure JobAgent is running: `npm run dev` (the extension talks to `http://localhost:3000`).

## Use

1. In JobAgent, draft an application (status `ready`).
2. Open the real application form in a tab — the **Open application page ↗** button on the review screen takes you there.
3. Click the extension icon. It lists your ready applications, preselecting the one matching the page you're on.
4. **Fill this form** — fields get filled and outlined green; anything it couldn't match is listed (amber outline) for you to do by hand.
5. Review everything, complete the captcha, click the site's submit button.
6. Back in the popup: **I submitted it — mark as applied** → the application moves to `submitted` in your pipeline.

## How matching works

Answers are matched to form controls by, in order: the ATS-native input name (Lever and classic Greenhouse forms use the same names JobAgent captured as `fieldKey`), exact visible label, then label containment. Values are set through the native setters + `input`/`change` events so React-based forms (Ashby, new Greenhouse, Workday-lite UIs) register them. The resume PDF is fetched from JobAgent (tailored version when one exists) and attached to file inputs via `DataTransfer`.

## Custom dropdowns

Combobox-style widgets (new Greenhouse, Ashby, react-select) are driven for real: the filler focuses the input, types the answer (falling back to a shorter prefix for strict filters), waits for the listbox to render, and commits the best-matching option with the mousedown sequence these widgets listen for. If no option ever matches, the widget is cleared and reported as unmatched rather than left with junk text that would block submission.

## Multi-step forms

Fill is per-page and idempotent — on multi-step applications (Workday-style), just click **Fill this form** again on each step; already-used fields aren't touched twice within a step and unmatched ones are re-listed.

## Settings

The popup's Settings section lets you change the JobAgent URL (default `http://localhost:3000`) if you run the app on another port.

## Limits

- Forms inside cross-origin iframes can't be reached.
- Fully bespoke widgets that expose neither a real `<input>` nor ARIA roles may still need manual selection.
- No captcha solving, ever — that's you.
