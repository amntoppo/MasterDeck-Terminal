# MasterDeck docs

| Doc | For | What's in it |
|---|---|---|
| [../CLAUDE.md](../CLAUDE.md) | agents (start here) | Layout, commands, operating rules, protocol copy rule, where each subsystem lives, current state |
| [ARCHITECTURE.md](ARCHITECTURE.md) | agents | Main process (startup, Sources/state build, inbox, hooks, monitors, workflows, queue, sender/PTYs, master-agent), preload/IPC, shared modules, renderer, AppState producers, files on disk |
| [REMOTE.md](REMOTE.md) | agents | Account sign-in, CloudSync (snapshots/patches, commands, items, clients), browser bridge (approval, E2E, state patches, PTY streaming), web app, instant typing, remote indicator, message tables |
| [OPERATIONS.md](OPERATIONS.md) | agents | Dev setup, build/package/install, release, web app, website and backend deploy, isolated E2E recipe, throwaway Claude session, measuring upload, troubleshooting |
| [TODO.md](TODO.md) | agents | Open work by priority with code pointers and approaches; recently done with commits |
| [GUIDE.md](GUIDE.md) | users | Every feature as a user sees it |
| [../README.md](../README.md) | users | Install, first run, requirements, develop |
| [../TODO.md](../TODO.md) | agents | Older design note: supporting Codex and Copilot CLIs |

Backend-side specs, plans and E2E reports for accounts, remote and the web app:
`~/Documents/masterdeck-backend/docs/superpowers/{specs,plans,reports}`.
