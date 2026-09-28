#!/usr/bin/env python3
"""Folder Compare — local light-themed dual-folder compare and transfer tool."""

from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8787
SKIP_NAMES = {".DS_Store", "Thumbs.db", ".git"}
GITLAB_CACHE = Path(tempfile.gettempdir()) / "folder-compare-gitlab"
# Bump when extract/LFS behavior changes so old pointer caches are ignored.
GITLAB_CACHE_VERSION = "lfs2"
LFS_POINTER_RE = re.compile(
    rb"^version https://git-lfs\.github\.com/spec/v1\r?\n"
    rb"oid sha256:([a-f0-9]{64})\r?\n"
    rb"size (\d+)\r?\n?$"
)


def normalize_rel(path: str | Path) -> str:
    return str(path).replace("\\", "/").strip("/")


def hash_file(path: Path) -> str:
    """Hash file contents. Text files ignore CRLF vs LF so ending-only diffs match."""
    data = path.read_bytes()
    if b"\x00" in data:
        # Binary: compare exact bytes
        payload = data
    else:
        # Text: normalize Windows/Mac classic endings to LF before hashing
        payload = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return hashlib.sha256(payload).hexdigest()


def walk_tree(root: Path, relative: str = "") -> dict[str, Any] | None:
    full = root / relative if relative else root
    try:
        if not full.exists():
            return None
    except OSError:
        return None

    name = Path(relative).name if relative else root.name

    if full.is_dir():
        children: list[dict[str, Any]] = []
        try:
            entries = sorted(
                full.iterdir(),
                key=lambda p: (not p.is_dir(), p.name.lower()),
            )
        except OSError:
            entries = []

        for entry in entries:
            if entry.name in SKIP_NAMES:
                continue
            child_rel = normalize_rel(Path(relative) / entry.name) if relative else entry.name
            child = walk_tree(root, child_rel)
            if child is not None:
                children.append(child)

        return {
            "name": name,
            "relativePath": normalize_rel(relative),
            "type": "dir",
            "children": children,
        }

    try:
        stat = full.stat()
        file_hash = hash_file(full)
    except OSError:
        return None

    return {
        "name": name,
        "relativePath": normalize_rel(relative),
        "type": "file",
        "size": stat.st_size,
        "mtimeMs": stat.st_mtime * 1000,
        "hash": file_hash,
    }


def flatten_files(node: dict[str, Any] | None, out: dict[str, dict[str, Any]] | None = None):
    if out is None:
        out = {}
    if not node:
        return out
    if node["type"] == "file":
        out[normalize_rel(node["relativePath"])] = node
    else:
        for child in node.get("children") or []:
            flatten_files(child, out)
    return out


def flatten_dirs(node: dict[str, Any] | None, out: dict[str, dict[str, Any]] | None = None):
    if out is None:
        out = {}
    if not node:
        return out
    if node["type"] == "dir":
        rel = normalize_rel(node["relativePath"])
        if rel:
            out[rel] = node
        for child in node.get("children") or []:
            flatten_dirs(child, out)
    return out


def parent_rel(rel: str) -> str:
    if "/" not in rel:
        return ""
    return rel.rsplit("/", 1)[0]


def build_ghost_subtree(node: dict[str, Any]) -> list[dict[str, Any]] | None:
    if node["type"] == "file":
        return None
    ghosts = []
    for child in node.get("children") or []:
        item = {
            "name": child["name"],
            "relativePath": normalize_rel(child["relativePath"]),
            "type": child["type"],
            "status": "ghost",
            "size": child.get("size"),
        }
        if child["type"] == "dir":
            item["children"] = build_ghost_subtree(child)
        ghosts.append(item)
    return ghosts


