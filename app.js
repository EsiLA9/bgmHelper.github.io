import { Archive } from "./vendor/libarchive/libarchive.js";

const DEFAULT_CSV_PATH = "bgm小工具的映射表 20260326.csv";
const BASE_URL = "https://seminar.kivo.wiki/music/update/";
const TEXT_EXTENSIONS = [".md", ".txt"];
const ARCHIVE_EXTENSIONS = [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"];

const state = {
  csvMapping: new Map(),
  files: new Map(),
  orderedFiles: [],
  currentFile: null,
  clickedFiles: new Set(),
};

const elements = {
  csvInput: document.getElementById("csvInput"),
  folderInput: document.getElementById("folderInput"),
  fileInput: document.getElementById("fileInput"),
  archiveInput: document.getElementById("archiveInput"),
  reloadDefaultCsvButton: document.getElementById("reloadDefaultCsvButton"),
  searchInput: document.getElementById("searchInput"),
  statusText: document.getElementById("statusText"),
  fileList: document.getElementById("fileList"),
  preview: document.getElementById("preview"),
  targetUrl: document.getElementById("targetUrl"),
  sourceLabel: document.getElementById("sourceLabel"),
  databaseIdLabel: document.getElementById("databaseIdLabel"),
  detailTitle: document.getElementById("detailTitle"),
  mappingBadge: document.getElementById("mappingBadge"),
  mappingCount: document.getElementById("mappingCount"),
  fileCount: document.getElementById("fileCount"),
  currentFileLabel: document.getElementById("currentFileLabel"),
  visibleCount: document.getElementById("visibleCount"),
  copyButton: document.getElementById("copyButton"),
  openButton: document.getElementById("openButton"),
  markButton: document.getElementById("markButton"),
};

boot();

async function boot() {
  Archive.init({ workerUrl: new URL("./vendor/libarchive/worker-bundle.js", import.meta.url) });
  bindEvents();
  await loadDefaultCsv();
  renderFileList();
  updateDetail();
}

function bindEvents() {
  elements.reloadDefaultCsvButton.addEventListener("click", () => {
    void loadDefaultCsv();
  });

  elements.csvInput.addEventListener("change", async (event) => {
    const [file] = event.target.files ?? [];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      applyCsvMapping(text);
      setStatus(`已加载自定义 CSV: ${file.name}`);
      renderFileList();
      updateDetail();
    } catch (error) {
      setStatus(`CSV 加载失败: ${error.message}`);
    } finally {
      elements.csvInput.value = "";
    }
  });

  const fileImportHandler = async (event) => {
    const fileList = Array.from(event.target.files ?? []);
    if (!fileList.length) {
      return;
    }

    await importTextFiles(fileList);
    event.target.value = "";
  };

  elements.folderInput.addEventListener("change", fileImportHandler);
  elements.fileInput.addEventListener("change", fileImportHandler);
  elements.archiveInput.addEventListener("change", async (event) => {
    const archiveFiles = Array.from(event.target.files ?? []);
    if (!archiveFiles.length) {
      return;
    }

    try {
      await importArchiveFiles(archiveFiles);
    } finally {
      event.target.value = "";
    }
  });
  elements.searchInput.addEventListener("input", renderFileList);

  elements.copyButton.addEventListener("click", async () => {
    if (!state.currentFile) {
      setStatus("还没有选中文件，暂时无法复制。");
      return;
    }

    const file = state.files.get(state.currentFile);
    try {
      await copyToClipboard(normalizeLineEndings(file.rawContent));
      setStatus(`已复制 ${state.currentFile} 的内容。`);
      markCurrentFileDone();
      renderFileList();
    } catch (error) {
      setStatus(`复制失败，请允许浏览器访问剪贴板后重试。原因: ${error.message}`);
    }
  });

  elements.openButton.addEventListener("click", () => {
    const href = elements.targetUrl.getAttribute("href");
    if (!href || href === "#") {
      setStatus("当前文件还没有可打开的目标 URL。");
      return;
    }

    window.open(href, "_blank", "noopener,noreferrer");
    markCurrentFileDone();
    renderFileList();
    setStatus(`已打开 ${state.currentFile} 对应的页面。`);
  });

  elements.markButton.addEventListener("click", () => {
    markCurrentFileDone();
    renderFileList();
    setStatus(`已标记 ${state.currentFile ?? "当前条目"} 为已处理。`);
  });
}

