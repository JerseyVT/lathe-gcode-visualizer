# Publish the Lathe G-code Visualizer with GitHub Pages

1. Create a public GitHub repository named `lathe-gcode-visualizer`.
2. Extract this ZIP. Upload `index.html`, `style.css`, `parser.js`, and `app.js` to the root of the repository and commit them. If using Git, include `.nojekyll` too.
3. In the repository, open Settings → Pages. Under Build and deployment, select Deploy from a branch, then the main branch and /(root), and Save.
4. Wait for GitHub Pages to finish deploying. Settings → Pages shows the published website URL, normally https://YOUR-USERNAME.github.io/lathe-gcode-visualizer/.

The application runs entirely in each visitor's browser. Python/server.py and run.command are not needed on GitHub Pages. G-code stays in that visitor's browser; there is no shared storage or backend.

The current UI, stock inputs, axis colors, diameter programming, classroom diagnostics, playback controls, and steady source-line highlight are preserved.

To update the website later, commit the changed browser files to main; GitHub Pages republishes from that branch.