def annotate_tree(
    node: dict[str, Any] | None,
    other_files: dict[str, dict[str, Any]],
    other_dirs: dict[str, dict[str, Any]],
    side_files: dict[str, dict[str, Any]],
    is_root: bool = False,
) -> dict[str, Any] | None:
    if not node:
        return None

    if node["type"] == "file":
        key = normalize_rel(node["relativePath"])
        other = other_files.get(key)
        if other is None:
            status = "missing-other"
        elif other.get("hash") != node.get("hash"):
            status = "modified"
        else:
            status = "same"
        return {**node, "status": status, "children": None}

    children = [
        annotate_tree(child, other_files, other_dirs, side_files, False)
        for child in (node.get("children") or [])
    ]
    children = [c for c in children if c is not None]

    here_prefix = normalize_rel(node["relativePath"])
    seen = {c["name"] for c in children}
    ghosts: list[dict[str, Any]] = []

    for rel, other_node in other_files.items():
        if parent_rel(rel) != here_prefix:
            continue
        if rel in side_files or other_node["name"] in seen:
            continue
        ghosts.append(
            {
                "name": other_node["name"],
                "relativePath": rel,
                "type": "file",
                "status": "ghost",
                "size": other_node.get("size"),
            }
        )
        seen.add(other_node["name"])

    for rel, other_node in other_dirs.items():
        if parent_rel(rel) != here_prefix:
            continue
        exists_here = any(c["type"] == "dir" and c["name"] == other_node["name"] for c in children)
        if exists_here or other_node["name"] in seen:
            continue
        ghosts.append(
            {
                "name": other_node["name"],
                "relativePath": rel,
                "type": "dir",
                "status": "ghost",
                "children": build_ghost_subtree(other_node),
            }
        )
        seen.add(other_node["name"])

    all_children = children + ghosts
    all_children.sort(key=lambda c: (c["type"] != "dir", c["name"].lower()))

    if is_root:
        status = (
            "partial"
            if any(c["status"] != "same" for c in all_children)
            else "same"
        )
    else:
        key = normalize_rel(node["relativePath"])
        if key and key not in other_dirs:
            status = "missing-other"
        elif any(
            c["status"] in {"missing-other", "modified", "ghost", "partial"}
            for c in all_children
        ):
            status = "partial"
        else:
            status = "same"

    return {**node, "status": status, "children": all_children}


def compare_folders(left_path: str, right_path: str) -> dict[str, Any]:
    left_root = Path(left_path).expanduser().resolve()
    right_root = Path(right_path).expanduser().resolve()
    if not left_root.is_dir():
        raise ValueError(f"Left path is not a folder: {left_root}")
    if not right_root.is_dir():
        raise ValueError(f"Right path is not a folder: {right_root}")

    left_raw = walk_tree(left_root)
    right_raw = walk_tree(right_root)
    left_files = flatten_files(left_raw)
    right_files = flatten_files(right_raw)
    left_dirs = flatten_dirs(left_raw)
    right_dirs = flatten_dirs(right_raw)

    left_tree = annotate_tree(left_raw, right_files, right_dirs, left_files, True)
    right_tree = annotate_tree(right_raw, left_files, left_dirs, right_files, True)

    same = modified = only_left = only_right = 0
    for key in set(left_files) | set(right_files):
        left = left_files.get(key)
        right = right_files.get(key)
        if left and right:
            if left.get("hash") == right.get("hash"):
                same += 1
            else:
                modified += 1
        elif left:
            only_left += 1
        else:
            only_right += 1

    return {
        "leftTree": left_tree,
        "rightTree": right_tree,
        "summary": {
            "same": same,
            "modified": modified,
            "onlyLeft": only_left,
            "onlyRight": only_right,
            "total": same + modified + only_left + only_right,
        },
    }


def copy_path(src: Path, dest: Path) -> None:
    if src.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        for entry in src.iterdir():
            if entry.name in SKIP_NAMES:
                continue
            copy_path(entry, dest / entry.name)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def transfer_items(
    left_path: str,
    right_path: str,
    direction: str,
    relative_paths: list[str],
) -> dict[str, Any]:
    left_root = Path(left_path).expanduser().resolve()
    right_root = Path(right_path).expanduser().resolve()
    from_root = left_root if direction == "left-to-right" else right_root
    to_root = right_root if direction == "left-to-right" else left_root

    results = []
    for rel in relative_paths:
        normalized = normalize_rel(rel)
        src = (from_root / normalized).resolve()
        dest = (to_root / normalized).resolve()
        try:
            if not str(src).startswith(str(from_root)):
                raise ValueError("Invalid source path")
            if not str(dest).startswith(str(to_root)):
                raise ValueError("Invalid destination path")
            if not src.exists():
                raise FileNotFoundError(f"Missing source: {normalized}")
            copy_path(src, dest)
            results.append({"relativePath": normalized, "ok": True})
        except Exception as exc:  # noqa: BLE001 - collect per-item errors for UI
            results.append(
                {"relativePath": normalized, "ok": False, "error": str(exc)}
            )

    return {
        "results": results,
        "comparison": compare_folders(str(left_root), str(right_root)),
    }


