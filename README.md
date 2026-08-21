# omp-side-session

An [Oh My Pi](https://omp.sh) plugin package containing one OMP extension: `/side` opens a separately persisted OMP conversation in a paired [Herdr](https://github.com/tn-17/herdr) pane without adding its ordinary turns to Main.

In OMP terminology, the TypeScript module is the **extension** that implements the command. The repository and `package.json` form the **plugin** used to install and distribute that extension.

## Requirements

- OMP running inside a Herdr-managed pane (`HERDR_ENV=1`).
- The `herdr` executable available to OMP.
- A persisted Main session. Complete one Main turn before opening the first Side.

The extension is currently tested with OMP 17.4.0 and Herdr 0.8.2.

## Install from a local clone

```bash
git clone https://github.com/tn-17/omp-side-session.git
cd omp-side-session
bun install
bun run check
omp plugin link --scope user .
```

Start a new OMP session after installing or updating the plugin. OMP extensions load at session startup.

## Usage

### Open a Side

```text
/side Why did this implementation choose polling?
```

This forks Main's latest settled context and artifacts, opens another OMP process in a paired Herdr pane, and sends the question there. `/side` without a question opens an empty Side.

A Side is a private, multi-turn conversation. Its ordinary user and assistant messages are not added to Main. Up to four Sides can be tracked at once, including detached Sides.

Conversation state is isolated; the working directory, files, Git worktree, running services, and external side effects are not. Use Sides for consultation and research by default. Coordinate explicitly before Main and Side edit shared files concurrently.

### Send a handoff to Main

From the Side:

```text
/side handoff
/side handoff Focus on the API decision and unresolved risks.
```

The Side prepares a concise handoff. Main imports it automatically when idle as context for Main's next turn. Importing does not start a Main turn or make Main act automatically.

If automatic import needs recovery, run this from Main:

```text
/side recover 2
```

Recovery only imports a handoff that Side 2 already prepared; it does not ask Side 2 to create one.

### List or reopen Sides

From Main:

```text
/side list
/side reopen 2
```

Closing a Side's Herdr pane manually detaches it but retains its persisted session. `/side list` shows open and detached Sides. `/side reopen` resumes a detached Side without replaying its original question.

### Close a Side

From Main:

```text
/side close 2
```

After confirmation, the extension closes an open pane when needed and permanently deletes that Side's session and artifact directory. The command also deletes detached Sides. Cleanup canonicalizes paths and refuses sessions outside OMP's managed project-session directories.

## Command completion

Typing `/side ` shows:

```text
--         Open a question beginning with a reserved word   [question]
close      Close and delete a paired Side from Main         [number]
reopen     Reopen a detached Side from Main                 [number]
list       List open and detached Sides from Main
handoff    Prepare a handoff from this Side                  [instructions]
recover    Recover a pending handoff in Main                 [number]
```

Free-form text remains a Side question; it does not need a subcommand. Prefix the question with `--` when it begins with a reserved word:

```text
/side -- close handling is racy
```

## Design boundaries

OMP owns the persisted fork, copied artifacts, Side identity, handoff records, recovery, and canonicalized session cleanup. Herdr owns pane layout, focus, process presentation, and pane closure.

Main and Side deliberately share the same workspace. The extension intentionally has no non-Herdr fallback and no generic multiplexer abstraction.

## Development

```bash
bun install
bun run check
```

`bun run check` runs Biome, strict TypeScript checking, and the Bun test suite.

## Attribution

The Side-session design and portions of the orchestration were adapted from [`@pi-kaush/pi-btw-with-imports`](https://github.com/kaushikgopal/pi-kaush/tree/main/extensions/pi-btw-with-imports), licensed under MIT. See [`NOTICE`](./NOTICE).

## License

MIT. See [`LICENSE`](./LICENSE).
