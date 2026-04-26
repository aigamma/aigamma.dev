# Agent Instructions

## Git Workflow
- After making and verifying any file edits, you must always automatically commit those changes using terminal commands.
- Always use past tense for commit messages, be reasonably verbose, and end the message with a period.
- Always include the following co-author trailer in the commit message:
  Co-authored-by: gemini <gemini@google.com>
- After committing, always automatically run `git push` to push the changes to the remote repository.

## Architectural Reference Documents
Topic-specific architectural references live in `docs/`. Read the relevant doc end to end before changing the data layer or proposing a new threshold/cutoff for the surfaces it covers. Do not propose changes that contradict a documented decision without first acknowledging the rationale recorded in the doc.

- **`docs/options-volume-roster.md`** — Single authoritative reference for the options-volume roster (`src/data/options-volume-roster.json`). Covers the data source (manual Barchart CSV at `C:\sheets\` today, planned automation via Massive grouped options aggregates), the power-law distribution shape, threshold-based bucket boundaries for chart filters, the planned three-tier architecture (anchor / dynamic tail / mid-band dampening with earnings quarantine + hysteresis), the current anchor list and watchlist, the planned schema, and an explicit "do not do this" list. Required reading for any work on /heatmap, /scan, /earnings filter pills, or any new surface that wants to scope itself to "names a vol trader cares about."
- **`docs/earnings-data-roadmap.md`** — Strategic data roadmap for the /earnings lab. Covers market cap as a third filter dimension, IV rank backfill, options-volume ranking automation, and Databento evaluation — each with schema sketch, data source, latency/cost profile, and explicit blockers.