def read_text_side(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False, "binary": False, "text": None, "size": 0}
    data = path.read_bytes()
    size = len(data)
    if b"\x00" in data:
        return {"exists": True, "binary": True, "text": None, "size": size}
    limit = 512 * 1024
    truncated = size > limit
    text = data[:limit].decode("utf-8", errors="replace")
    return {
        "exists": True,
        "binary": False,
        "text": text,
        "truncated": truncated,
        "size": size,
    }


def read_text_diff(left_path: str, right_path: str, relative_path: str) -> dict[str, Any]:
    rel = normalize_rel(relative_path)
    left = Path(left_path).expanduser().resolve() / rel
    right = Path(right_path).expanduser().resolve() / rel
    return {
        "relativePath": rel,
        "left": read_text_side(left),
        "right": read_text_side(right),
    }


def pick_folder() -> str | None:
    """Open a native folder chooser (macOS, Windows, or Tk fallback)."""
    if sys.platform == "darwin":
        script = 'POSIX path of (choose folder with prompt "Select folder")'
        try:
            completed = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            return None
        if completed.returncode != 0:
            return None
        path = completed.stdout.strip()
        return path or None

    if sys.platform == "win32":
        ps_script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description = 'Select folder'; "
            "$d.ShowNewFolderButton = $true; "
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
            "{ [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
            "Write-Output $d.SelectedPath }"
        )
        try:
            completed = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    ps_script,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
        except OSError:
            return _pick_folder_tk()
        if completed.returncode != 0:
            return _pick_folder_tk()
        path = (completed.stdout or "").strip()
        return path or None

    return _pick_folder_tk()


def _pick_folder_tk() -> str | None:
    """Folder picker via a short-lived Tk process (safe off the server thread)."""
    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "try:\n"
        "    root.attributes('-topmost', True)\n"
        "except Exception:\n"
        "    pass\n"
        "path = filedialog.askdirectory(title='Select folder')\n"
        "root.destroy()\n"
        "print(path or '')\n"
    )
    try:
        completed = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    path = (completed.stdout or "").strip()
    return path or None


def normalize_gitlab_host(host: str) -> str:
    value = (host or "https://gitlab.com").strip().rstrip("/")
    if not value.startswith("http://") and not value.startswith("https://"):
        value = "https://" + value
    return value


def encode_project_id(project_id: str) -> str:
    value = (project_id or "").strip()
    if not value:
        raise ValueError("GitLab project ID is required")
    # Numeric IDs stay as-is; path IDs need encoding (group/project -> group%2Fproject)
    if value.isdigit():
        return value
    return urllib.parse.quote(value, safe="")


def gitlab_request(
    host: str,
    token: str,
    api_path: str,
    *,
    binary: bool = False,
    method: str = "GET",
    body: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    host = normalize_gitlab_host(host)
    token = (token or "").strip()
    if not token:
        raise ValueError("Personal Access Token is required")

    url = f"{host}/api/v4{api_path}"
    headers = {
        "PRIVATE-TOKEN": token,
        "User-Agent": "folder-compare",
        "Accept": "application/json" if not binary else "*/*",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)

    request = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            raw = response.read()
            if binary:
                return raw
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(err_body) if err_body else {}
            detail = parsed.get("message") or parsed.get("error") or err_body
        except Exception:
            detail = str(exc.reason or exc)
        if exc.code in {401, 403}:
            raise ValueError(
                f"GitLab authentication failed ({exc.code}). Check the PAT scopes "
                f"(read_api / read_repository). {detail}".strip()
            ) from exc
        if exc.code == 404:
            raise ValueError(
                f"GitLab project or resource not found. Check the project ID. {detail}".strip()
            ) from exc
        raise ValueError(f"GitLab API error {exc.code}: {detail}".strip()) from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"Could not reach GitLab at {host}: {exc.reason}") from exc


