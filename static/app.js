const state = {
  mode: "local", // "local" | "git-local"
  leftPath: "",
  rightPath: "",
  gitlabHost: "https://gitlab.com",
  gitlabProjectId: "",
  gitlabToken: "",
  gitlabAuthenticated: false,
  gitlabProjectPath: "",
  branch: "",
  branches: [],
  leftResolvedPath: "",
  rightResolvedPath: "",
  git: null,
  result: null,
  leftSelected: new Set(),
  rightSelected: new Set(),
  // Shared across both trees so expand/collapse stays mirrored.
  expanded: new Set(),
  // Relative paths (files or folders) excluded from compare results.
  ignored: new Set(),
  busy: false,
  syncingScroll: false,
};

const STATUS_LABEL = {
  same: null,
  "missing-other": "only here",
  modified: "changed",
  partial: "has diffs",
  ghost: "only other",
  ignored: "ignored",
};

const els = {
  leftPath: document.getElementById("leftPath"),
  rightPath: document.getElementById("rightPath"),
  leftPathLabel: document.getElementById("leftPathLabel"),
  rightPathLabel: document.getElementById("rightPathLabel"),
  brandSubtitle: document.getElementById("brandSubtitle"),
  localLeftFields: document.getElementById("localLeftFields"),
  gitLeftFields: document.getElementById("gitLeftFields"),
  gitlabHost: document.getElementById("gitlabHost"),
  gitlabProjectId: document.getElementById("gitlabProjectId"),
  gitlabToken: document.getElementById("gitlabToken"),
  gitlabAuthBtn: document.getElementById("gitlabAuthBtn"),
  gitBranchRow: document.getElementById("gitBranchRow"),
  gitAuthMeta: document.getElementById("gitAuthMeta"),
  branchSelect: document.getElementById("branchSelect"),
  refreshBranches: document.getElementById("refreshBranches"),
  modeLocal: document.getElementById("modeLocal"),
  modeGit: document.getElementById("modeGit"),
  browseLeft: document.getElementById("browseLeft"),
  browseRight: document.getElementById("browseRight"),
  compareBtn: document.getElementById("compareBtn"),
  leftTree: document.getElementById("leftTree"),
  rightTree: document.getElementById("rightTree"),
  leftTitle: document.getElementById("leftTitle"),
  rightTitle: document.getElementById("rightTitle"),
  leftMeta: document.getElementById("leftMeta"),
  rightMeta: document.getElementById("rightMeta"),
  toRight: document.getElementById("toRight"),
  toLeft: document.getElementById("toLeft"),
  ignoreBtn: document.getElementById("ignoreBtn"),
  unignoreBtn: document.getElementById("unignoreBtn"),
  clearIgnoresBtn: document.getElementById("clearIgnoresBtn"),
  ignoreBar: document.getElementById("ignoreBar"),
  ignoreChips: document.getElementById("ignoreChips"),
  statusText: document.getElementById("statusText"),
  summaryPills: document.getElementById("summaryPills"),
  diffDrawer: document.getElementById("diffDrawer"),
  diffTitle: document.getElementById("diffTitle"),
  diffLeft: document.getElementById("diffLeft"),
  diffRight: document.getElementById("diffRight"),
  diffLeftLabel: document.getElementById("diffLeftLabel"),
  diffRightLabel: document.getElementById("diffRightLabel"),
  diffClose: document.getElementById("diffClose"),
};

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function basename(path) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path || "Folder";
}

function ignoreStorageKey() {
  if (state.mode === "git-local") {
    if (!state.gitlabProjectId || !state.rightPath) return null;
    return `folder-compare-ignore:git-local:${state.gitlabHost}::${state.gitlabProjectId}::${state.branch || ""}||${state.rightPath}`;
  }
  if (!state.leftPath || !state.rightPath) return null;
  return `folder-compare-ignore:local:${state.leftPath}||${state.rightPath}`;
}

function canCompare() {
  if (!state.rightPath) return false;
  if (state.mode === "git-local") {
    return !!(
      state.gitlabAuthenticated &&
      state.gitlabProjectId &&
      state.gitlabToken &&
      state.branch
    );
  }
  return !!state.leftPath;
}

