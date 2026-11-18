# Leave Desk docs

Project documentation that is not in the code. Start with **SESSION.md** when you open a new Claude Code session.

| File | What it is for |
|---|---|
| [SESSION.md](SESSION.md) | The hand-over file. What is built, what is uncommitted, how to run, what to do next. Update it at the end of every session. |
| [slack-integration.md](slack-integration.md) | The Leave app in Slack: setup steps, commands, card design, the 3-second timeout, how a Slack user is matched to an employee in production. |
| [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md) | **Performance & reliability roadmap:** fast modal/submission, atomic concurrency, edge-case handling, test cases, 4-week implementation. |
| [../README.md](../README.md) | Architecture and folder layout (repo root). |
| [../CLAUDE.md](../CLAUDE.md) | Rules for Claude Code and the deployment checklist (git-ignored, lives only on this machine). |

## How to continue in a new session

1. Open Claude Code in `leave-desk-src` and say: *"Read docs/SESSION.md and continue."*
2. Run `npm test`. Every suite must print its `PASSED` line.
3. Check `git status` and `git log --oneline -5` against the "Where the code is" section of SESSION.md.
4. Work on a `claude/<topic>` branch. Ask before `git push` and before `npx clasp push --force`.
