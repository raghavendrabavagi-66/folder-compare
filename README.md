# Folder Compare

Light-themed tool to compare trees side by side, highlight differences, and copy selected files or folders across.

## Modes

- **Local ↔ Local** — compare two folders on disk
- **GitLab ↔ Local** — authenticate with a GitLab project ID + PAT, pick a branch, compare to a local folder (transfer branch → local only)

## GitLab setup

1. Open **GitLab ↔ Local**
2. Enter GitLab URL (default `https://gitlab.com`, or your self-hosted URL)
3. Enter **Project ID** (numeric ID or `group/project` path)
4. Enter a **Personal Access Token** with at least `read_api` and `read_repository`
5. Click **Authenticate** — the branch dropdown appears
6. Choose a branch and local folder, then **Compare**

The PAT is kept in memory for the session only (not saved to disk).

Git LFS files are resolved to raw content on download (`include_lfs_blobs` plus pointer expansion), so transfers copy real files, not LFS pointer stubs.

## Features

- Dual tree view with synced expand/collapse and scroll
- Highlights for only-here, only-other, content changes, and ignored paths
- Ignore selected files/folders (remembered per compare pair)
- Center **→ / ←** transfer (← disabled in GitLab mode)
- Double-click a changed file to preview text on both sides
- Text compares ignore CRLF vs LF

## Run

```bash
python3 app.py
```

Opens `http://127.0.0.1:8787` in your browser. Uses Python’s standard library only (network needed for GitLab mode).

Press `Ctrl+C` in the terminal to stop.
