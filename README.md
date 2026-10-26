# Just So You Know

A Claude Code mod modeled on the built-in **You should know** plugin. A side agent watches longer tasks and looks for the one thing worth knowing that is easy to miss. The difference: it shares each finding with the main agent automatically instead of asking you to press 1 or 2, and it keeps a record of how the main agent took each note.

## What it does

- About every 6 steps of the main agent's work, a side agent with no tools reads the session and answers `learn: none` unless something clears a high bar. The cadence, tags, deduplication and "default to none" bar come from the built-in.
- When it finds something, the note goes straight into the running turn as a hidden message the main agent reads at its next step. You get a toast with the one-line summary.
- When the turn ends, a small model call judges the main agent's reaction: **helped**, **acknowledged**, **already aware** or **no reaction**, with a short quote as evidence.
- The built-in's brakes still apply. A note waiting for a reaction pauses new checks. "No reaction" and "already aware" verdicts back the checks off, the same way ignored cards do in the built-in.

## Commands

- `/jsyk` writes a page with every note across sessions to `~/.claude/just-so-you-know/report.html`, opens it in your browser, and prints a `file://` link to it. Each run rebuilds the page from all sessions, so the one file is always the complete, current report.

## Install

At the prompt of a terminal session:

```
/plugin install just-so-you-know --marketplace kenryu42/cc-marketplace
```

If you already added cc-marketplace (for cc-safety-net), `/plugin install just-so-you-know@cc-marketplace` is enough.

If you use the built-in You should know plugin, turn it off (`/plugin`) so the two do not both run.

## Development

```
claude plugin validate .
claude plugin test .
```
