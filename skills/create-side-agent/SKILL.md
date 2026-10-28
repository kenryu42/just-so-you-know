---
name: create-side-agent
description: Create a Just So You Know side agent, a Markdown file in ~/.claude/just-so-you-know/agents/ (every repo) or ~/.claude/just-so-you-know/projects/<repo>/agents/ (one repo only) that watches sessions for one kind of problem and passes notes to the main agent. Use when the user asks for a new side agent, a new focus for Just So You Know, or when the /jsyk panel hands over a "Create a Just So You Know side agent" request.
---

# Create a side agent

A side agent is one Markdown file. In `~/.claude/just-so-you-know/agents/` it checks sessions in every repo. In `~/.claude/just-so-you-know/projects/<repo key>/agents/` it checks only sessions in that repo, including its worktrees and subfolders, and replaces an every-repo side agent of the same name there. About every few steps of a longer task, the plugin asks it one question over the session transcript. It has no tools and answers once: `learn: none` almost always, or a single note that goes straight to the main agent.

The file holds only the side agent's **job**: what to look for, the bar, and examples. The plugin wraps it in the fixed parts, so the file must not repeat them:

- that it is a one-off side request with no tools,
- never repeating secrets,
- the reply format (`learn:` / `tag:` / `explain:`) and its rules,
- the notes already shared and the ones the main agent already knew.

## Steps

1. **Pin down the focus.** Ask the user, briefly and only what the request leaves open:
   - What should it catch? Get one or two concrete cases from their own work.
   - What looks similar but is not worth raising? This sets the bar.
   - What should it be called? Suggest a short kebab-case name (`evidence`, `api-breaks`), which becomes the file name.
   - Every repo, or this repo only? Suggest this repo when the job names this repo's code, tools or conventions.
   If the request is already specific, propose answers and let the user confirm instead of asking.
2. **Find the folder.** For every repo it is `~/.claude/just-so-you-know/agents/`. For this repo only, use the folder the request names if it names one. Otherwise work it out:
   - Run `git rev-parse --path-format=absolute --git-common-dir` in the project. If it prints a path ending in `/.git`, the repo is that path without `/.git`. If not (not a git repo), the repo is the project folder.
   - The key is that path with every character that is not a letter or digit replaced by `-`: `/Users/me/work/shop` becomes `-Users-me-work-shop`.
   - The folder is `~/.claude/just-so-you-know/projects/<key>/agents/`.
3. **Check the name.** List the folder. If the name is taken, say so and ask before replacing it. `understanding.md` replaces the built-in side agent, so use that name only when the user means to.
4. **Write the file** at `<folder>/<name>.md` in the shape below.
5. **Show the user the file** and tell them:
   - it checks from the next check on, about every 6 steps by default,
   - `/jsyk` lists it under User (every repo) or Project (this repo), turns it on or off there, and shows how its notes landed,
   - each side agent adds a request over the session at every check, so more side agents cost more.

## The file

```markdown
## Your job

<One paragraph: what to look for in this session, in plain words, naming the kinds of evidence in a transcript that show it (a command that was or wasn't run, a file that was or wasn't read, what the user said earlier).>

Raise it only when <the stake: what goes wrong if it goes unnoticed>. <What looks similar but is "none".>

Most of the time the answer is none.

## Examples

<A one-line setup of a session where it should speak up:>

learn: <one plain sentence under 240 characters: the fact and why it matters>
tag: <Heads up | You should know>
explain:
**<two to six plain words>**
* <three to five short bullets with real names in backticks, ending with one concrete check or choice>

<A one-line setup of a session that looks similar but should not:>

learn: none
```

## What makes a good side agent

- **One focus.** A side agent that looks for everything duplicates the built-in `understanding` one. Narrow beats broad.
- **Visible in a transcript.** It can only judge what the conversation shows. "The code has a race" is not checkable without tools. "The agent said the tests pass but never ran them" is.
- **A high bar, stated.** Say what the cost of missing it is, and name the near misses that are `none`. Without that, it raises noise the main agent learns to ignore, and the plugin backs it off.
- **At least one `none` example** that sits close to the real ones.
- **`Heads up`** is for a cost, risk or catch in what the main agent did. **`You should know`** is for background that matters but is less urgent.

## Example

`~/.claude/just-so-you-know/agents/evidence.md`:

```markdown
## Your job

Look for a claim or assumption the main agent made that nothing in the session backs up: tests said to pass that never ran, a file described but never read, a fix never checked through the real path, an API or flag that was guessed.

Raise it only when acting on the claim would lead to a wrong result, and the session shows no check of it. A claim the agent did check is "none".

Most of the time the answer is none.

## Examples

A session that ends with a summary of the work:

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