function applyModeUI() {
  const isGit = state.mode === "git-local";
  els.modeLocal.classList.toggle("active", !isGit);
  els.modeGit.classList.toggle("active", isGit);
  els.modeLocal.setAttribute("aria-selected", String(!isGit));
  els.modeGit.setAttribute("aria-selected", String(isGit));
  els.localLeftFields.hidden = isGit;
  els.gitLeftFields.hidden = !isGit;
  els.gitBranchRow.hidden = !(isGit && state.gitlabAuthenticated);

  if (isGit) {
    els.rightPathLabel.textContent = "Local folder";
    els.rightPath.placeholder = "/path/to/local-folder";
    els.brandSubtitle.textContent =
      "Authenticate to GitLab, pick a branch, and compare it to a local folder.";
    els.toLeft.title = "Transfer into GitLab is not supported";
    els.leftTitle.textContent = state.gitlabProjectPath || "GitLab";
  } else {
    els.leftPathLabel.textContent = "Left folder";
    els.rightPathLabel.textContent = "Right folder";
    els.leftPath.placeholder = "/path/to/folder-a";
    els.rightPath.placeholder = "/path/to/folder-b";
    els.brandSubtitle.textContent =
      "Compare two folders, spot missing paths and content changes, then copy across.";
    els.toLeft.title = "Copy selected from right to left";
  }

  els.compareBtn.disabled = state.busy || !canCompare();
  updateActionButtons();
}

function resetGitlabAuthState() {
  state.gitlabAuthenticated = false;
  state.gitlabProjectPath = "";
  state.branch = "";
  state.branches = [];
  fillBranchSelect([], "", "");
  els.gitBranchRow.hidden = true;
  els.gitAuthMeta.hidden = true;
  els.gitAuthMeta.textContent = "";
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.result = null;
  state.leftSelected.clear();
  state.rightSelected.clear();
  state.leftResolvedPath = "";
  state.rightResolvedPath = "";
  state.git = null;
  if (mode !== "git-local") {
    resetGitlabAuthState();
  }
  loadIgnored();
  renderSummary(null);
  renderIgnoreBar();
  renderTrees();
  applyModeUI();
  setStatus(
    mode === "git-local"
      ? "Enter GitLab URL, project ID, and PAT, then Authenticate."
      : "Select two folders and click Compare."
  );
}

function fillBranchSelect(branches, current, preferred) {
  state.branches = branches || [];
  els.branchSelect.innerHTML = "";
  if (!state.branches.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = state.gitlabAuthenticated
      ? "No branches found"
      : "Authenticate to load branches";
    els.branchSelect.appendChild(opt);
    els.branchSelect.disabled = true;
    state.branch = "";
    return;
  }
  for (const name of state.branches) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name === current ? `${name} (default)` : name;
    els.branchSelect.appendChild(opt);
  }
  const pick =
    (preferred && state.branches.includes(preferred) && preferred) ||
    (current && state.branches.includes(current) && current) ||
    state.branches[0];
  els.branchSelect.value = pick;
  state.branch = pick;
  els.branchSelect.disabled = false;
}

