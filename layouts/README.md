Layout overrides for the Congo theme (`themes/congo`, pinned at `v2.14.0`).

Hugo renamed/removed `Language.Locale` and `Language.Direction` on
`*langs.Language` (now `LanguageCode()` and `LanguageDirection`), which
Congo v2.14.0 doesn't know about yet - breaks on Hugo 0.146+. These three
files are copies of the theme's originals with just that fixed, placed here
because Hugo prefers project layouts over theme layouts at the same path -
keeps the `themes/congo` submodule itself untouched/pristine.

Drop these once Congo ships a fix upstream.

- baseof.html
- _partials/head.html
- _partials/schema.html

`_markup/render-image.html` is a copy of the theme's with one change:
root-absolute static image paths (`/images/...`) go through `relURL`, so
they pick up the baseURL subpath (e.g. `/bloggy-blog/`) on GitHub Pages.
Harmless at a domain root.
