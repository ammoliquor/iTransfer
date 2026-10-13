# itransfer

Self-hosted file transfer. Upload files or folders, get a link, friends preview and download them until it expires. No third parties, no database.

## One-click start (Windows)

Double-click **`start.bat`** (or the desktop shortcut). It starts the server and a free Cloudflare tunnel, then opens the upload page in your browser. Press any key in its window to stop everything.

First run only:

```
winget install astral-sh.uv
winget install Cloudflare.cloudflared
```

- **Upload** at `http://localhost:8000` on the computer running it. No password: uploading only works from that computer.
- **Share** the link it gives you (`https://….trycloudflare.com/d/…`). Friends can only view and download with a link; the public address can't upload.
- The public address changes every run, and links only work while `start.bat` is running.

## What you and your friends see

- **After uploading:** a "You're done!" card with a thumbnail, the link, **View** (full-screen preview of every file) and a **details panel**: link, expiry date, total downloads and previews (your own views from this PC aren't counted), and the files.
- **The link page:** title, time left, **Open** (preview) and **Download**. Files show as large previews, small previews or a list, sorted by name, size or type. Tick files to open or download just those.
- **Previews:** images, video, audio, PDF and text open in the browser; anything else offers a download. Next/previous with arrows, keys or a swipe.
- **Download all** streams a zip on the fly, so there is no waiting and no extra disk space. One file downloads as itself. A folder keeps its structure.

## How it works

Files are uploaded in 4 MB chunks, 3 at a time, each retried automatically, so large files and slow connections don't hit tunnel timeouts or the 100 MB per-request cap. Files are kept as uploaded in `./data` and deleted automatically after 1, 3 or 7 days. The page code lives in `web/`.

## Run manually

```
uv run main.py
```

| Env var | Default | Meaning |
|---|---|---|
| `ITRANSFER_MAX_GB` | `5` | Max total size of one transfer |
| `ITRANSFER_DATA` | `data` | Where files are kept |
| `PORT` | `8000` | Listen port (localhost only) |

## Notes

- Download speed for your friends is limited by **your** upload bandwidth, since files are served from your PC.
- Up to 20,000 files per transfer.
- Files are stored unencrypted on your disk.
- Uploaded text-like files are always shown as plain text and images/PDFs in a sandbox, so a file can't run code in a viewer's browser.