async function authenticateGitlab() {
  state.gitlabHost = els.gitlabHost.value.trim() || "https://gitlab.com";
  state.gitlabProjectId = els.gitlabProjectId.value.trim();
  state.gitlabToken = els.gitlabToken.value.trim();
  els.gitlabHost.value = state.gitlabHost;
  els.gitlabProjectId.value = state.gitlabProjectId;

  if (!state.gitlabProjectId || !state.gitlabToken) {
    setStatus("Project ID and Personal Access Token are required.", true);
    return;
  }

  setBusy(true);
  setStatus("Authenticating with GitLab…");
  try {
    const data = await api("/api/gitlab/auth", {
      host: state.gitlabHost,
      projectId: state.gitlabProjectId,
      token: state.gitlabToken,
    });
    state.gitlabAuthenticated = true;
    state.gitlabProjectId = data.projectId || state.gitlabProjectId;
    state.gitlabProjectPath = data.projectPath || state.gitlabProjectId;
    state.gitlabHost = data.host || state.gitlabHost;
    els.gitlabProjectId.value = state.gitlabProjectId;
    els.gitlabHost.value = state.gitlabHost;
    fillBranchSelect(data.branches, data.defaultBranch, state.branch);
    els.gitBranchRow.hidden = false;
    els.gitAuthMeta.hidden = false;
    els.gitAuthMeta.textContent = `Signed in · ${state.gitlabProjectPath}`;
    els.leftTitle.textContent = state.gitlabProjectPath;
    loadIgnored();
    renderIgnoreBar();
    setStatus(
      `Authenticated. ${data.branches.length} branches loaded. Pick a branch and local folder, then Compare.`
    );
  } catch (err) {
    resetGitlabAuthState();
    applyModeUI();
    setStatus(err.message || String(err), true);
  } finally {
    setBusy(false);
  }
}

async function refreshGitlabBranches() {
  if (!state.gitlabProjectId || !state.gitlabToken) {
    setStatus("Authenticate with GitLab first.", true);
    return;
  }
  await authenticateGitlab();
}

function loadIgnored() {
  state.ignored = new Set();
  const key = ignoreStorageKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === "string" && item) state.ignored.add(item);
      }
    }
  } catch {
    state.ignored = new Set();
  }
}

function saveIgnored() {
  const key = ignoreStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify([...state.ignored].sort()));
}

function isIgnored(relPath) {
  if (!relPath) return false;
  for (const ign of state.ignored) {
    if (relPath === ign || relPath.startsWith(`${ign}/`)) return true;
  }
  return false;
}

function pruneIgnoredSet() {
  // Drop child ignores covered by a parent ignore entry.
  const sorted = [...state.ignored].sort((a, b) => a.length - b.length);
  const kept = new Set();
  for (const path of sorted) {
    let covered = false;
    for (const parent of kept) {
      if (path === parent || path.startsWith(`${parent}/`)) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.add(path);
  }
  state.ignored = kept;
}

function applyIgnoreOverlay(node) {
  if (!node) return null;
  const path = node.relativePath || "";
  const directlyIgnored = path ? isIgnored(path) : false;

  if (node.type === "file") {
    return {
      ...node,
      status: directlyIgnored ? "ignored" : node.status,
    };
  }

  const children = (node.children || [])
    .map((child) => applyIgnoreOverlay(child))
    .filter(Boolean);

  if (directlyIgnored) {
    return { ...node, status: "ignored", children };
  }

  const active = children.filter((c) => c.status !== "ignored");
  let status = node.status;
  if (path) {
    if (node.status === "missing-other") {
      status = "missing-other";
    } else if (
      active.some((c) =>
        ["missing-other", "modified", "ghost", "partial"].includes(c.status)
      )
    ) {
      status = "partial";
    } else if (active.length === 0 && children.length > 0) {
      status = "ignored";
    } else {
      status = "same";
    }
  } else {
    status = active.some((c) => c.status !== "same" && c.status !== "ignored")
      ? "partial"
      : "same";
  }

  return { ...node, status, children };
}

function collectFileStatuses(node, out = []) {
  if (!node) return out;
  if (node.type === "file" && node.relativePath) {
    out.push({ path: node.relativePath, status: node.status });
  }
  for (const child of node.children || []) collectFileStatuses(child, out);
  return out;
}

function computeEffectiveSummary(rawResult) {
  if (!rawResult?.leftTree) {
    return { same: 0, modified: 0, onlyLeft: 0, onlyRight: 0, ignored: 0, total: 0 };
  }
  const files = collectFileStatuses(rawResult.leftTree);
  let same = 0;
  let modified = 0;
  let onlyLeft = 0;
  let onlyRight = 0;
  let ignored = 0;

  for (const file of files) {
    if (isIgnored(file.path)) {
      ignored += 1;
      continue;
    }
    switch (file.status) {
      case "same":
        same += 1;
        break;
      case "modified":
        modified += 1;
        break;
      case "missing-other":
        onlyLeft += 1;
        break;
      case "ghost":
        onlyRight += 1;
        break;
      default:
        break;
    }
  }

  return {
    same,
    modified,
    onlyLeft,
    onlyRight,
    ignored,
    total: same + modified + onlyLeft + onlyRight,
  };
}

function getOverlayResult() {
  if (!state.result) return null;
  return {
    leftTree: applyIgnoreOverlay(state.result.leftTree),
    rightTree: applyIgnoreOverlay(state.result.rightTree),
    summary: computeEffectiveSummary(state.result),
  };
}

function allSelectedPaths() {
  return new Set([...state.leftSelected, ...state.rightSelected]);
}

function setBusy(busy) {
  state.busy = busy;
  els.compareBtn.disabled = busy || !canCompare();
  els.browseLeft.disabled = busy;
  els.browseRight.disabled = busy;
  els.gitlabAuthBtn.disabled = busy;
  els.refreshBranches.disabled =
    busy || state.mode !== "git-local" || !state.gitlabAuthenticated;
  els.branchSelect.disabled =
    busy ||
    state.mode !== "git-local" ||
    !state.gitlabAuthenticated ||
    state.branches.length === 0;
  els.modeLocal.disabled = busy;
  els.modeGit.disabled = busy;
  updateActionButtons();
}

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("error", isError);
}