def download_url(url: str, headers: dict[str, str] | None = None) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "folder-compare",
            **(headers or {}),
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = str(exc.reason or exc)
        raise ValueError(f"Download failed ({exc.code}): {detail}".strip()) from exc
    except urllib.error.URLError as exc:
        raise ValueError(f"Download failed: {exc.reason}") from exc


def is_lfs_pointer(data: bytes) -> bool:
    if not data or len(data) > 1024:
        return False
    return LFS_POINTER_RE.match(data) is not None


def parse_lfs_pointer(data: bytes) -> tuple[str, int] | None:
    match = LFS_POINTER_RE.match(data)
    if not match:
        return None
    return match.group(1).decode("ascii"), int(match.group(2))


def fetch_lfs_file_content(
    host: str,
    token: str,
    project_id: str,
    project_path: str,
    relative_path: str,
    ref: str,
    pointer: bytes,
) -> bytes:
    """Resolve an LFS pointer to raw file bytes via GitLab APIs."""
    encoded = encode_project_id(project_id)
    file_enc = urllib.parse.quote(relative_path, safe="")
    ref_enc = urllib.parse.quote(ref, safe="")

    # Preferred: repository files raw endpoint with lfs=true (GitLab 16+).
    try:
        raw = gitlab_request(
            host,
            token,
            f"/projects/{encoded}/repository/files/{file_enc}/raw?ref={ref_enc}&lfs=true",
            binary=True,
        )
        if isinstance(raw, (bytes, bytearray)) and not is_lfs_pointer(bytes(raw)):
            return bytes(raw)
    except ValueError:
        pass

    parsed = parse_lfs_pointer(pointer)
    if not parsed:
        raise ValueError(f"Invalid LFS pointer for {relative_path}")
    oid, size = parsed

    # Fallback: Git LFS batch API under the project path.
    host_n = normalize_gitlab_host(host)
    batch_path = f"/{project_path.strip('/')}.git/info/lfs/objects/batch"
    payload = json.dumps(
        {
            "operation": "download",
            "transfers": ["basic"],
            "ref": {"name": f"refs/heads/{ref}"},
            "objects": [{"oid": oid, "size": size}],
        }
    ).encode("utf-8")

    def _batch(url: str, headers: dict[str, str]) -> dict[str, Any]:
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/vnd.git-lfs+json",
                "Accept": "application/vnd.git-lfs+json",
                "User-Agent": "folder-compare",
                **headers,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as response:
            parsed_batch = json.loads(response.read().decode("utf-8"))
        if not isinstance(parsed_batch, dict):
            raise ValueError("Unexpected LFS batch response")
        return parsed_batch

    batch: dict[str, Any]
    try:
        batch = _batch(
            f"{host_n}{batch_path}",
            {"Authorization": f"Bearer {token}"},
        )
    except Exception:
        parsed_host = urllib.parse.urlparse(host_n)
        auth_netloc = f"oauth2:{urllib.parse.quote(token, safe='')}@{parsed_host.hostname}"
        if parsed_host.port:
            auth_netloc += f":{parsed_host.port}"
        auth_base = urllib.parse.urlunparse(
            (parsed_host.scheme, auth_netloc, "", "", "", "")
        )
        try:
            batch = _batch(f"{auth_base}{batch_path}", {})
        except Exception as alt_exc:
            raise ValueError(
                f"LFS batch failed for {relative_path}: {alt_exc}"
            ) from alt_exc

    objects = batch.get("objects") if isinstance(batch, dict) else None
    if not objects:
        raise ValueError(f"LFS batch returned no objects for {relative_path}")
    obj = objects[0]
    if obj.get("error"):
        raise ValueError(
            f"LFS object error for {relative_path}: {obj.get('error')}"
        )
    actions = obj.get("actions") or {}
    download = actions.get("download") or {}
    href = download.get("href")
    if not href:
        raise ValueError(f"No LFS download URL for {relative_path}")
    headers = download.get("header") or {}
    return download_url(href, headers)


