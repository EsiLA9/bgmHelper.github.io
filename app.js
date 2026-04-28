import { Archive } from "./vendor/libarchive/libarchive.js";

const DEFAULT_MAPPING_CSV_PATH = "bgm小工具的映射表 20260421.csv";
const DEFAULT_INTRODUCTION_CSV_PATH = "introduction.csv";
const UPDATE_PAGE_BASE_URL = "https://seminar.kivo.wiki/music/update/";
const TEXT_EXTENSIONS = [".md", ".txt"];
const ARCHIVE_EXTENSIONS = [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"];

const state = {
  csvMapping: new Map(),
  introductionMapping: new Map(),
  files: new Map(),
  orderedFiles: [],
  currentFile: null,
  clickedFiles: new Set(),
  introductionCsvLoaded: false,
};

const elements = {
  csvInput: document.getElementById("csvInput"),
  introFixCsvInput: document.getElementById("introFixCsvInput"),
  folderInput: document.getElementById("folderInput"),
  fileInput: document.getElementById("fileInput"),
  archiveInput: document.getElementById("archiveInput"),
  reloadDefaultCsvButton: document.getElementById("reloadDefaultCsvButton"),
  searchInput: document.getElementById("searchInput"),
  statusText: document.getElementById("statusText"),
  fileList: document.getElementById("fileList"),
  preview: document.getElementById("preview"),
  stitchStatus: document.getElementById("stitchStatus"),
  sourceLabel: document.getElementById("sourceLabel"),
  databaseIdLabel: document.getElementById("databaseIdLabel"),
  introductionStatusLabel: document.getElementById("introductionStatusLabel"),
  detailTitle: document.getElementById("detailTitle"),
  mappingBadge: document.getElementById("mappingBadge"),
  mappingCount: document.getElementById("mappingCount"),
  fileCount: document.getElementById("fileCount"),
  currentFileLabel: document.getElementById("currentFileLabel"),
  visibleCount: document.getElementById("visibleCount"),
  copyButton: document.getElementById("copyButton"),
  markButton: document.getElementById("markButton"),
};

boot();

async function boot() {
  Archive.init({ workerUrl: new URL("./vendor/libarchive/worker-bundle.js", import.meta.url) });
  bindEvents();
  await loadDefaultData();
  renderFileList();
  updateDetail();
}

function bindEvents() {
  elements.reloadDefaultCsvButton.addEventListener("click", () => {
    void loadDefaultData();
  });

  elements.csvInput.addEventListener("change", async (event) => {
    const [file] = event.target.files ?? [];
    if (!file) {
      return;
    }

    try {
      const text = decodeText(await file.arrayBuffer());
      applyCsvMapping(text);
      setStatus(`已加载自定义映射表: ${file.name}`);
      renderFileList();
      updateDetail();
    } catch (error) {
      setStatus(`映射表加载失败: ${error.message}`);
    } finally {
      elements.csvInput.value = "";
    }
  });

  elements.introFixCsvInput.addEventListener("change", async (event) => {
    const [file] = event.target.files ?? [];
    if (!file) {
      return;
    }

    try {
      const text = decodeText(await file.arrayBuffer());
      importIntroductionFixCsv(text, file.name);
    } catch (error) {
      setStatus(`修复 CSV 加载失败: ${error.message}`);
    } finally {
      elements.introFixCsvInput.value = "";
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
      await copyToClipboard(getClipboardContent(file));
      if (file.kind === "introduction-fix") {
        setStatus(`已复制 ${getEntryDisplayName(file)} 的修复简介。`);
      } else {
        setStatus(`已复制 ${getEntryDisplayName(file)} 的内容${hasPreparedIntroduction(file) ? "，并自动拼接简介。" : "。"}`);
      }
      markCurrentFileDone();
      renderFileList();
    } catch (error) {
      setStatus(`复制失败，请允许浏览器访问剪贴板后重试。原因: ${error.message}`);
    }
  });

  elements.markButton.addEventListener("click", () => {
    markCurrentFileDone();
    renderFileList();
    setStatus(`已标记 ${state.currentFile ?? "当前条目"} 为已处理。`);
  });
}

async function loadDefaultData() {
  const messages = [];

  try {
    await loadDefaultMappingCsv();
    messages.push(`映射表 ${DEFAULT_MAPPING_CSV_PATH}`);
  } catch (error) {
    setStatus(`默认映射表加载失败，请手动上传。原因: ${error.message}`);
    renderFileList();
    updateDetail();
    return;
  }

  try {
    await loadDefaultIntroductionCsv();
    messages.push(`简介缓存 ${DEFAULT_INTRODUCTION_CSV_PATH}`);
  } catch (error) {
    messages.push(`简介缓存未加载 (${error.message})`);
  }

  renderFileList();
  updateDetail();
  setStatus(`已加载 ${messages.join("，")}。`);
}

async function loadDefaultMappingCsv() {
  const response = await fetch(encodeURI(DEFAULT_MAPPING_CSV_PATH), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  applyCsvMapping(await response.text());
}

async function loadDefaultIntroductionCsv() {
  const response = await fetch(encodeURI(DEFAULT_INTRODUCTION_CSV_PATH), { cache: "no-store" });
  if (!response.ok) {
    state.introductionMapping = new Map();
    state.introductionCsvLoaded = false;
    throw new Error(`HTTP ${response.status}`);
  }

  applyIntroductionMapping(await response.text());
}

function applyCsvMapping(csvText) {
  const rows = parseTable(csvText);
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

function applyIntroductionMapping(csvText) {
  const rows = parseTable(csvText);
  const nextMapping = new Map();

  rows.forEach((row) => {
    const databaseId = `${row.database_id ?? ""}`.trim();
    if (!databaseId) {
      return;
    }

    nextMapping.set(databaseId, {
      databaseId,
      devCode: `${row.dev_code ?? ""}`.trim(),
      mappingTitle: `${row.mapping_title ?? ""}`.trim(),
      apiTitle: `${row.api_title ?? ""}`.trim(),
      introduction: normalizeLineEndings(`${row.introduction ?? ""}`).trim(),
      status: `${row.status ?? ""}`.trim().toLowerCase(),
      error: normalizeLineEndings(`${row.error ?? ""}`).trim(),
    });
  });

  state.introductionMapping = nextMapping;
  state.introductionCsvLoaded = true;
}

function importIntroductionFixCsv(csvText, sourceName) {
  const rows = parseTable(csvText);
  const importedEntries = [];

  rows.forEach((row, index) => {
    const databaseId = `${row.id ?? row.database_id ?? row.ID ?? row.DatabaseId ?? ""}`.trim();
    const introduction = normalizeLineEndings(
      `${row.introduction ?? row.Introduction ?? row.introductionFixed ?? row.introduction_fixed ?? ""}`
    ).trim();

    if (!databaseId) {
      return;
    }

    importedEntries.push(createIntroductionFixEntry({
      databaseId,
      introduction,
      sourceName,
      rowIndex: index,
    }));
  });

  mergeImportedEntries(importedEntries);
  setStatus(`已导入 ${importedEntries.length} 条修复简介记录。`);
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
    .filter((item) => getEntrySearchText(item).includes(keyword))
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
    const databaseId = getEntryDatabaseId(item);
    const introductionStatus = getIntroductionStatus(item);
    const button = document.createElement("li");
    button.className = [
      "file-item",
      item.key === state.currentFile ? "active" : "",
      state.clickedFiles.has(item.key) ? "done" : "",
    ].filter(Boolean).join(" ");
    button.tabIndex = 0;
    button.innerHTML = `
      <div class="file-item-top">
        <span class="file-name">${escapeHtml(getEntryDisplayName(item))}</span>
        <span class="file-status ${databaseId ? "matched" : ""}">${databaseId ? `ID ${escapeHtml(databaseId)}` : "未映射"}</span>
      </div>
      <div class="file-meta-row">
        <span class="file-source">${escapeHtml(item.source)}</span>
        <span class="intro-status ${introductionStatus.tone}" title="${escapeHtml(introductionStatus.detail)}">${escapeHtml(introductionStatus.label)}</span>
      </div>
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
  elements.currentFileLabel.textContent = selected ? getEntryDisplayName(selected) : "未选择";

  if (!selected) {
    elements.detailTitle.textContent = "文件预览";
    elements.preview.textContent = "请先加载映射表、简介缓存和歌词文件。";
    elements.sourceLabel.textContent = "未加载";
    elements.sourceLabel.title = "未加载";
    elements.databaseIdLabel.textContent = "-";
    elements.databaseIdLabel.title = "-";
    elements.introductionStatusLabel.textContent = "未拼接";
    elements.introductionStatusLabel.title = "尚未载入任何文件。";
    elements.mappingBadge.textContent = "未匹配";
    elements.mappingBadge.title = "当前文件还没有匹配到 database_id。";
    elements.mappingBadge.className = "panel-meta neutral";
    elements.stitchStatus.textContent = "尚未生成";
    elements.stitchStatus.title = "尚未生成";
    return;
  }

  const databaseId = getEntryDatabaseId(selected);
  const introductionStatus = getIntroductionStatus(selected);

  elements.detailTitle.textContent = selected.kind === "introduction-fix"
    ? `${getEntryDisplayName(selected)} / ID ${databaseId || "-"}`
    : `${getEntryDisplayName(selected)}.md`;
  elements.preview.textContent = buildPreparedContent(selected);
  elements.sourceLabel.textContent = selected.source;
  elements.sourceLabel.title = selected.source;
  elements.databaseIdLabel.textContent = databaseId || "-";
  elements.databaseIdLabel.title = databaseId || "-";
  elements.introductionStatusLabel.textContent = introductionStatus.label;
  elements.introductionStatusLabel.title = introductionStatus.detail;
  elements.stitchStatus.textContent = introductionStatus.stitchText;
  elements.stitchStatus.title = introductionStatus.detail;
  elements.mappingBadge.textContent = introductionStatus.badgeText;
  elements.mappingBadge.title = introductionStatus.detail;
  elements.mappingBadge.className = `panel-meta ${introductionStatus.badgeTone}`.trim();
}

async function handleDoubleAction() {
  if (!state.currentFile) {
    return;
  }

  const file = state.files.get(state.currentFile);
  const databaseId = getEntryDatabaseId(file);
  const updatePageUrl = databaseId ? `${UPDATE_PAGE_BASE_URL}${databaseId}` : "";

  if (updatePageUrl) {
    window.open(updatePageUrl, "_blank", "noopener,noreferrer");
  }

  await copyToClipboard(getClipboardContent(file));
  markCurrentFileDone();
  renderFileList();
  const copiedText = file.kind === "introduction-fix"
    ? "修复简介已复制"
    : `内容已复制${hasPreparedIntroduction(file) ? "并拼接简介" : ""}`;
  setStatus(`已处理 ${getEntryDisplayName(file)}，${copiedText}${updatePageUrl ? "，并打开编辑页" : ""}。`);
}

function markCurrentFileDone() {
  if (state.currentFile) {
    state.clickedFiles.add(state.currentFile);
  }
}

function compareFiles(left, right) {
  const leftId = parseSortId(getEntryDatabaseId(left));
  const rightId = parseSortId(getEntryDatabaseId(right));

  if (leftId !== rightId) {
    return leftId - rightId;
  }

  return getEntryDisplayName(left).localeCompare(getEntryDisplayName(right), "zh-CN", { numeric: true, sensitivity: "base" });
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
    kind: "text-file",
    key,
    displayName: key,
    source: normalizedSource,
    rawContent: content,
  };
}

function createIntroductionFixEntry({ databaseId, introduction, sourceName, rowIndex }) {
  const titleRecord = state.introductionMapping.get(databaseId);
  const displayName = titleRecord?.mappingTitle || titleRecord?.apiTitle || `ID ${databaseId}`;

  return {
    kind: "introduction-fix",
    key: `intro-fix:${databaseId}:${rowIndex}`,
    displayName,
    databaseId,
    source: `${sourceName}#${rowIndex + 2}`,
    rawContent: introduction,
  };
}

function getEntryDisplayName(file) {
  return file.displayName || file.key;
}

function getEntryDatabaseId(file) {
  if (!file) {
    return "";
  }

  if (file.kind === "introduction-fix") {
    return file.databaseId || "";
  }

  return state.csvMapping.get(file.key) || "";
}

function getEntrySearchText(file) {
  return [
    getEntryDisplayName(file),
    file.source,
    getEntryDatabaseId(file),
  ].join(" ").toLowerCase();
}

function hasPreparedIntroduction(file) {
  if (!file) {
    return false;
  }

  if (file.kind === "introduction-fix") {
    return Boolean(normalizeLineEndings(file.rawContent).trim());
  }

  return Boolean(getIntroductionText(getEntryDatabaseId(file)));
}

function getIntroductionStatus(file) {
  if (file?.kind === "introduction-fix") {
    const databaseId = getEntryDatabaseId(file);
    return {
      label: "修复简介",
      tone: "success",
      badgeText: "直接复制简介",
      badgeTone: "",
      detail: databaseId
        ? `该条目来自修复 CSV，将直接复制这一行的简介，并打开 ID ${databaseId} 的编辑页。`
        : "该条目来自修复 CSV，但没有可用的 database_id。",
      stitchText: databaseId
        ? "直接使用修复 CSV 的简介内容，不再额外拼接缓存简介。"
        : "修复 CSV 条目缺少 database_id。",
    };
  }

  const databaseId = getEntryDatabaseId(file);
  if (!databaseId) {
    return {
      label: "未映射",
      tone: "",
      badgeText: "未匹配",
      badgeTone: "neutral",
      detail: "当前文件没有匹配到 database_id，无法拼接简介。",
      stitchText: "当前文件没有匹配到 database_id。",
    };
  }

  if (!state.introductionCsvLoaded) {
    return {
      label: "未加载缓存",
      tone: "empty",
      badgeText: "未载简介缓存",
      badgeTone: "neutral",
      detail: `还没有成功读取 ${DEFAULT_INTRODUCTION_CSV_PATH}，当前只能显示原始文本。`,
      stitchText: `尚未读取 ${DEFAULT_INTRODUCTION_CSV_PATH}。`,
    };
  }

  const record = state.introductionMapping.get(databaseId);
  if (!record) {
    return {
      label: "未缓存",
      tone: "empty",
      badgeText: "未找到缓存",
      badgeTone: "neutral",
      detail: `database_id ${databaseId} 没有在 ${DEFAULT_INTRODUCTION_CSV_PATH} 中找到对应记录。`,
      stitchText: `未在 ${DEFAULT_INTRODUCTION_CSV_PATH} 中找到该 ID 的简介缓存。`,
    };
  }

  if (record.status === "error") {
    return {
      label: "缓存失败",
      tone: "error",
      badgeText: "缓存抓取失败",
      badgeTone: "neutral",
      detail: record.error || "该 ID 在缓存阶段抓取失败。",
      stitchText: "该 ID 的简介缓存记录为抓取失败。",
    };
  }

  if (record.introduction) {
    return {
      label: "已拼接",
      tone: "success",
      badgeText: "简介已拼接",
      badgeTone: "",
      detail: "已从本地简介缓存中读取内容，并拼接到原始文本前。",
      stitchText: "已拼接：简介 + 空行 + 原始 .md 文本",
    };
  }

  return {
    label: "无简介",
    tone: "empty",
    badgeText: "无可拼接简介",
    badgeTone: "neutral",
    detail: "简介缓存存在，但该条目的 introduction 为空。",
      stitchText: "缓存存在，但该条目的简介为空，当前显示原始 .md 文本。",
  };
}

function buildPreparedContent(file) {
  if (file.kind === "introduction-fix") {
    return normalizeLineEndings(file.rawContent);
  }

  const introduction = getIntroductionText(getEntryDatabaseId(file));
  const originalContent = normalizeLineEndings(file.rawContent);
  if (!introduction) {
    return originalContent;
  }

  return originalContent
    ? `${introduction}\n\n${originalContent}`
    : introduction;
}

function getClipboardContent(file) {
  return normalizeLineEndings(buildPreparedContent(file));
}

function getIntroductionText(databaseId) {
  if (!databaseId) {
    return "";
  }

  const record = state.introductionMapping.get(databaseId);
  if (!record) {
    return "";
  }

  return record.status === "ok" ? record.introduction : "";
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
  return `${text}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

function parseTable(text) {
  const firstLine = normalizeLineEndings(text).split("\n", 1)[0] ?? "";
  if (firstLine.includes("\t") && !firstLine.includes(",")) {
    return parseDelimitedText(text, "\t");
  }

  const csvRows = parseDelimitedText(text, ",");
  if (csvRows.length === 1 && Object.keys(csvRows[0] ?? {}).some((header) => header.includes("\t"))) {
    return parseDelimitedText(text, "\t");
  }

  return csvRows;
}

function parseDelimitedText(text, delimiter) {
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

    if (char === delimiter && !insideQuotes) {
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
