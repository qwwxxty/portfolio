# Artur Kulik — portfolio

Static site for GitHub Pages: plain HTML, CSS and JavaScript with no build step.

- `index.html` — all page content, including reel titles and descriptions
- `assets/css/style.css` — design tokens and layout
- `assets/js/main.js` — scroll animation, previews, compare slider and player
- `assets/media/reels` — full reels with sound (720×1280, H.264/AAC)
- `assets/media/previews` — 6-second silent loops
- `assets/media/compare` — the two synced clips for the compare slider
- `assets/media/posters` — card and player poster frames

To add a reel, put its files in those folders under one name, then copy a `<li class="card">` block in `index.html` and change the name and text.