def materialize_lfs_pointers(
    root: Path,
    host: str,
    token: str,
    project_id: str,
    project_path: str,
    ref: str,
) -> int:
    """Replace any LFS pointer files under root with raw content. Returns count replaced."""
    replaced = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_size > 1024:
                continue
            data = path.read_bytes()
        except OSError:
            continue
        if not is_lfs_pointer(data):
            continue
        rel = path.relative_to(root).as_posix()
        raw = fetch_lfs_file_content(
            host, token, project_id, project_path, rel, ref, data
        )
        if is_lfs_pointer(raw):
            raise ValueError(
                f"GitLab still returned an LFS pointer for {rel}. "
                "Check that LFS is enabled and the PAT can read LFS objects."
            )
        path.write_bytes(raw)
        replaced += 1
    return replaced


def gitlab_authenticate(host: str, project_id: str, token: str) -> dict[str, Any]:
    encoded = encode_project_id(project_id)
    project = gitlab_request(host, token, f"/projects/{encoded}")
    if not isinstance(project, dict):
        raise ValueError("Unexpected GitLab project response")

    default_branch = project.get("default_branch") or ""
    branches: list[str] = []
    page = 1
    while page <= 50:
        chunk = gitlab_request(
            host,
            token,
            f"/projects/{encoded}/repository/branches?per_page=100&page={page}",
        )
        if not chunk:
            break
        if not isinstance(chunk, list):
            raise ValueError("Unexpected GitLab branches response")
        for item in chunk:
            name = (item or {}).get("name")
            if name and name not in branches:
                branches.append(name)
        if len(chunk) < 100:
            break
        page += 1

    if not branches:
        raise ValueError("No branches found for this GitLab project.")

    branches.sort(key=lambda b: (0 if b == default_branch else 1, b.lower()))
    return {
        "host": normalize_gitlab_host(host),
        "projectId": str(project.get("id") or project_id),
        "projectPath": project.get("path_with_namespace") or project_id,
        "projectName": project.get("name") or "",
        "defaultBranch": default_branch,
        "branches": branches,
    }


def extract_gitlab_branch(
    host: str, project_id: str, token: str, branch: str
) -> dict[str, Any]:
    branch = (branch or "").strip()
    if not branch:
        raise ValueError("Choose a GitLab branch")

    host = normalize_gitlab_host(host)
    encoded = encode_project_id(project_id)
    project = gitlab_request(host, token, f"/projects/{encoded}")
    if not isinstance(project, dict):
        raise ValueError("Unexpected GitLab project response")

    branch_info = gitlab_request(
        host,
        token,
        f"/projects/{encoded}/repository/branches/{urllib.parse.quote(branch, safe='')}",
    )
    if not isinstance(branch_info, dict):
        raise ValueError(f"Branch not found: {branch}")
    commit = ((branch_info.get("commit") or {}).get("id")) or ""
    if not commit:
        raise ValueError(f"Could not resolve commit for branch {branch}")

    project_key = str(project.get("id") or project_id)
    project_path = str(project.get("path_with_namespace") or project_id)
    cache_key = hashlib.sha1(
        f"{GITLAB_CACHE_VERSION}|{host}|{project_key}|{commit}".encode("utf-8")
    ).hexdigest()[:20]
    dest = GITLAB_CACHE / cache_key
    meta = GITLAB_CACHE / f"{cache_key}.commit"

    if not (dest.is_dir() and meta.is_file() and meta.read_text().strip() == commit):
        if dest.exists():
            shutil.rmtree(dest)
        staging = GITLAB_CACHE / f"{cache_key}-staging"
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True, exist_ok=True)

        archive_bytes = gitlab_request(
            host,
            token,
            f"/projects/{encoded}/repository/archive.tar.gz?sha="
            f"{urllib.parse.quote(branch, safe='')}&include_lfs_blobs=true",
            binary=True,
        )
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tar:
            tar.extractall(path=staging)

        entries = [p for p in staging.iterdir() if p.name not in SKIP_NAMES]
        if len(entries) == 1 and entries[0].is_dir():
            content_root = entries[0]
            dest.mkdir(parents=True, exist_ok=True)
            for child in content_root.iterdir():
                shutil.move(str(child), str(dest / child.name))
            shutil.rmtree(staging)
        else:
            staging.rename(dest)

        # Ensure any remaining pointer stubs are replaced with raw LFS content.
        materialize_lfs_pointers(
            dest,
            host,
            token,
            project_key,
            project_path,
            branch,
        )
        meta.write_text(commit, encoding="utf-8")
    else:
        # Cached tree may predate LFS fix; resolve any leftover pointers in place.
        materialize_lfs_pointers(
            dest,
            host,
            token,
            project_key,
            project_path,
            branch,
        )

    return {
        "host": host,
        "projectId": project_key,
        "projectPath": project_path,
        "projectName": project.get("name") or "",
        "branch": branch,
        "commit": commit,
        "extractPath": str(dest),
    }