function updateActionButtons() {
  const hasLeft = state.leftSelected.size > 0;
  const hasRight = state.rightSelected.size > 0;
  const selected = allSelectedPaths();
  const anyIgnored = [...selected].some((p) => isIgnored(p));
  const anyActive = [...selected].some((p) => !isIgnored(p));
  const gitMode = state.mode === "git-local";

  els.toRight.disabled = state.busy || !state.result || !hasLeft;
  els.toLeft.disabled = state.busy || !state.result || !hasRight || gitMode;
  els.ignoreBtn.disabled = state.busy || !state.result || !anyActive;
  els.unignoreBtn.disabled = state.busy || !anyIgnored;
}

function updateMeta() {
  els.leftMeta.textContent =
    state.leftSelected.size > 0
      ? `${state.leftSelected.size} selected`
      : "Click to select";
  els.rightMeta.textContent =
    state.rightSelected.size > 0
      ? `${state.rightSelected.size} selected`
      : "Click to select";
  updateActionButtons();
}

function renderSummary(summary) {
  if (!summary) {
    els.summaryPills.hidden = true;
    els.summaryPills.innerHTML = "";
    return;
  }
  els.summaryPills.hidden = false;
  const ignoredPill =
    summary.ignored > 0
      ? `<span class="pill ignored">Ignored <strong>${summary.ignored}</strong></span>`
      : "";
  els.summaryPills.innerHTML = `
    <span class="pill same">Same <strong>${summary.same}</strong></span>
    <span class="pill modified">Changed <strong>${summary.modified}</strong></span>
    <span class="pill missing">Only left <strong>${summary.onlyLeft}</strong></span>
    <span class="pill missing">Only right <strong>${summary.onlyRight}</strong></span>
    ${ignoredPill}
  `;
}

