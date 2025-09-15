# Git dumper

This tool is used to dump the entire text contents of a git repository into a single text file. It allows for regex-based filtering to match specific file extensions (i.e. Python, JavaScript, etc.)

The input interface should be:

1. The text input area for the Github repository
2. The regex-based filtering for file extensions (optional)

The output interface should be:

1. The text output area for the dump
2. A button that copies the entire content of the dump to the clipboard

## Quick Start (Client-side App)

This repository includes a browser-based, fully client-side implementation. No server is required. It uses the GitHub REST API to list files in a repository, optionally filter them using a regex for file paths, and dump the text contents into one output area which you can copy or download as a `.txt` file.

### Files

- `index.html` — UI with inputs for the GitHub repo URL, optional branch, optional regex filter, and optional GitHub token. Includes actions to Dump, Cancel, Clear, Copy, and Download.
- `style.css` — Styling for a clean, modern look.
- `script.js` — Core logic for calling the GitHub API, filtering paths, fetching file contents, and assembling the dump.

### How to Use

1. Boot up a static server (e.g. `python -m http.server` or `npx serve`)
2. Go to the local URL (typically something like `http://localhost:8000`)
3. Enter the repository URL in the form `https://github.com/OWNER/REPO`.
4. (Optional) Enter a branch name. If left blank, the repository default branch will be used.
5. (Optional) Enter a regex for file paths, for example: `\.(py|js|ts|tsx|jsx|json|md|txt|css|html)$` [^1]
6. (Optional but recommended for larger repos) Provide a GitHub Personal Access Token to increase rate limits.
7. Click `Dump` to start. Progress and status are shown below the buttons.
8. Once complete, copy the entire dump or click `Download` to save as a text file.

### Notes

- Rate limits: unauthenticated usage is limited to about 60 requests/hour per IP. With a token there are no limits.
- Privacy: all actions run in your browser; no server-side processing.
- Large/binary files: the tool skips files larger than ~1MB and _attempts_ to ignore binary files.
- Errors on individual files are recorded inline in the dump and do not abort the entire process.

[^1]: but what is this magical concept of "regex", you might ask. Long story short, "regex" stands for regular expressions, a set of apparently messy strings of characters which help you match specific items and objects. If you want to learn more: I 100% recommend going to [regex101](https://regex101.com/).