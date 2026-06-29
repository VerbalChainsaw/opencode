# Welcome to Team n00b

## How We Use Claude

Based on usage over the last 30 days:

Work Type Breakdown:
  Debug Fix            ██████████░░░░░░░░░░  50%
  Improve Quality      ██████████░░░░░░░░░░  50%

Top Skills & Commands:
  /goal                ████████████████████  2x/month
  /effort              ██████████░░░░░░░░░░  1x/month
  /model               ██████████░░░░░░░░░░  1x/month

Top MCP Servers:
  computer-use         ████████████████████  77 calls
  ccd_session          ███░░░░░░░░░░░░░░░░░  11 calls
  Claude_in_Chrome     █░░░░░░░░░░░░░░░░░░░  1 call

## Your Setup Checklist

### Codebases
- [ ] opencode — https://github.com/verbalchainsaw/opencode
  - Monorepo with `packages/autogoal` (the fork actively in use) and the upstream `packages/opencode`. Treat autogoal as the working tree.

### MCP Servers to Activate
- [ ] computer-use — desktop UI control for verifying visual fixes. Ask the guide creator for the server config; it's the most-used integration by far.
- [ ] ccd_session — paired with computer-use for screenshot/observation sessions. Comes online with computer-use.
- [ ] Claude_in_Chrome — browser automation for live web checks. Low usage but useful for one-off verifications.

### Skills to Know About
- [/goal](/goal) — sets the active goal/task context. Use it to scope what Claude should be working on at any moment.
- [/effort](/effort) — tunes the effort level (e.g. `ultracode` for xhigh + workflow orchestration). Reach for it before large audits or migrations.
- [/model](/model) — switches the active Claude model. Use when a task clearly fits a different tier than the current default.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->