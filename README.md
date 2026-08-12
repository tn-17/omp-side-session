# omp-side-session

An [Oh My Pi](https://omp.sh) plugin package containing one OMP extension: `/side` opens a separately persisted OMP conversation in a paired [Herdr](https://github.com/tn-17/herdr) pane without adding its ordinary turns to Main.

In OMP terminology, the TypeScript module is the **extension** that implements the command. The repository and `package.json` form the **plugin** used to install and distribute that extension.

## Requirements

- OMP running inside a Herdr-managed pane (`HERDR_ENV=1`).
- The `herdr` executable available to OMP.
- A persisted Main session. Complete one Main turn before opening the first Side.

The extension is currently tested with OMP 17.2.14 and Herdr 0.8.0.

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

This forks Main's latest settled context, opens another OMP process in a paired Herdr pane, and sends the question there. `/side` without a question opens an empty Side.

A Side is a private, multi-turn conversation. Its ordinary user and assistant messages are not added to Main. Up to four Sides can be open at once.

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

### Close a Side

From Main:

```text
/side close 2
```

After confirmation, the extension closes the tracked pane and deletes that Side's session and artifact directory. Cleanup refuses session paths outside OMP's managed project-session directories.

## Command completion

Typing `/side ` shows:

```text
close      Close and delete a paired Side from Main   [number]
handoff    Prepare a handoff from this Side            [instructions]
recover    Recover a pending handoff in Main           [number]
```

Free-form text remains a Side question; it does not need a subcommand.

## Design boundaries

OMP owns the persisted fork, Side identity, handoff records, recovery, and safe session cleanup. Herdr owns pane layout, focus, process presentation, and pane closure.

The extension intentionally has no non-Herdr fallback and no generic multiplexer abstraction.

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
