# Credit Dashboard for Claude

<img src="docs/screenshot.png" alt="The Dashboard pane: usage bars, main topics and most used tools" width="360">

A Claude Code mod that opens a **Dashboard** pane beside your chat, in Claude's colours, with three cards:

- **Credit usage**: three rings, one inside another.
  - The outer ring is your **session** (5-hour) limit.
  - The middle ring is your **weekly** (7-day) limit.
  - The inner ring is how full the **context** window is.
  - Each meter has a toggle (◉ / ○) to hide or show it. The **▂▅▇** icon in the top right switches to a bar chart, and the same toggles apply to the bars.
- **Main topics**: your chat titles ranked by how many prompts you sent in each, with **Day / Week / Month** tabs.
- **Most used**: your top plugins, connectors and skills over the last 7 days.

It runs entirely on your machine and uses no credits. The meters come from usage figures the session already has, and the other cards are counted from your local chat history (`~/.claude/projects`).

## Install

Type this at the prompt of a terminal Claude Code session:

```
/plugin install home-dashboard --marketplace imnotnikos/Credit-Dashboard-for-Claude
```

Answer `y` to add the marketplace, then pick the **user** scope. Once installed at user scope, it also loads in the Claude desktop app's Code tab.

## Use

The pane opens when a session starts. Type `/home-dashboard` to reopen it.

With the pane focused, these keys work:

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Toggle the session / weekly / context meter |
| `b` | Switch between rings and bars |
| `d` / `w` / `m` | Show topics for the last day / week / month |

## Notes

- The meters show "—" until the first reply of a session, because that's when usage figures arrive.
- claude.ai connectors are only stored by an ID, so each one is named after a word its tools share (for example "Firecrawl").
- History files over 4 MB are skipped.
