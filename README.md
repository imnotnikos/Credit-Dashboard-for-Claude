# home-dashboard

A Claude Code mod that opens a **Dashboard** pane beside your chat with three cards:

- **Credit usage**: two rings. The outer ring is your session (5-hour) limit and the inner ring is your weekly (7-day) limit, with both percentages in the centre and when each one resets.
- **Main topics**: your chat titles ranked by how many prompts you sent in each, with a Day / Week toggle.
- **Most used**: your top plugins, connectors and skills over the last 7 days.

It runs entirely on your machine and uses no credits. The rings come from usage figures the session already has, and the other cards are counted from your local chat history (`~/.claude/projects`).

## Install

Type this at the prompt of a terminal Claude Code session:

```
/plugin install home-dashboard --marketplace OWNER/REPO
```

Answer `y` to add the marketplace, then pick the **user** scope. Once installed at user scope, it also loads in the Claude desktop app's Code tab.

## Use

The pane opens when a session starts. Type `/home-dashboard` to reopen it.

## Notes

- The rings show "—" until the first reply of a session, because that's when usage figures arrive.
- claude.ai connectors are only stored by an ID, so each one is named after a word its tools share (for example "Firecrawl").
- History files over 4 MB are skipped.
