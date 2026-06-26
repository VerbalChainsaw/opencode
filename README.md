<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo" width="320">
    </picture>
  </a>
</p>

<h1 align="center">OpenCode — VerbalChainsaw Edition</h1>

<p align="center">
  <strong>The open source AI coding agent, now with autonomous goal-directed execution.</strong>
</p>

<p align="center">
  <a href="https://github.com/VerbalChainsaw/opencode/releases"><img alt="Release" src="https://img.shields.io/github/v/release/VerbalChainsaw/opencode?style=flat-square&label=release" /></a>
  <a href="https://github.com/VerbalChainsaw/opencode/actions/workflows/publish.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/VerbalChainsaw/opencode/publish.yml?style=flat-square&branch=dev" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/VerbalChainsaw/opencode/blob/dev/LICENSE"><img alt="License" src="https://img.shields.io/github/license/VerbalChainsaw/opencode?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#whats-different">What's Different</a> &bull;
  <a href="#autogoal">AutoGoal</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#desktop-app">Desktop App</a> &bull;
  <a href="#documentation">Docs</a>
</p>

---

## What's Different

This is a **fork** of [OpenCode](https://github.com/anomalyco/opencode) by [@VerbalChainsaw](https://github.com/VerbalChainsaw). Everything upstream works here — same CLI, same providers, same plugin system. The fork adds one major feature:

### AutoGoal — Autonomous Goal-Directed Execution

> **You:** *"Keep working until all tests pass and don't stop on your own."*
>
> **OpenCode:** *Goal set: tests pass — I'll keep going and check after each step.*

Tell the agent what you want and it keeps working until the goal is met. No babysitting. Set it, walk away, come back to results.

**What it does:**
- **Conversational goal-setting** — just describe what you want in plain English
- **Deterministic verification** — attach a shell command (`npm test`, `make build`) and it checks exit code 0 after every turn
- **Chain execution** — sequence multiple actions (Plan → Build → Test → Review) with per-step constraints
- **Turn/time/token limits** — hard safety rails so it can't run forever
- **Live steering** — change the goal, add hints, pause/resume mid-run
- **Handoff** — serialize state to a file, pick it up in another session or on another machine
- **Full desktop UI** — Goal panel with real-time progress, metric pills, chain builder, run history

AutoGoal ships as a built-in plugin (`@opencode-ai/autogoal`) with 100+ tests. It works in both the desktop app and the terminal.

---

## AutoGoal

### Just Talk To It

The plugin gives the agent five tools. You manage goals in plain language:

| Say something like... | What happens |
|---|---|
| *"keep going until the tests pass"* | Sets a goal with auto-loop |
| *"don't stop until the build is green"* | Same — conversational syntax |
| *"what's my goal?"* | Shows current status + progress |
| *"pause the goal for a sec"* | Pauses the auto-loop |
| *"stop the goal, we're done"* | Clears the goal |

### Or Use the `/goal` Command

```
/goal set "all tests pass" --command "npm test"
/goal set "refactor auth module" stop after 15 turns
/goal steer "focus on the error handling first"
/goal pause / resume / clear
/goal history
```

### Chain Execution

Build multi-step workflows in the desktop Goal panel:

```
Step 1: Plan    → TURNS 3  / MIN 10  (map the work)
Step 2: Build   → TURNS 8  / MIN 30  (implement changes)
Step 3: Test    → TURNS 5  / MIN 15  (run and fix tests)
Step 4: Review  → TURNS 3  / MIN 10  (review the diff)
```

Each step runs with its own constraints. The chain advances automatically when a step completes.

### Standalone CLI

```bash
opencode-autogoal set "make all tests pass"
opencode-autogoal status
opencode-autogoal steer "focus on the flaky suite"
opencode-autogoal watch          # live terminal dashboard
opencode-autogoal tui            # full interactive control center
opencode-autogoal doctor         # health check
opencode-autogoal stats          # achievement history
```

Works from CI, cron jobs, shell scripts, or other agents — anything that can exec a subprocess.

---

## Installation

This fork currently ships **only the Windows desktop app**. The CLI install methods on opencode.ai (`npm`, `scoop`, `choco`, `brew`, etc.) install the upstream [anomalyco/opencode](https://github.com/anomalyco/opencode) — they will NOT give you the AutoGoal feature this fork adds. To get AutoGoal, use the desktop download below or build from source.

### Desktop App (Windows)

Download the signed installer from the [releases page](https://github.com/VerbalChainsaw/opencode/releases/latest):

| Platform | File | Status |
|---|---|---|
| Windows x64 | [`opencode-desktop-win-x64.exe`](https://github.com/VerbalChainsaw/opencode/releases/latest) | ✅ shipping |
| macOS | — | planned |
| Linux | — | planned |

**Windows SmartScreen note:** the current builds are not yet signed with an EV code-signing certificate, so SmartScreen will say *"Windows protected your PC — Unrecognized app"*. Click **More info → Run anyway**. The exe is built locally from this repo's `dev` branch and uploaded straight to releases — verify the `sha256` against the release page if you want to double-check.

### Build from source

```bash
git clone https://github.com/VerbalChainsaw/opencode.git
cd opencode
bun install
cd packages/desktop && bun run package:win   # Windows exe
```

The output lands at `packages/desktop/dist/opencode-desktop-win-x64.exe`.

---

## Desktop App

The desktop app is a full Electron application with:

- **Session management** — multiple concurrent sessions with model/provider switching
- **Goal panel** — visual chain builder, real-time metric pills, run history with achievement tracking
- **Theme system** — 30+ themes (Catppuccin, Dracula, Nord, Tokyo Night, etc.)
- **Multi-provider** — Claude, GPT, DeepSeek, Gemini, Ollama, and more
- **MCP support** — connect external tools via Model Context Protocol
- **Diff viewer** — inline code diffs with syntax highlighting

---

## Agents

OpenCode includes two built-in agents (switch with `Tab`):

- **build** — full-access agent for development work
- **plan** — read-only agent for analysis and code exploration (denies edits, asks before running commands)

A **general** subagent handles complex searches and multi-step tasks internally (invoke with `@general`).

Learn more about [agents](https://opencode.ai/docs/agents).

---

## Documentation

For configuration, providers, plugins, and more: [**opencode.ai/docs**](https://opencode.ai/docs)

---

## Contributing

Read the [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

---

## Credits

This fork is built on top of [OpenCode](https://github.com/anomalyco/opencode) by the OpenCode team. The AutoGoal system was inspired by [@mirsella](https://github.com/mirsella)'s [opencode-goal](https://github.com/mirsella/opencode-goal) — a clean, lightweight take on the same idea.

---

<p align="center">
  <strong>Built by <a href="https://github.com/VerbalChainsaw">VerbalChainsaw</a></strong> &bull;
  MIT License
</p>