async function loadDefaultCsv() {
  try {
    const response = await fetch(encodeURI(DEFAULT_CSV_PATH), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    applyCsvMapping(await response.text());
    setStatus(`已加载仓库内默认映射表: ${DEFAULT_CSV_PATH}`);
    renderFileList();
    updateDetail();
  } catch (error) {
    setStatus(`默认 CSV 加载失败，请手动上传。原因: ${error.message}`);
  }
}

function applyCsvMapping(csvText) {
  const rows = parseCsv(csvText);
  const nextMapping = new Map();

  rows.forEach((row) => {
    const devCode = `${row.dev_code ?? ""}`.trim();
    const databaseId = `${row.database_id ?? ""}`.trim();
    if (devCode) {
      nextMapping.set(devCode, databaseId);
    }
  });

  state.csvMapping = nextMapping;
  elements.mappingCount.textContent = `${state.csvMapping.size}`;
}

async function importTextFiles(fileList) {
  const importedEntries = [];

  for (const file of fileList) {
    const fileName = file.name ?? "";
    const lowerName = fileName.toLowerCase();
    if (!TEXT_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
      continue;
    }

    const rawBytes = await file.arrayBuffer();
    const content = decodeText(rawBytes);
    const relativePath = file.webkitRelativePath || file.name;

    importedEntries.push(createImportedEntry({
      source: relativePath,
      entryPath: relativePath,
      content,
    }));
  }

  mergeImportedEntries(importedEntries);
  setStatus(`已导入 ${importedEntries.length} 个文本文件。`);
}

async function importArchiveFiles(archiveFiles) {
  const importedEntries = [];
  let archiveCount = 0;

  for (const archiveFile of archiveFiles) {
    const archiveName = archiveFile.name ?? "";
    const lowerName = archiveName.toLowerCase();
    if (!ARCHIVE_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
      continue;
    }

    archiveCount += 1;
    setStatus(`正在读取压缩包: ${archiveName}`);

    let archive;
    try {
      archive = await Archive.open(archiveFile);
      if (await archive.hasEncryptedData()) {
        throw new Error("暂不支持带密码的压缩包");
      }

      const files = await archive.getFilesArray();
      for (const entry of files) {
        const archiveEntryPath = buildArchiveEntryPath(entry);
        if (!entry.file || !isSupportedTextFile(archiveEntryPath)) {
          continue;
        }

        const extractedFile = typeof entry.file.extract === "function"
          ? await entry.file.extract()
          : entry.file;
        const content = decodeText(await extractedFile.arrayBuffer());
        importedEntries.push(createImportedEntry({
          source: `${archiveName}:${archiveEntryPath}`,
          entryPath: archiveEntryPath,
          content,
        }));
      }
    } catch (error) {
      setStatus(`压缩包 ${archiveName} 读取失败: ${error.message}`);
    } finally {
      await archive?.close();
    }
  }

  mergeImportedEntries(importedEntries);
  setStatus(`已读取 ${archiveCount} 个压缩包，提取 ${importedEntries.length} 个文本文件。`);
}

function mergeImportedEntries(entries) {
  for (const entry of entries) {
    state.files.set(entry.key, entry);
  }

  state.currentFile = state.currentFile && state.files.has(state.currentFile)
    ? state.currentFile
    : state.files.keys().next().value ?? null;

  elements.fileCount.textContent = `${state.files.size}`;
  renderFileList();
  updateDetail();
}

function renderFileList() {
  const keyword = elements.searchInput.value.trim().toLowerCase();
  const items = Array.from(state.files.values())
    .filter((item) => item.key.toLowerCase().includes(keyword))
    .sort(compareFiles);

  state.orderedFiles = items.map((item) => item.key);
  elements.visibleCount.textContent = `${items.length} 项`;
  elements.fileCount.textContent = `${state.files.size}`;

  if (!items.length) {
    elements.fileList.innerHTML = "<li class=\"file-item\"><span class=\"file-name\">没有匹配的文件</span><span class=\"file-source\">试试修改搜索词，或者重新导入文本文件。</span></li>";
    if (state.currentFile && !state.files.has(state.currentFile)) {
      state.currentFile = null;
    }
    updateDetail();
    return;
  }

  if (!state.currentFile || !items.some((item) => item.key === state.currentFile)) {
    state.currentFile = items[0].key;
  }

  elements.fileList.innerHTML = "";

  items.forEach((item) => {
    const databaseId = state.csvMapping.get(item.key);
    const button = document.createElement("li");
    button.className = [
      "file-item",
      item.key === state.currentFile ? "active" : "",
      state.clickedFiles.has(item.key) ? "done" : "",
    ].filter(Boolean).join(" ");
    button.tabIndex = 0;
    button.innerHTML = `
      <div class="file-item-top">
        <span class="file-name">${escapeHtml(item.key)}</span>
        <span class="file-status ${databaseId ? "matched" : ""}">${databaseId ? `ID ${escapeHtml(databaseId)}` : "未映射"}</span>
      </div>
      <span class="file-source">${escapeHtml(item.source)}</span>
    `;

    button.addEventListener("click", () => {
      state.currentFile = item.key;
      updateDetail();
      renderFileList();
    });

    button.addEventListener("dblclick", async () => {
      state.currentFile = item.key;
      updateDetail();
      renderFileList();
      await handleDoubleAction();
    });

    button.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.currentFile = item.key;
        updateDetail();
        renderFileList();
      }
    });

    elements.fileList.appendChild(button);
  });

  updateDetail();
}

