# Themes

Themes are pi's format ([themes.md](../../pi/coding-agent/docs/themes.md#understand-the-theme-file)).
The client chooses the theme, not the agent: `ui.theme` in the user's UI settings
([operations/settings.md](../operations/settings.md)) names one of pi's built-in themes or a theme
file in `~/.harness/themes/`; without it the TUI takes pi's `theme` setting
(`~/.harness/settings.json`). The theme applies when the TUI starts. Agents draw bridged
components with pi's default theme.
