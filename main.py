"""itransfer: a tiny self-hosted file transfer server.

Upload one or more files (or folders) from the machine running the server, get a link,
friends preview and download them until it expires.

Only requests that reach the server directly on localhost may upload. Requests that
arrive through the public tunnel (Host is the tunnel name, Cloudflare headers present)
can only view and download, so sharing a link never exposes the upload page.

Upload flow (all requests are small and short, so tunnels/proxies never time out):
  POST /api/transfers                       -> new pending transfer
  POST /api/transfers/{id}/files            -> register a file {name, size}
  PUT  /api/transfers/{id}/files/{i}/chunks/{n}   -> upload CHUNK_SIZE piece n
  POST /api/transfers/{id}/finish           -> make it downloadable (instant)
A transfer only becomes visible once its meta.json exists. Files are kept as uploaded;
"download all" streams a zip on the fly.
"""

import asyncio
import io
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import zipfile
from contextlib import asynccontextmanager
from html import escape
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

HERE = Path(__file__).parent
WEB = HERE / "web"
DATA_DIR = Path(os.environ.get("ITRANSFER_DATA", "data"))
PUBLIC_URL_FILE = HERE / "public_url.txt"  # written by start.bat once the tunnel is up
MAX_BYTES = int(float(os.environ.get("ITRANSFER_MAX_GB", "5")) * 1024**3)
MAX_FILES = 20000
ALLOWED_DAYS = (1, 3, 7)
CHUNK_SIZE = 4 * 1024 * 1024  # well under the 100 MB per-request cap of free tunnels
CLEANUP_INTERVAL = 600  # seconds
PENDING_TTL = 3 * 3600  # unfinished uploads untouched this long are dropped

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
PROXY_HEADERS = ("cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "forwarded")

meta_lock = threading.Lock()
# transfer id -> {"count": files registered, "total": bytes declared}. Saves rescanning the
# folder on every registration, which would be quadratic for folders with thousands of files.
registry: dict[str, dict] = {}


def human_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def guess_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


# ---------------------------------------------------------------- access control

def is_owner(request: Request) -> bool:
    """True only for requests made directly on this machine, not via the tunnel."""
    host = request.headers.get("host", "")
    if urlsplit("//" + host).hostname not in LOCAL_HOSTS:
        return False
    if any(h in request.headers for h in PROXY_HEADERS):
        return False
    origin = request.headers.get("origin")
    return origin is None or urlsplit(origin).netloc == host  # blocks cross-site requests


def require_owner(request: Request) -> None:
    if not is_owner(request):
        raise HTTPException(403, "Uploading is only allowed from the computer running itransfer")


# ---------------------------------------------------------------- transfers on disk

def is_valid_id(transfer_id: str) -> bool:
    # IDs are token_urlsafe; rejecting anything else blocks path traversal.
    return transfer_id.replace("-", "").replace("_", "").isalnum()


def load_meta(transfer_id: str) -> dict | None:
    """Metadata of a finished, unexpired transfer, or None."""
    if not is_valid_id(transfer_id):
        return None
    try:
        meta = json.loads((DATA_DIR / transfer_id / "meta.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    if meta["expires_at"] <= time.time():
        return None
    if "title" not in meta:  # made by an older version: a single stored blob called "file"
        meta = {
            "title": None,
            "files": [{"name": meta["name"], "size": meta["size"], "type": guess_type(meta["name"])}],
            "size": meta["size"],
            "created_at": meta["expires_at"] - 3 * 86400,
            "expires_at": meta["expires_at"],
            "downloads": 0,
            "previews": 0,
        }
    return meta


def blob_path(transfer_id: str, index: int) -> Path:
    folder = DATA_DIR / transfer_id
    path = folder / f"blob-{index}"
    return path if path.exists() else folder / "file"


def bump(transfer_id: str, field: str) -> None:
    with meta_lock:
        meta = load_meta(transfer_id)
        if meta is None:
            return
        meta[field] = meta.get(field, 0) + 1
        target = DATA_DIR / transfer_id
        (target / "meta.tmp").write_text(json.dumps(meta))
        (target / "meta.tmp").replace(target / "meta.json")


def pending_folder(transfer_id: str) -> Path:
    """Folder of a transfer that is still being uploaded (not finished)."""
    folder = DATA_DIR / transfer_id
    if not is_valid_id(transfer_id) or not folder.is_dir() or (folder / "meta.json").exists():
        raise HTTPException(404, "No such pending transfer")
    return folder


def registered_files(folder: Path) -> list[dict]:
    files = sorted(folder.glob("file-*.json"), key=lambda p: int(p.stem.split("-")[1]))
    return [json.loads(p.read_text()) for p in files]


def pending_state(folder: Path) -> dict:
    state = registry.get(folder.name)
    if state is None:  # first use since the server started: rebuild from disk
        files = registered_files(folder)
        state = registry[folder.name] = {"count": len(files), "total": sum(f["size"] for f in files)}
    return state


def clean_path(name: str) -> str:
    """Relative path made safe for use inside a zip (no absolute paths, no '..')."""
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return "/".join(parts) or "file"


def purge_expired() -> None:
    if not DATA_DIR.exists():
        return
    now = time.time()
    for entry in DATA_DIR.iterdir():
        if not entry.is_dir():
            continue
        try:
            stale = json.loads((entry / "meta.json").read_text())["expires_at"] <= now
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            # Unfinished upload: judge by the newest write inside it.
            newest = max([entry.stat().st_mtime, *(p.stat().st_mtime for p in entry.iterdir())])
            stale = now - newest > PENDING_TTL
        if stale:
            registry.pop(entry.name, None)
            shutil.rmtree(entry, ignore_errors=True)


async def cleanup_loop() -> None:
    while True:
        await asyncio.to_thread(purge_expired)
        await asyncio.sleep(CLEANUP_INTERVAL)


@asynccontextmanager
async def lifespan(_: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=WEB), name="static")


# ---------------------------------------------------------------- pages

def asset_version() -> str:
    return str(int(max(p.stat().st_mtime for p in WEB.iterdir())))


def fill(template: str, values: dict[str, str]) -> str:
    """Replace __TOKENS__ in one pass, so inserted text is never scanned for tokens again."""
    return re.sub(r"__([A-Z]+)__", lambda m: values.get(m.group(1), m.group(0)), template)


def safe_json(data) -> str:
    """JSON that is safe to embed inside a <script> element."""
    return json.dumps(data).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def simple_page(title: str, body: str, status: int = 200) -> HTMLResponse:
    html = (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{escape(title)}</title><link rel=stylesheet href='/static/app.css?v={asset_version()}'>"
        f"<div class=card>{body}</div>"
    )
    return HTMLResponse(html, status_code=status)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not is_owner(request):
        return simple_page(
            "itransfer",
            "<h1>itransfer</h1><p>This is a private file server. If someone sent you a link, open that link.</p>",
            403,
        )
    page = (WEB / "upload.html").read_text(encoding="utf-8")
    return fill(page, {"V": asset_version(), "MAXBYTES": str(MAX_BYTES), "MAX": human_size(MAX_BYTES)})


@app.get("/d/{transfer_id}", response_class=HTMLResponse)
async def transfer_page(transfer_id: str):
    meta = load_meta(transfer_id)
    if meta is None:
        return simple_page(
            "Link expired",
            "<h1>This link has expired</h1><p>Ask the sender to send it again.</p>",
            404,
        )
    shown = {k: meta[k] for k in ("title", "files", "size", "created_at", "expires_at")} | {"id": transfer_id}
    page = (WEB / "transfer.html").read_text(encoding="utf-8")
    return fill(page, {
        "V": asset_version(),
        "TITLE": escape(meta["title"] or "Untitled transfer"),
        "DATA": safe_json(shown),
    })


# ---------------------------------------------------------------- owner API (upload side)

@app.get("/api/config")
async def config(request: Request) -> dict:
    require_owner(request)
    try:
        public_url = PUBLIC_URL_FILE.read_text().strip() or None
    except FileNotFoundError:
        public_url = None
    return {"public_url": public_url, "chunk_size": CHUNK_SIZE}


@app.post("/api/transfers")
async def create_transfer(request: Request, days: int = 3, title: str = "") -> dict:
    require_owner(request)
    if days not in ALLOWED_DAYS:
        raise HTTPException(400, f"days must be one of {ALLOWED_DAYS}")
    transfer_id = secrets.token_urlsafe(16)
    folder = DATA_DIR / transfer_id
    folder.mkdir(parents=True)
    (folder / "days").write_text(str(days))
    (folder / "title").write_text(title.strip()[:100])
    return {"id": transfer_id}


class NewFile(BaseModel):
    name: str = Field(max_length=1024)  # relative path for files that came from a folder
    size: int = Field(ge=0)  # empty files are fine (folders often contain some)


@app.post("/api/transfers/{transfer_id}/files")
async def register_file(transfer_id: str, request: Request, body: NewFile) -> dict:
    require_owner(request)
    folder = pending_folder(transfer_id)
    state = pending_state(folder)
    if state["count"] >= MAX_FILES:
        raise HTTPException(413, f"Too many files (max {MAX_FILES} per transfer; zip the folder first)")
    if state["total"] + body.size > MAX_BYTES:
        raise HTTPException(413, f"Transfer too large (max {human_size(MAX_BYTES)} in total)")
    index = state["count"]
    (folder / f"part-{index}").touch()
    (folder / f"file-{index}.json").write_text(json.dumps({"name": clean_path(body.name), "size": body.size}))
    state["count"] += 1
    state["total"] += body.size
    return {"index": index}


def write_at(path: Path, offset: int, data: bytes) -> None:
    with open(path, "r+b") as f:
        f.seek(offset)
        f.write(data)


@app.put("/api/transfers/{transfer_id}/files/{index}/chunks/{n}")
async def put_chunk(transfer_id: str, index: int, n: int, request: Request) -> dict:
    require_owner(request)
    folder = pending_folder(transfer_id)
    try:
        size = json.loads((folder / f"file-{index}.json").read_text())["size"]
    except FileNotFoundError:
        raise HTTPException(404, "File not registered") from None
    start = n * CHUNK_SIZE
    if n < 0 or start >= size:
        raise HTTPException(400, "Chunk out of range")
    if int(request.headers.get("content-length") or 0) > CHUNK_SIZE:
        raise HTTPException(413, "Chunk too large")
    data = await request.body()
    if len(data) != min(CHUNK_SIZE, size - start):
        raise HTTPException(400, "Chunk has the wrong size")
    await asyncio.to_thread(write_at, folder / f"part-{index}", start, data)
    (folder / f"got-{index}-{n}").touch()  # re-sending a chunk is harmless
    return {"ok": True}


def finalize(folder: Path, files: list[dict]) -> None:
    """Keep the uploaded files as they are and write meta.json (last, so it appears atomically)."""
    now = time.time()
    days = int((folder / "days").read_text())
    title = (folder / "title").read_text() if (folder / "title").exists() else ""
    stored = []
    for i, f in enumerate(files):
        (folder / f"part-{i}").replace(folder / f"blob-{i}")
        stored.append({"name": f["name"], "size": f["size"], "type": guess_type(f["name"])})
    for leftover in [*folder.glob("got-*"), *folder.glob("file-*.json"), folder / "days", folder / "title"]:
        leftover.unlink(missing_ok=True)
    meta = {
        "title": title or None,
        "files": stored,
        "size": sum(f["size"] for f in stored),
        "created_at": now,
        "expires_at": now + days * 86400,
        "downloads": 0,
        "previews": 0,
    }
    (folder / "meta.json").write_text(json.dumps(meta))


@app.post("/api/transfers/{transfer_id}/finish")
async def finish_transfer(transfer_id: str, request: Request) -> dict:
    require_owner(request)
    folder = pending_folder(transfer_id)
    files = registered_files(folder)
    if not files:
        raise HTTPException(400, "No files uploaded")
    got: dict[int, int] = {}  # file index -> chunks received (one directory scan, not one per file)
    for marker in folder.glob("got-*"):
        index = int(marker.name.split("-")[1])
        got[index] = got.get(index, 0) + 1
    for i, f in enumerate(files):
        if got.get(i, 0) != math.ceil(f["size"] / CHUNK_SIZE):
            raise HTTPException(400, f"{f['name']} did not finish uploading")
    registry.pop(transfer_id, None)
    await asyncio.to_thread(finalize, folder, files)
    return {"path": f"/d/{transfer_id}"}


@app.get("/api/transfers/{transfer_id}/details")
async def transfer_details(transfer_id: str, request: Request) -> dict:
    require_owner(request)
    meta = load_meta(transfer_id)
    if meta is None:
        raise HTTPException(404, "No such transfer")
    return meta | {"id": transfer_id, "path": f"/d/{transfer_id}"}


# ---------------------------------------------------------------- downloads and previews

def counted(request: Request, transfer_id: str, field: str) -> None:
    """Count a visit, unless it's the owner looking at their own transfer."""
    if not is_owner(request):
        bump(transfer_id, field)


def inline_type(content_type: str) -> str | None:
    """Content type to use when showing a file in the browser, or None if it must download."""
    if content_type.startswith("text/"):
        return "text/plain; charset=utf-8"  # never let uploaded HTML render
    if content_type.startswith(("image/", "video/", "audio/")) or content_type == "application/pdf":
        return content_type
    return None


@app.get("/d/{transfer_id}/f/{index}")
async def get_file(transfer_id: str, index: int, request: Request, dl: int = 0, thumb: int = 0):
    meta = load_meta(transfer_id)
    if meta is None or not 0 <= index < len(meta["files"]):
        raise HTTPException(404, "Link expired")
    info = meta["files"][index]
    shown = None if dl else inline_type(info["type"])
    if not thumb:
        if dl:
            counted(request, transfer_id, "downloads")
        elif request.headers.get("range", "bytes=0-").startswith("bytes=0-"):
            counted(request, transfer_id, "previews")  # seeking in a video makes many ranged requests
    headers = {"X-Content-Type-Options": "nosniff"}
    if shown and shown != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox"  # e.g. an SVG can't run scripts when opened directly
    return FileResponse(
        blob_path(transfer_id, index),
        media_type=shown or "application/octet-stream",
        filename=info["name"].rsplit("/", 1)[-1],
        content_disposition_type="inline" if shown else "attachment",
        headers=headers,
    )


class _Sink(io.RawIOBase):
    """Write-only buffer that lets zipfile produce a zip as a stream (it can't seek here)."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        self.chunks.append(bytes(data))
        return len(data)

    def drain(self) -> bytes:
        data = b"".join(self.chunks)
        self.chunks.clear()
        return data


def zip_stream(entries: list[tuple[str, Path]]):
    """Yield a stored (uncompressed) zip of the given (name in zip, file) pairs, chunk by chunk."""
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for arcname, path in entries:
            info = zipfile.ZipInfo(arcname, date_time=time.localtime(path.stat().st_mtime)[:6])
            info.compress_type = zipfile.ZIP_STORED
            with zf.open(info, "w", force_zip64=True) as dest, open(path, "rb") as src:
                while chunk := src.read(1024 * 1024):
                    dest.write(chunk)
                    if data := sink.drain():
                        yield data
            if data := sink.drain():
                yield data
    if data := sink.drain():
        yield data


def zip_entries(transfer_id: str, meta: dict, indexes: list[int]) -> list[tuple[str, Path]]:
    seen: set[str] = set()
    entries = []
    for i in indexes:
        name = meta["files"][i]["name"]
        arcname, k = name, 1
        while arcname in seen:  # same path twice: "a.txt", "a (2).txt", ...
            k += 1
            p = PurePosixPath(name)
            arcname = str(p.with_name(f"{p.stem} ({k}){p.suffix}"))
        seen.add(arcname)
        entries.append((arcname, blob_path(transfer_id, i)))
    return entries


def zip_name(meta: dict, names: list[str]) -> str:
    if meta["title"]:
        return re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", meta["title"]).strip() + ".zip"
    tops = {n.split("/")[0] for n in names}
    if len(tops) == 1 and all("/" in n for n in names):  # one folder -> name the zip after it
        return f"{tops.pop()}.zip"
    return f"itransfer-{len(names)}-files.zip"


@app.get("/d/{transfer_id}/zip")
async def get_zip(transfer_id: str, request: Request, files: str = ""):
    meta = load_meta(transfer_id)
    if meta is None:
        raise HTTPException(404, "Link expired")
    total = len(meta["files"])
    try:
        indexes = sorted({int(x) for x in files.split(",") if x}) or list(range(total))
    except ValueError:
        raise HTTPException(400, "Bad file list") from None
    if any(not 0 <= i < total for i in indexes):
        raise HTTPException(400, "Bad file list")
    counted(request, transfer_id, "downloads")
    name = zip_name(meta, [meta["files"][i]["name"] for i in indexes])
    ascii_name = re.sub(r'[^\x20-\x7e]|["\\]', "_", name)
    return StreamingResponse(
        zip_stream(zip_entries(transfer_id, meta, indexes)),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"},
    )


def main() -> None:
    import uvicorn

    # Loopback only: the machine itself and the local tunnel client can reach it, nothing else.
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    main()