function updateDetail() {
  const selected = state.currentFile ? state.files.get(state.currentFile) : null;
  elements.currentFileLabel.textContent = state.currentFile ?? "未选择";

  if (!selected) {
    elements.detailTitle.textContent = "文件预览";
  elements.preview.textContent = "请先加载 CSV 和歌词文件。";
  elements.sourceLabel.textContent = "未加载";
  elements.sourceLabel.title = "未加载";
  elements.databaseIdLabel.textContent = "-";
  elements.databaseIdLabel.title = "-";
  elements.mappingBadge.textContent = "未匹配";
  elements.mappingBadge.className = "panel-meta neutral";
  elements.targetUrl.textContent = "尚未生成";
    elements.targetUrl.href = "#";
    return;
  }

  const databaseId = state.csvMapping.get(selected.key) || "";
  const targetUrl = databaseId ? `${BASE_URL}${databaseId}` : "#";

  elements.detailTitle.textContent = `${selected.key}.md`;
  elements.preview.textContent = selected.content;
  elements.sourceLabel.textContent = selected.source;
  elements.sourceLabel.title = selected.source;
  elements.databaseIdLabel.textContent = databaseId || "-";
  elements.databaseIdLabel.title = databaseId || "-";
  elements.targetUrl.textContent = databaseId ? targetUrl : "当前文件没有匹配到 database_id";
  elements.targetUrl.href = targetUrl;
  elements.mappingBadge.textContent = databaseId ? "已匹配映射" : "未匹配";
  elements.mappingBadge.className = `panel-meta ${databaseId ? "" : "neutral"}`.trim();
}

async function handleDoubleAction() {
  const href = elements.targetUrl.getAttribute("href");
  if (href && href !== "#") {
    window.open(href, "_blank", "noopener,noreferrer");
  }

  if (state.currentFile) {
    const file = state.files.get(state.currentFile);
    await copyToClipboard(normalizeLineEndings(file.rawContent));
    markCurrentFileDone();
    renderFileList();
    setStatus(`已处理 ${state.currentFile}，内容已复制${href && href !== "#" ? "并打开目标页" : ""}。`);
  }
}

function markCurrentFileDone() {
  if (state.currentFile) {
    state.clickedFiles.add(state.currentFile);
  }
}

function compareFiles(left, right) {
  const leftId = parseSortId(state.csvMapping.get(left.key));
  const rightId = parseSortId(state.csvMapping.get(right.key));

  if (leftId !== rightId) {
    return leftId - rightId;
  }

  return left.key.localeCompare(right.key, "zh-CN", { numeric: true, sensitivity: "base" });
}

function parseSortId(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}

function createImportedEntry({ source, entryPath, content }) {
  const normalizedSource = normalizeArchivePath(source);
  const normalizedEntryPath = normalizeArchivePath(entryPath);
  const fileName = normalizedEntryPath.split("/").pop() ?? normalizedEntryPath;
  const key = stripExtension(fileName);

  return {
    key,
    source: normalizedSource,
    rawContent: content,
    content,
  };
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}

function isSupportedTextFile(path) {
  const lowerPath = path.toLowerCase();
  return TEXT_EXTENSIONS.some((extension) => lowerPath.endsWith(extension));
}

function normalizeArchivePath(path) {
  return path.replaceAll("\\", "/");
}

function buildArchiveEntryPath(entry) {
  const basePath = normalizeArchivePath(entry.path || "");
  const fileName = entry.file?.name || "";
  if (!basePath) {
    return fileName;
  }
  return `${basePath.endsWith("/") ? basePath : `${basePath}/`}${fileName}`;
}

function decodeText(buffer) {
  const encodings = ["utf-8", "gb18030", "gbk", "big5", "windows-1252"];
  for (const encoding of encodings) {
    try {
      const decoder = new TextDecoder(encoding, { fatal: true });
      return decoder.decode(buffer);
    } catch (error) {
      continue;
    }
  }

  return new TextDecoder().decode(buffer);
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    document.execCommand("copy");
  } finally {
    textArea.remove();
  }
}

function parseCsv(text) {
  const rows = [];
  let currentField = "";
  let currentRow = [];
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === "\"") {
      if (insideQuotes && nextChar === "\"") {
        currentField += "\"";
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === "," && !insideQuotes) {
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      currentRow.push(currentField);
      currentField = "";
      if (currentRow.some((field) => field.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    currentField += char;
  }

  currentRow.push(currentField);
  if (currentRow.some((field) => field.length > 0)) {
    rows.push(currentRow);
  }

  if (!rows.length) {
    return [];
  }

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function escapeHtml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
