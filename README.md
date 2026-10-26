# Just So You Know

A Claude Code mod modeled on the built-in **You should know** plugin. Side agents watch longer tasks and look for the one thing worth knowing that is easy to miss. The differences: they share each finding with the main agent automatically instead of asking you to press 1 or 2, you can add side agents with your own focus, and the plugin keeps a record of how the main agent took each note.

## What it does

- Every 6 steps of the main agent's work (you can change this in `/jsyk`), side agents with no tools read the session and answer `learn: none` unless something clears a high bar. The cadence, tags, deduplication and "default to none" bar come from the built-in.
- When one finds something, the note goes straight into the running turn as a hidden message the main agent reads at its next step. Notes from several side agents at the same step arrive together in one message. You get a toast with the one-line summary.
- When the turn ends, a small model call judges the main agent's reaction to each note: **helped**, **acknowledged**, **already aware** or **no reaction**, with a short quote as evidence.
- The built-in's brakes still apply, to each side agent on its own. A side agent with a note waiting for a reaction makes no new checks, and "no reaction" and "already aware" verdicts back that side agent off, the same way ignored cards do in the built-in. The other side agents keep checking.

## Side agents

One side agent ships with the plugin: **understanding**, which looks for something the person needs to understand and very likely doesn't. You can add your own, each with its own focus, as Markdown files in `~/.claude/just-so-you-know/agents/`. The easiest way is to type what it should watch for under **New side agent** in `/jsyk`, or ask Claude for a side agent: the plugin's `create-side-agent` skill asks what it needs and writes the file. You can also write one by hand:

```
~/.claude/just-so-you-know/agents/
  evidence.md
  intent.md
```

- The file name is the side agent's name, and the file is its job: what to look for, the bar, and a few examples. The plugin wraps it in the fixed parts: no tools, never repeat secrets, the `learn:` / `tag:` / `explain:` reply format, and the notes already shared.
- The folder is read at every check, so a new, edited or removed file counts from the next check on.
- `understanding.md` replaces the built-in side agent.
- Turn any side agent on or off in `/jsyk`, the built-in included.
- Every side agent is a separate request over the session at each check, so each one adds to the session's cost. The transcript mostly comes from the prompt cache.
- Only this folder in your home directory is read, never one inside a project, so a repository cannot slip its own instructions to your main agent.

Two examples to copy:

`evidence.md`

```markdown
## Your job

Look for a claim or assumption the main agent made that nothing in the session backs up: tests said to pass that never ran, a file described but never read, a fix never checked through the real path, an API or flag that was guessed.

Raise it only when acting on the claim would lead to a wrong result, and the session shows no check of it. A claim the agent did check is "none".

## Examples

learn: The summary says all tests pass, but the session only ran the parser tests, not the full suite.
tag: Heads up
explain:
**Only some tests ran**
* The last test command was `bun test tests/parse.test.ts`.
* The change also touched `report.ts`, which has its own tests.
* Run the full suite before calling it done.

A claim the agent ran a command to confirm:

learn: none
```

`intent.md`

```markdown
## Your job

Look for work drifting from what the user asked for: doing more or less than asked, a constraint from earlier in the conversation that was dropped, or a rule from the user's instructions (CLAUDE.md) being broken.

Raise it only when the user would want it undone or redone. Small, reasonable choices the user left open are "none".

## Examples

learn: The user asked to fix the date bug only, but the agent also renamed three public functions, which breaks other callers.
tag: Heads up
explain:
**Changes beyond the request**
* The request was a fix to `parseDate` in `dates.ts`.
* The diff also renames `formatDay`, `formatWeek` and `formatMonth`.
* Ask the user before keeping the renames.

learn: none
```

The report names the side agent behind each note and counts each one's verdicts, so you can see which side agents earn their place.

## The `/jsyk` panel

`/jsyk` opens a panel with everything in one place:

- **Side agents:** each one with whether it is on, where it comes from, and how many of its notes helped. Press one to turn it on or off.
- **Check every (steps):** how often the side agents check, 6 by default, from 1 to 100.
- **New side agent:** type what it should watch for and press Enter. The panel closes and the main agent sets the side agent up with you.
- **Open report** (`r`): writes a page with every note across sessions to `~/.claude/just-so-you-know/report.html` and opens it in your browser. Each time, the page is rebuilt from all sessions.
- **Copy agents folder path** (`c`): to open the side agents' files in your own editor.

The panel saves its settings to `~/.claude/just-so-you-know/config.json`. Both the settings and the agents folder are read at every check, so changes count from the next check on. The phone app draws no text fields yet, so there the panel only lists and toggles side agents.

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
