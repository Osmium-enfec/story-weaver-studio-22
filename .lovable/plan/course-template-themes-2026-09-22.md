# Course template themes

## Goal
Add a permanent course setting that controls the accent style of question, coding, countdown, typing, and fixed template scenes. Zero Code will default to a blue gradient, while existing courses keep the current orange style unless changed.

## Changes
- Add `Blue gradient` and `Orange gradient` choices to the course settings popup, with visual swatches.
- Save the selected template theme in the existing course settings.
- Apply it to every template state: editor previews, full-part previews, question intro/countdown screens, MCQ/MSQ and predict-output cards, coding-problem screens, and fixed text/countdown/typing cards.
- Include the selected theme in frozen HD render packages so remote renders match the preview even if course settings later change.
- Preserve existing scene content and narration; changing the theme will restyle already-built templates without regeneration.

## Technical details
- Define shared theme palettes and resolvers used by both React previews and canvas rendering.
- Pass the active theme alongside the existing course background through preview and export paths.
- Freeze the theme value into HD bundle payloads and use it in rasterization.
- Validate the settings popup and representative question/coding/template previews, then confirm the app build is healthy.