function renderIgnoreBar() {
  const paths = [...state.ignored].sort();
  if (paths.length === 0) {
    els.ignoreBar.hidden = true;
    els.ignoreChips.innerHTML = "";
    return;
  }
  els.ignoreBar.hidden = false;
  els.ignoreChips.innerHTML = "";
  for (const path of paths) {
    const chip = document.createElement("div");
    chip.className = "ignore-chip";
    const label = document.createElement("span");
    label.textContent = path;
    label.title = path;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Unignore ${path}`;
    remove.addEventListener("click", () => {
      state.ignored.delete(path);
      saveIgnored();
      refreshIgnoreView();
    });
    chip.append(label, remove);
    els.ignoreChips.appendChild(chip);
  }
}

function refreshIgnoreView() {
  const overlay = getOverlayResult();
  renderSummary(overlay?.summary || null);
  renderIgnoreBar();
  renderTrees();
  updateMeta();
  if (overlay?.summary) {
    const s = overlay.summary;
    const ignoredNote = s.ignored ? ` · ${s.ignored} ignored` : "";
    setStatus(
      `Compared ${s.total} files · ${s.same} same · ${s.modified} changed · ${s.onlyLeft} only left · ${s.onlyRight} only right${ignoredNote}`
    );
  }
}

function ignoreSelected() {
  const selected = allSelectedPaths();
  if (selected.size === 0) return;
  for (const path of selected) {
    if (!isIgnored(path)) state.ignored.add(path);
  }
  pruneIgnoredSet();
  state.leftSelected.clear();
  state.rightSelected.clear();
  saveIgnored();
  refreshIgnoreView();
}

function unignoreSelected() {
  const selected = allSelectedPaths();
  if (selected.size === 0) return;
  for (const path of [...state.ignored]) {
    for (const sel of selected) {
      // Remove ignore entry if it is the selection, under it, or covers it.
      if (path === sel || path.startsWith(`${sel}/`) || sel.startsWith(`${path}/`)) {
        state.ignored.delete(path);
        break;
      }
    }
  }
  pruneIgnoredSet();
  state.leftSelected.clear();
  state.rightSelected.clear();
  saveIgnored();
  refreshIgnoreView();
}

function clearAllIgnores() {
  state.ignored.clear();
  saveIgnored();
  refreshIgnoreView();
}

function collectPaths(node, out = []) {
  if (node.relativePath) out.push(node.relativePath);
  for (const child of node.children || []) collectPaths(child, out);
  return out;
}

function toggleSelect(side, node) {
  if (!node.relativePath) return;
  const selected = side === "left" ? state.leftSelected : state.rightSelected;
  const paths = collectPaths(node).filter(Boolean);
  const allSelected = paths.every((p) => selected.has(p));
  if (allSelected) paths.forEach((p) => selected.delete(p));
  else paths.forEach((p) => selected.add(p));
  renderTrees();
  updateMeta();
}

function nodeKey(node) {
  if (typeof node.relativePath === "string") {
    return node.relativePath === "" ? "__root__" : node.relativePath;
  }
  return node.name || "__root__";
}

function defaultExpanded(root) {
  const set = new Set();
  if (!root) return set;
  set.add(nodeKey(root));
  for (const child of root.children || []) {
    if (child.type === "dir") set.add(nodeKey(child));
  }
  return set;
}

function mergeDefaultExpanded(leftRoot, rightRoot) {
  const merged = defaultExpanded(leftRoot);
  for (const key of defaultExpanded(rightRoot)) merged.add(key);
  return merged;
}

function toggleExpand(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  renderTrees();
}

function syncScrollFrom(source, forcedTop) {
  const target = source === els.leftTree ? els.rightTree : els.leftTree;
  const top = forcedTop === undefined ? source.scrollTop : forcedTop;
  state.syncingScroll = true;
  source.scrollTop = top;
  target.scrollTop = top;
  const sourceMax = source.scrollHeight - source.clientHeight;
  const targetMax = target.scrollHeight - target.clientHeight;
  if (sourceMax > 0 && targetMax > 0 && Math.abs(sourceMax - targetMax) > 48) {
    const ratio = top / sourceMax;
    target.scrollTop = ratio * targetMax;
  }
  requestAnimationFrame(() => {
    state.syncingScroll = false;
  });
}

function bindScrollSync() {
  const onScroll = (event) => {
    if (state.syncingScroll) return;
    syncScrollFrom(event.currentTarget);
  };
  els.leftTree.addEventListener("scroll", onScroll, { passive: true });
  els.rightTree.addEventListener("scroll", onScroll, { passive: true });
}

function renderTree(container, root, side) {
  if (!root) {
    container.innerHTML =
      '<div class="tree-empty">Choose a folder path, then compare to see the tree.</div>';
    return;
  }

  const selected = side === "left" ? state.leftSelected : state.rightSelected;
  const frag = document.createDocumentFragment();

  function addNode(node, depth) {
    const key = nodeKey(node);
    const isDir = node.type === "dir";
    const isOpen = state.expanded.has(key);
    const isSelected = node.relativePath ? selected.has(node.relativePath) : false;
    const badge = STATUS_LABEL[node.status];
    const canSelect = !!node.relativePath;

    const row = document.createElement("div");
    row.className = `tree-row status-${node.status}${isSelected ? " selected" : ""}`;
    row.dataset.path = key;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title =
      node.type === "file" && node.status === "modified"
        ? "Double-click to inspect content"
        : node.relativePath || node.name;

    const twist = document.createElement(isDir ? "button" : "span");
    if (isDir) {
      twist.type = "button";
      twist.className = "twist";
      twist.textContent = isOpen ? "▾" : "▸";
      twist.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleExpand(key);
      });
    }

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = isDir ? "▣" : "·";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name || "(root)";

    const badgeEl = document.createElement("span");
    if (badge) {
      badgeEl.className = `badge ${node.status}`;
      badgeEl.textContent = badge;
    }

    row.append(twist, icon, name, badgeEl);

    row.addEventListener("click", (e) => {
      if (e.target.closest("button.twist") || !canSelect) return;
      toggleSelect(side, node);
    });

    row.addEventListener("dblclick", () => {
      if (isDir) {
        toggleExpand(key);
        return;
      }
      if (node.status === "modified") openDiff(node);
    });

    frag.appendChild(row);

    if (isDir && isOpen) {
      for (const child of node.children || []) addNode(child, depth + 1);
    }
  }

  addNode(root, 0);
  container.innerHTML = "";
  container.appendChild(frag);
}

function restoreScroll(top) {
  state.syncingScroll = true;
  els.leftTree.scrollTop = top;
  els.rightTree.scrollTop = top;
  requestAnimationFrame(() => {
    els.leftTree.scrollTop = top;
    els.rightTree.scrollTop = top;
    requestAnimationFrame(() => {
      state.syncingScroll = false;
    });
  });
}

function renderTrees() {
  const scrollTop = els.leftTree.scrollTop || els.rightTree.scrollTop;
  const overlay = getOverlayResult();
  renderTree(els.leftTree, overlay?.leftTree || null, "left");
  renderTree(els.rightTree, overlay?.rightTree || null, "right");
  restoreScroll(scrollTop);
}

async function browse(side) {
  if (side === "left" && state.mode === "git-local") return;
  setBusy(true);
  setStatus("Opening folder picker…");
  try {
    const data = await api("/api/select-folder", {});
    if (!data.path) {
      setStatus("Folder selection cancelled.");
      return;
    }
    if (side === "left") {
      state.leftPath = data.path;
      els.leftPath.value = data.path;
      els.leftTitle.textContent = basename(data.path);
    } else {
      state.rightPath = data.path;
      els.rightPath.value = data.path;
      els.rightTitle.textContent = basename(data.path);
    }
    state.result = null;
    state.leftResolvedPath = "";
    state.rightResolvedPath = "";
    state.git = null;
    state.leftSelected.clear();
    state.rightSelected.clear();
    loadIgnored();
    renderSummary(null);
    renderIgnoreBar();
    renderTrees();
    updateMeta();
    setStatus(
      state.mode === "git-local"
        ? "Local folder set. Authenticate, pick a branch, then Compare."
        : "Select both folders and click Compare."
    );
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    setBusy(false);
  }
}

async function compare() {
  state.rightPath = els.rightPath.value.trim();
  if (state.mode === "git-local") {
    state.gitlabHost = els.gitlabHost.value.trim() || "https://gitlab.com";
    state.gitlabProjectId = els.gitlabProjectId.value.trim();
    state.gitlabToken = els.gitlabToken.value.trim();
    state.branch = els.branchSelect.value.trim();
  } else {
    state.leftPath = els.leftPath.value.trim();
  }

  if (!canCompare()) {
    setStatus(
      state.mode === "git-local"
        ? "Authenticate, choose a branch, and a local folder first."
        : "Choose both left and right folders first.",
      true
    );
    return;
  }

  setBusy(true);
  setStatus(
    state.mode === "git-local"
      ? `Downloading GitLab branch ${state.branch} and comparing…`
      : "Comparing…"
  );
  try {
    loadIgnored();
    const payload =
      state.mode === "git-local"
        ? {
            mode: "git-local",
            host: state.gitlabHost,
            projectId: state.gitlabProjectId,
            token: state.gitlabToken,
            branch: state.branch,
            rightPath: state.rightPath,
          }
        : {
            mode: "local",
            leftPath: state.leftPath,
            rightPath: state.rightPath,
          };
    const result = await api("/api/compare", payload);
    state.result = result;
    state.leftResolvedPath = result.leftPathResolved || state.leftPath;
    state.rightResolvedPath = result.rightPathResolved || state.rightPath;
    state.git = result.git || null;
    if (result.git?.projectId) {
      state.gitlabProjectId = result.git.projectId;
      state.gitlabProjectPath = result.git.projectPath || state.gitlabProjectPath;
      els.gitlabProjectId.value = state.gitlabProjectId;
    }
    state.leftSelected.clear();
    state.rightSelected.clear();
    state.expanded = mergeDefaultExpanded(result.leftTree, result.rightTree);
    if (state.mode === "git-local") {
      const short = (result.git?.commit || "").slice(0, 7);
      const label = result.git?.projectPath || state.gitlabProjectPath || "GitLab";
      els.leftTitle.textContent = `${label} · ${result.git?.branch || state.branch}${
        short ? ` @ ${short}` : ""
      }`;
    } else {
      els.leftTitle.textContent = basename(state.leftPath);
    }
    els.rightTitle.textContent = basename(state.rightPath);
    refreshIgnoreView();
    closeDiff();
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    setBusy(false);
  }
}

async function transfer(direction) {
  if (state.mode === "git-local" && direction === "right-to-left") {
    setStatus(
      "Cannot transfer into GitLab. Use → to copy from the branch into the local folder.",
      true
    );
    return;
  }

  const selected =
    direction === "left-to-right" ? state.leftSelected : state.rightSelected;
  const relativePaths = [...selected].filter((p) => !isIgnored(p));
  if (relativePaths.length === 0) {
    setStatus(
      selected.size > 0
        ? "Selected items are ignored. Unignore them first, or pick other files."
        : direction === "left-to-right"
          ? "Select items in the left tree to copy to the right."
          : "Select items in the right tree to copy to the left.",
      true
    );
    return;
  }

  const leftPath = state.leftResolvedPath || state.leftPath;
  const rightPath = state.rightResolvedPath || state.rightPath;

  setBusy(true);
  setStatus(
    direction === "left-to-right" ? "Copying left → right…" : "Copying right → left…"
  );
  try {
    const scrollTop = els.leftTree.scrollTop || els.rightTree.scrollTop;
    const response = await api("/api/transfer", {
      mode: state.mode,
      leftPath,
      rightPath,
      direction,
      relativePaths,
      git: state.git,
    });
    state.result = response.comparison;
    state.leftResolvedPath =
      response.comparison.leftPathResolved || state.leftResolvedPath;
    state.rightResolvedPath =
      response.comparison.rightPathResolved || state.rightResolvedPath;
    state.git = response.comparison.git || state.git;
    state.leftSelected.clear();
    state.rightSelected.clear();
    const overlay = getOverlayResult();
    renderSummary(overlay?.summary || null);
    renderIgnoreBar();
    renderTree(els.leftTree, overlay?.leftTree || null, "left");
    renderTree(els.rightTree, overlay?.rightTree || null, "right");
    restoreScroll(scrollTop);
    updateMeta();
    closeDiff();

    const failed = response.results.filter((r) => !r.ok);
    if (failed.length) {
      setStatus(
        `Transferred with ${failed.length} error(s): ${failed
          .map((f) => f.relativePath)
          .join(", ")}`,
        true
      );
    } else {
      const s = overlay.summary;
      const ignoredNote = s.ignored ? ` · ${s.ignored} ignored` : "";
      setStatus(
        `Transfer done · ${s.same} same · ${s.modified} changed · ${s.onlyLeft} only left · ${s.onlyRight} only right${ignoredNote}`
      );
    }
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    setBusy(false);
  }
}

function sideText(side) {
  if (!side.exists) return { text: "(missing on this side)", muted: true, size: 0 };
  if (side.binary)
    return {
      text: `(binary file, ${side.size.toLocaleString()} bytes)`,
      muted: true,
      size: side.size,
    };
  if (!side.text) return { text: "(empty)", muted: true, size: side.size };
  return {
    text: side.text + (side.truncated ? "\n\n… truncated for preview" : ""),
    muted: false,
    size: side.size,
  };
}

async function openDiff(node) {
  if (isIgnored(node.relativePath)) {
    setStatus("This path is ignored. Unignore it to inspect differences.", true);
    return;
  }
  setBusy(true);
  try {
    const diff = await api("/api/diff", {
      leftPath: state.leftResolvedPath || state.leftPath,
      rightPath: state.rightResolvedPath || state.rightPath,
      relativePath: node.relativePath,
    });
    const left = sideText(diff.left);
    const right = sideText(diff.right);
    els.diffTitle.textContent = diff.relativePath;
    els.diffLeftLabel.textContent = left.size
      ? `Left · ${left.size.toLocaleString()} bytes`
      : "Left";
    els.diffRightLabel.textContent = right.size
      ? `Right · ${right.size.toLocaleString()} bytes`
      : "Right";
    els.diffLeft.textContent = left.text;
    els.diffRight.textContent = right.text;
    els.diffLeft.classList.toggle("muted", left.muted);
    els.diffRight.classList.toggle("muted", right.muted);
    els.diffDrawer.hidden = false;
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    setBusy(false);
  }
}

function closeDiff() {
  els.diffDrawer.hidden = true;
}

els.modeLocal.addEventListener("click", () => setMode("local"));
els.modeGit.addEventListener("click", () => setMode("git-local"));
els.gitlabAuthBtn.addEventListener("click", () => authenticateGitlab());
els.refreshBranches.addEventListener("click", () => refreshGitlabBranches());
els.branchSelect.addEventListener("change", () => {
  state.branch = els.branchSelect.value;
  state.result = null;
  loadIgnored();
  renderSummary(null);
  renderIgnoreBar();
  renderTrees();
  els.compareBtn.disabled = state.busy || !canCompare();
  setStatus("Branch changed — click Compare to refresh.");
});

function invalidateGitlabAuth() {
  if (!state.gitlabAuthenticated) return;
  resetGitlabAuthState();
  applyModeUI();
  state.result = null;
  renderSummary(null);
  renderTrees();
  setStatus("GitLab credentials changed — authenticate again.");
}

els.gitlabHost.addEventListener("input", invalidateGitlabAuth);
els.gitlabProjectId.addEventListener("input", invalidateGitlabAuth);
els.gitlabToken.addEventListener("input", invalidateGitlabAuth);

els.browseLeft.addEventListener("click", () => browse("left"));
els.browseRight.addEventListener("click", () => browse("right"));
els.compareBtn.addEventListener("click", compare);
els.toRight.addEventListener("click", () => transfer("left-to-right"));
els.toLeft.addEventListener("click", () => transfer("right-to-left"));
els.ignoreBtn.addEventListener("click", ignoreSelected);
els.unignoreBtn.addEventListener("click", unignoreSelected);
els.clearIgnoresBtn.addEventListener("click", clearAllIgnores);
els.diffClose.addEventListener("click", closeDiff);

els.leftPath.addEventListener("input", () => {
  state.leftPath = els.leftPath.value.trim();
  state.result = null;
  els.compareBtn.disabled = state.busy || !canCompare();
});

els.rightPath.addEventListener("input", () => {
  state.rightPath = els.rightPath.value.trim();
  state.result = null;
  state.rightResolvedPath = "";
  loadIgnored();
  renderSummary(null);
  renderIgnoreBar();
  renderTrees();
  els.compareBtn.disabled = state.busy || !canCompare();
  updateActionButtons();
});

els.compareBtn.disabled = true;
bindScrollSync();
applyModeUI();
updateMeta();
renderIgnoreBar();