def compare_gitlab_to_local(
    host: str, project_id: str, token: str, branch: str, local_path: str
) -> dict[str, Any]:
    extracted = extract_gitlab_branch(host, project_id, token, branch)
    result = compare_folders(extracted["extractPath"], local_path)
    result["mode"] = "git-local"
    result["leftPathResolved"] = extracted["extractPath"]
    result["rightPathResolved"] = str(Path(local_path).expanduser().resolve())
    result["git"] = {
        "host": extracted["host"],
        "projectId": extracted["projectId"],
        "projectPath": extracted["projectPath"],
        "projectName": extracted["projectName"],
        "branch": extracted["branch"],
        "commit": extracted["commit"],
    }
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "FolderCompare/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[folder-compare] {self.address_string()} - {fmt % args}")

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(200, {"ok": True})
            return

        rel = parsed.path if parsed.path != "/" else "/index.html"
        if ".." in rel:
            self._json(400, {"error": "Invalid path"})
            return

        file_path = STATIC / rel.lstrip("/")
        if not file_path.is_file():
            self._json(404, {"error": "Not found"})
            return

        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self._send(200, file_path.read_bytes(), content_type)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/select-folder":
                path = pick_folder()
                self._json(200, {"path": path})
                return

            data = self._read_json()

            if parsed.path == "/api/gitlab/auth":
                self._json(
                    200,
                    gitlab_authenticate(
                        data.get("host") or "",
                        data.get("projectId") or "",
                        data.get("token") or "",
                    ),
                )
                return

            if parsed.path == "/api/compare":
                mode = data.get("mode") or "local"
                if mode == "git-local":
                    result = compare_gitlab_to_local(
                        data.get("host") or "",
                        data.get("projectId") or "",
                        data.get("token") or "",
                        data.get("branch") or "",
                        data.get("rightPath") or data.get("localPath") or "",
                    )
                else:
                    result = compare_folders(data["leftPath"], data["rightPath"])
                    result["mode"] = "local"
                    result["leftPathResolved"] = str(
                        Path(data["leftPath"]).expanduser().resolve()
                    )
                    result["rightPathResolved"] = str(
                        Path(data["rightPath"]).expanduser().resolve()
                    )
                self._json(200, result)
                return

            if parsed.path == "/api/transfer":
                direction = data.get("direction")
                mode = data.get("mode") or "local"
                if mode == "git-local" and direction == "right-to-left":
                    raise ValueError(
                        "Cannot transfer into GitLab from here. "
                        "Use → to copy from the branch into the local folder."
                    )
                result = transfer_items(
                    data["leftPath"],
                    data["rightPath"],
                    direction,
                    data.get("relativePaths") or [],
                )
                result["comparison"]["mode"] = mode
                result["comparison"]["leftPathResolved"] = data["leftPath"]
                result["comparison"]["rightPathResolved"] = data["rightPath"]
                if data.get("git"):
                    result["comparison"]["git"] = data["git"]
                self._json(200, result)
                return

            if parsed.path == "/api/diff":
                result = read_text_diff(
                    data["leftPath"],
                    data["rightPath"],
                    data["relativePath"],
                )
                self._json(200, result)
                return

            self._json(404, {"error": "Unknown endpoint"})
        except Exception as exc:  # noqa: BLE001 - surface to UI
            self._json(400, {"error": str(exc)})


def main() -> None:
    os.chdir(ROOT)
    open_browser_flag = "--no-browser" not in sys.argv
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"Folder Compare running at {url}")
    print("Press Ctrl+C to stop.")

    if open_browser_flag:
        def open_browser() -> None:
            try:
                webbrowser.open(url)
            except Exception:
                pass

        threading.Timer(0.6, open_browser).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
