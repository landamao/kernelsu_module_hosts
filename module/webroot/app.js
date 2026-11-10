// Local-only UI for current stable Android WebView. Never persist Hosts in browser storage.
// bridge.js owns the native API. A dynamic named import lets a missing bridge fail into preview.
const MAX_BYTES = 262144;
const CHUNK_BYTES = 9216; // Divisible by three; encode each raw UTF-8 chunk independently.
const HELPER = '/system/bin/sh /data/adb/modules/hosts_studio/bin/hostsctl.sh';
const HASH = /^[a-f0-9]{64}$/;
const STAGE_ID = /^[a-f0-9]{24}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const number = new Intl.NumberFormat('zh-CN');
const byId = (id) => document.getElementById(id);
const ui = {
  input: byId('hosts-input'),
  editor: document.querySelector('.editor-panel'),
  environment: byId('environment-banner'),
  environmentTitle: byId('environment-title'),
  environmentDetail: byId('environment-detail'),
  savedCard: byId('saved-card'), savedValue: byId('saved-value'), savedDetail: byId('saved-detail'),
  activeCard: byId('active-card'), activeValue: byId('active-value'), activeDetail: byId('active-detail'),
  rebootCard: byId('reboot-card'), rebootValue: byId('reboot-value'), rebootDetail: byId('reboot-detail'),
  capacity: byId('capacity-card'), bytes: byId('byte-count'), characters: byId('character-count'),
  meter: byId('byte-meter'), sizeHelp: byId('size-help'), lineCount: byId('line-count'),
  revision: byId('revision-label'), editState: byId('edit-state'),
  refresh: byId('refresh-button'), refreshLabel: byId('refresh-label'),
  save: byId('save-button'), saveLabel: byId('save-label'), saveHelp: byId('save-help'),
  restoreBackup: byId('restore-backup-button'), restoreOriginal: byId('restore-original-button'),
  export: byId('export-button'), backupHelp: byId('backup-help'),
  configured: byId('configured-detail'), storedBytes: byId('stored-bytes-detail'),
  bootId: byId('boot-id-detail'), bootMessage: byId('boot-message-detail'),
  feedback: byId('feedback'), feedbackText: byId('feedback-text'), feedbackSymbol: byId('feedback-symbol'),
  dialog: byId('confirm-dialog'), dialogTitle: byId('dialog-title'),
  dialogDescription: byId('dialog-description'), dialogWarning: byId('dialog-warning'),
  dialogConfirm: byId('dialog-confirm'), dialogCancel: byId('dialog-cancel'),
};
const state = {
  exec: null, ready: false, preview: false, loaded: false, busy: '', dialogOpen: false,
  revision: null, baseline: '', status: null, receipt: null, needsReload: false,
  bytes: 0, characters: 0, lines: 0, uploadIndex: 0, uploadTotal: 0,
};

function dirty() {
  return ui.input.value !== state.baseline;
}

function errorText(error) {
  const value = error instanceof Error ? error.message : String(error || '未知错误');
  const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return safe.length > 1200 ? `${safe.slice(0, 1200)}…（错误信息已截断）` : safe;
}

function feedback(message, tone = 'info') {
  ui.feedback.dataset.tone = tone;
  ui.feedbackSymbol.textContent = tone === 'error' || tone === 'warning' ? '!' : 'i';
  // Device messages and all user input are text, never markup or shell fragments.
  ui.feedbackText.textContent = message;
}

function updateMetrics() {
  const text = ui.input.value;
  state.bytes = encoder.encode(text).byteLength;
  let characters = 0;
  for (const unused of text) characters += 1;
  state.characters = characters;
  state.lines = text.length === 0 ? 0 : 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) state.lines += 1;
  }
}

function card(element, valueElement, detailElement, value, detail, tone = 'neutral') {
  element.dataset.tone = tone;
  valueElement.textContent = value;
  detailElement.textContent = detail;
}

function canMutate() {
  return state.ready && state.loaded && !state.needsReload && !state.busy && !state.dialogOpen;
}

function render() {
  const changed = dirty();
  const locked = Boolean(state.busy || state.dialogOpen);
  const allowed = canMutate();
  const oversized = state.bytes > MAX_BYTES;
  const empty = ui.input.value.trim().length === 0;
  ui.input.disabled = Boolean(state.busy) || (!state.preview && !state.loaded);
  ui.editor.setAttribute('aria-busy', String(Boolean(state.busy)));
  ui.refresh.disabled = !state.ready || locked;
  ui.save.disabled = !allowed || !changed || empty || oversized;
  ui.restoreOriginal.disabled = !allowed;
  ui.restoreBackup.disabled = !allowed || state.status?.backup !== true;
  ui.export.disabled = locked || (!state.loaded && !state.preview) || state.bytes === 0;
  ui.refreshLabel.textContent = state.busy === 'read' ? '正在读取…' : '重新读取';
  ui.saveLabel.textContent = state.busy === 'save'
    ? (state.uploadTotal ? `上传 ${state.uploadIndex}/${state.uploadTotal}` : '正在保存…')
    : '保存规则';
  ui.bytes.textContent = number.format(state.bytes);
  ui.characters.textContent = `${number.format(state.characters)} 字符 · 上限 262,144 字节`;
  ui.meter.value = Math.min(state.bytes, MAX_BYTES);
  ui.meter.textContent = `${state.bytes} / ${MAX_BYTES}`;
  ui.meter.setAttribute('aria-valuetext', `${state.bytes} 字节，上限 ${MAX_BYTES} 字节`);
  ui.capacity.dataset.tone = oversized ? 'error' : state.bytes > MAX_BYTES * .9 ? 'warning' : 'neutral';
  ui.sizeHelp.dataset.tone = oversized || (state.loaded && changed && empty) ? 'error' : 'neutral';
  ui.input.setAttribute('aria-invalid', String(oversized || (state.loaded && changed && empty)));
  ui.sizeHelp.textContent = oversized
    ? `已超出 ${number.format(state.bytes - MAX_BYTES)} 字节，不能保存。请缩减到 262,144 字节以内；当前文本仍可导出。`
    : empty && (state.loaded || state.preview)
      ? '不能保存空文件或纯空白文件。可编辑后再保存；上限为 262,144 个 UTF-8 字节。'
      : '上限 262,144 字节（256 KiB）；中文等字符会占用多个字节。';
  ui.lineCount.textContent = `${number.format(state.lines)} 行`;
  ui.revision.textContent = state.revision ? `修订 · ${state.revision.slice(0, 10)}` : '修订 · 未读取';
  ui.revision.title = state.revision || '尚无设备修订';

  let editLabel = '等待连接';
  let editTone = 'neutral';
  if (state.busy) editLabel = state.busy === 'save' ? '正在保存' : state.busy === 'restore' ? '正在恢复' : '正在读取';
  else if (state.preview) { editLabel = changed ? '预览草稿 · 未保存' : '仅预览'; editTone = changed ? 'warning' : 'neutral'; }
  else if (changed) { editLabel = '有未保存修改'; editTone = 'warning'; }
  else if (state.needsReload) { editLabel = '需重新读取'; editTone = 'warning'; }
  else if (state.loaded) { editLabel = '与已读版本一致'; editTone = 'success'; }
  ui.editState.textContent = editLabel;
  ui.editState.dataset.tone = editTone;
  document.title = `${changed ? '• ' : ''}Hosts Studio · 本地 Hosts 编辑器`;

  if (state.preview) {
    card(ui.savedCard, ui.savedValue, ui.savedDetail, '未连接设备', '草稿未写入任何模块');
  } else if (state.needsReload) {
    card(ui.savedCard, ui.savedValue, ui.savedDetail, '需要核对', changed ? '编辑内容已保留，请先导出' : '重新读取后才能继续写入', 'warning');
  } else if (changed) {
    card(ui.savedCard, ui.savedValue, ui.savedDetail, '尚未保存', '修改仅存在于当前编辑区', 'warning');
  } else if (state.loaded) {
    card(ui.savedCard, ui.savedValue, ui.savedDetail, state.status?.configured === false ? '已读取初始内容' : '已读取保存版本', '编辑区与最近读取的版本一致', 'success');
  } else {
    card(ui.savedCard, ui.savedValue, ui.savedDetail, '尚未读取', state.ready ? '请重新读取设备配置' : '连接后读取模块配置');
  }

  if (state.status) {
    const status = state.status;
    card(ui.activeCard, ui.activeValue, ui.activeDetail, status.active ? '模块已挂载' : '未报告挂载', '设备端快照 · 不等于全部应用生效', status.active ? 'success' : 'neutral');
    card(ui.rebootCard, ui.rebootValue, ui.rebootDetail, status.pending ? '等待下次重启' : '无待重启更改', status.pending ? '已保存配置尚待下次启动加载' : '不代表全部应用的 DNS 已更新', status.pending ? 'warning' : 'neutral');
    ui.configured.textContent = status.configured ? '模块已有保存配置' : '模块尚无自定义保存配置';
    ui.storedBytes.textContent = `${number.format(status.bytes)} 字节`;
    ui.bootId.textContent = status.bootId || '设备端未提供启动标识';
    ui.bootMessage.textContent = status.bootMessage || '设备端未提供启动说明';
    ui.backupHelp.textContent = status.backup ? '设备端报告存在可恢复的备份' : '设备端暂无可恢复的上一版';
  } else {
    card(ui.activeCard, ui.activeValue, ui.activeDetail, state.preview ? '未连接设备' : '尚未确认', '不显示未经确认的挂载结果');
    card(ui.rebootCard, ui.rebootValue, ui.rebootDetail, state.receipt ? '等待下次重启' : '尚未确认', state.receipt ? '写入回执已确认 · 启动状态未核对' : '保存后于下次重启加载', state.receipt ? 'warning' : 'neutral');
    ui.configured.textContent = state.receipt ? '已收到写入成功回执，状态待核对' : '尚未确认';
    ui.storedBytes.textContent = state.receipt ? `${number.format(state.receipt.bytes)} 字节（写入回执）` : '尚未确认';
    ui.bootId.textContent = '尚未确认';
    ui.bootMessage.textContent = '尚未确认';
    ui.backupHelp.textContent = '备份状态尚未确认';
  }
  ui.saveHelp.textContent = state.preview ? '仅预览：可编辑和导出，不能写入设备。'
    : state.needsReload ? '设备版本需核对；先导出草稿，再重新读取。'
      : !state.loaded ? '读取成功后才能保存。'
        : !changed ? '与已读版本一致，无需重复保存。'
          : '未保存的修改只在当前页面内存中。';
}

function setBusy(value) {
  state.busy = value;
  if (!value) { state.uploadIndex = 0; state.uploadTotal = 0; }
  render();
}

// No free-form command path: verbs and every ASCII argument are validated here.
function buildCommand(verb, args) {
  let valid = false;
  switch (verb) {
    case 'read':
    case 'status':
      valid = args.length === 0;
      break;
    case 'stage-begin':
    case 'restore-backup':
    case 'restore-original':
      valid = args.length === 1 && typeof args[0] === 'string' && HASH.test(args[0]);
      break;
    case 'stage-abort':
    case 'stage-commit':
      valid = args.length === 1 && typeof args[0] === 'string' && STAGE_ID.test(args[0]);
      break;
    case 'stage-append':
      valid = args.length === 3 && typeof args[0] === 'string' && STAGE_ID.test(args[0])
        && typeof args[1] === 'string' && /^(0|[1-9][0-9]*)$/.test(args[1])
        && Number.isSafeInteger(Number(args[1])) && Number(args[1]) < Math.ceil(MAX_BYTES / CHUNK_BYTES)
        && typeof args[2] === 'string' && args[2].length > 0 && args[2].length <= 12288
        && args[2].length % 4 === 0 && BASE64.test(args[2]);
      break;
    default:
      throw new Error('拒绝未定义的设备操作。');
  }
  if (!valid) throw new Error('设备操作参数不符合约定，已停止执行。');
  // The validated alphabet contains no quote, whitespace, substitution or shell metacharacters.
  return `${HELPER} ${verb}${args.map((value) => ` '${value}'`).join('')}`;
}

async function command(verb, ...args) {
  if (!state.ready || typeof state.exec !== 'function') throw new Error('设备桥接不可用。');
  const result = await state.exec(buildCommand(verb, args));
  if (!result || !Number.isInteger(result.errno) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    throw new Error('桥接返回格式不符合约定，无法确认设备操作结果。');
  }
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch {
    throw new Error(result.errno !== 0
      ? `设备命令失败（${result.errno}），且未返回有效 JSON。${result.stderr ? `\n${errorText(result.stderr)}` : ''}`
      : '设备端未返回单个有效 JSON 对象，无法确认操作结果。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.ok !== 'boolean') {
    throw new Error('设备端 JSON 响应缺少有效的 ok 字段。');
  }
  if (!payload.ok) throw new Error(typeof payload.error === 'string' && payload.error ? errorText(payload.error) : '设备端拒绝了此操作，未提供错误说明。');
  if (result.errno !== 0) throw new Error(`设备命令退出异常（${result.errno}），不能将其视为成功。${result.stderr ? `\n${errorText(result.stderr)}` : ''}`);
  return payload;
}

function validBytes(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readHosts() {
  const payload = await command('read');
  if (typeof payload.revision !== 'string' || !HASH.test(payload.revision)
    || typeof payload.content !== 'string' || payload.content.length % 4 !== 0 || !BASE64.test(payload.content)) {
    throw new Error('读取响应的修订或 Base64 内容不符合约定。');
  }
  try {
    const binary = atob(payload.content);
    if (btoa(binary) !== payload.content) throw new Error('Non-canonical Base64');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { text: decoder.decode(bytes), revision: payload.revision, bytes: bytes.byteLength };
  } catch {
    throw new Error('读取内容不是有效的 Base64 UTF-8 文本；编辑区未被替换。');
  }
}

async function readStatus() {
  const payload = await command('status');
  if (['active', 'pending', 'configured', 'backup'].some((key) => typeof payload[key] !== 'boolean')
    || !validBytes(payload.bytes) || typeof payload.bootMessage !== 'string' || typeof payload.bootId !== 'string') {
    throw new Error('模块状态响应字段不完整或类型不符合约定。');
  }
  return payload;
}

function installSnapshot(snapshot) {
  // The native textarea normalizes CRLF/CR to LF; hash remains the exact backend revision.
  ui.input.value = snapshot.text;
  state.baseline = ui.input.value;
  state.revision = snapshot.revision;
  state.loaded = true;
  state.needsReload = false;
  updateMetrics();
}

async function confirmAction({ title, description, warning, confirm }) {
  if (state.dialogOpen || state.busy) return false;
  if (typeof ui.dialog.showModal !== 'function') {
    feedback('当前 WebView 不支持安全确认对话框，已取消操作。请升级到当前稳定版 Android WebView。', 'error');
    return false;
  }
  const opener = document.activeElement;
  ui.dialogTitle.textContent = title;
  ui.dialogDescription.textContent = description;
  ui.dialogWarning.textContent = warning;
  ui.dialogConfirm.textContent = confirm;
  ui.dialog.returnValue = 'cancel';
  state.dialogOpen = true;
  render();
  return new Promise((resolve) => {
    const onClose = () => {
      state.dialogOpen = false;
      render();
      if (opener instanceof HTMLElement && !opener.disabled) opener.focus();
      resolve(ui.dialog.returnValue === 'confirm');
    };
    ui.dialog.addEventListener('close', onClose, { once: true });
    try {
      ui.dialog.showModal();
      ui.dialogCancel.focus();
    } catch {
      ui.dialog.removeEventListener('close', onClose);
      state.dialogOpen = false;
      render();
      feedback('无法打开确认对话框，操作已取消。', 'error');
      resolve(false);
    }
  });
}

async function reloadDevice(initial = false) {
  if (!state.ready || state.busy || state.dialogOpen) return;
  if (!initial && dirty()) {
    const confirmed = await confirmAction({
      title: '丢弃修改并重新读取？',
      description: '将以设备当前保存的 Hosts 替换编辑区。你尚未保存的修改会被丢弃。',
      warning: '建议先导出 .txt 留存草稿。只有读取及状态检查全部成功后，编辑区才会被替换。',
      confirm: '丢弃并读取',
    });
    if (!confirmed) return;
  }
  setBusy('read');
  feedback('正在读取设备配置与模块状态…');
  try {
    // Commit the UI only after both reads succeed, so refresh errors never discard a draft.
    const snapshot = await readHosts();
    const status = await readStatus();
    installSnapshot(snapshot);
    state.status = status;
    state.receipt = null;
    feedback(status.pending
      ? '已读取设备保存的配置。当前有更改等待下次重启；这不代表本次启动已应用新规则。'
      : '已读取设备配置及状态。编辑后可保存，挂载状态不等于所有应用的 DNS 结果。', 'success');
  } catch (error) {
    state.status = null;
    state.needsReload = true;
    feedback(`读取失败，编辑区内容保持不变。请保留或导出草稿后重试。\n${errorText(error)}`, 'error');
  } finally {
    setBusy('');
  }
}

function encodeChunk(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function validateReceipt(payload) {
  if (typeof payload.revision !== 'string' || !HASH.test(payload.revision)
    || !validBytes(payload.bytes) || payload.bytes > MAX_BYTES || payload.pending !== true) {
    throw new Error('写入回执不符合约定，不能确认结果。请重新读取核对。');
  }
  return { revision: payload.revision, bytes: payload.bytes, pending: true };
}

async function verifyWrite(receipt, inputBefore) {
  const errors = [];
  let snapshot;
  let status;
  try { snapshot = await readHosts(); } catch (error) { errors.push(errorText(error)); }
  try { status = await readStatus(); } catch (error) { errors.push(errorText(error)); }
  state.status = status || null;
  // Do not overwrite the draft on ANY verification error, including a status failure.
  // Textarea is disabled for the whole operation; the equality check is a second guard.
  if (errors.length === 0 && snapshot && snapshot.revision === receipt.revision
    && snapshot.bytes === receipt.bytes && ui.input.value === inputBefore) {
    installSnapshot(snapshot);
  } else {
    state.needsReload = true;
    if (snapshot && (snapshot.revision !== receipt.revision || snapshot.bytes !== receipt.bytes)) {
      errors.push('设备内容已与写入回执不同，可能有其他进程修改；未覆盖编辑区。');
    }
    if (ui.input.value !== inputBefore) {
      errors.push('编辑内容在操作期间发生变化，未覆盖编辑区。');
    }
  }
  if (errors.length) {
    feedback(`设备已确认写入成功，配置供下次重启加载；后续核对未全部完成。编辑内容已保留，请先导出草稿，再重新读取。\n${errors.join('\n')}`, 'warning');
  } else {
    feedback('已保存到模块，供下次重启加载。这里没有执行重启，也没有将保存结果视为本次启动已生效。', 'success');
  }
}

async function saveHosts() {
  if (!canMutate() || !dirty()) return;
  const inputBefore = ui.input.value;
  const bytes = encoder.encode(inputBefore);
  if (inputBefore.trim().length === 0 || bytes.byteLength === 0) {
    feedback('不能保存空文件或纯空白文件。请保留必要的 Hosts 条目。', 'error');
    return;
  }
  if (bytes.byteLength > MAX_BYTES) {
    feedback('内容超过 262,144 个 UTF-8 字节，尚未发起任何写入。可先导出文本。', 'error');
    return;
  }
  const expectedRevision = state.revision;
  let id = null;
  let committed = false;
  setBusy('save');
  feedback('正在创建临时上传。编辑区暂时锁定；保存不会即时替换系统 Hosts。');
  try {
    const started = await command('stage-begin', expectedRevision);
    if (typeof started.id !== 'string' || !STAGE_ID.test(started.id)) throw new Error('设备返回的上传标识不符合约定，已停止上传。');
    id = started.id;
    state.uploadTotal = Math.ceil(bytes.byteLength / CHUNK_BYTES);
    for (let index = 0; index < state.uploadTotal; index += 1) {
      const chunk = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.byteLength));
      const appended = await command('stage-append', id, String(index), encodeChunk(chunk));
      if (appended.next !== index + 1) throw new Error('上传序号响应不符合约定，已停止保存。');
      state.uploadIndex = index + 1;
      render();
    }
    state.needsReload = true;
    state.status = null;
    state.receipt = null;
    const receipt = validateReceipt(await command('stage-commit', id));
    committed = true;
    state.receipt = receipt;
    feedback('设备已确认保存。正在重新读取并核对修订…');
    await verifyWrite(receipt, inputBefore);
  } catch (error) {
    let abortError = '';
    if (id && !committed) {
      try { await command('stage-abort', id); }
      catch (cleanupError) { abortError = `\n临时上传清理未确认：${errorText(cleanupError)}`; }
    }
    state.status = null;
    if (!committed) state.receipt = null;
    state.needsReload = true;
    feedback(`${committed ? '设备已确认保存，但后续核对失败。' : '保存未确认成功，不能认定已写入或生效。'}编辑区内容已保留。请先导出草稿，再重新读取核对设备版本。\n${errorText(error)}${abortError}`, 'error');
  } finally {
    setBusy('');
  }
}

async function restoreHosts(kind) {
  if (!canMutate() || (kind === 'backup' && state.status?.backup !== true)) return;
  const backup = kind === 'backup';
  const confirmed = await confirmAction({
    title: backup ? '恢复上一版 Hosts？' : '恢复初始 Hosts？',
    description: backup ? '设备端备份将替换模块当前保存的配置。成功后会重新读取到编辑区。' : '模块保留的初始 Hosts 将替换当前保存的配置。成功后会重新读取到编辑区。',
    warning: `${dirty() ? '你还有未保存的修改，恢复成功后将被替换。建议先取消并导出草稿。\n' : ''}这是一次真实写入，需要下次重启加载；不是即时应用操作。`,
    confirm: backup ? '确认恢复上一版' : '确认恢复初始版',
  });
  if (!confirmed || !canMutate()) return;
  const inputBefore = ui.input.value;
  const expectedRevision = state.revision;
  let confirmedWrite = false;
  setBusy('restore');
  feedback('正在请求设备端恢复。编辑区将在成功核对后更新…');
  state.needsReload = true;
  state.status = null;
  state.receipt = null;
  try {
    const receipt = validateReceipt(await command(backup ? 'restore-backup' : 'restore-original', expectedRevision));
    confirmedWrite = true;
    state.receipt = receipt;
    await verifyWrite(receipt, inputBefore);
  } catch (error) {
    state.needsReload = true;
    state.status = null;
    feedback(`${confirmedWrite ? '恢复已收到成功回执，但核对失败。' : '恢复未确认成功。'}编辑区内容保持不变。请先导出草稿，再重新读取核对。\n${errorText(error)}`, 'error');
  } finally {
    setBusy('');
  }
}

function exportText() {
  if (ui.export.disabled) return;
  let url;
  let link;
  try {
    const blob = new Blob([encoder.encode(ui.input.value)], { type: 'text/plain;charset=utf-8' });
    url = URL.createObjectURL(blob);
    link = document.createElement('a');
    link.href = url;
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    link.download = `hosts-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    feedback('已请求导出当前编辑区为 UTF-8 .txt；包含未保存的修改，未写入模块。若管理器没有处理 Blob 下载，请勿据此认定文件已落盘。');
  } catch (error) {
    feedback(`未能发起导出，编辑区内容保持不变。\n${errorText(error)}`, 'error');
  } finally {
    link?.remove();
    // Give WebView's download handling time to consume the Blob before releasing it.
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function enterPreview(reason) {
  state.ready = false;
  state.preview = true;
  state.exec = null;
  state.status = null;
  ui.environment.dataset.mode = 'preview';
  ui.environmentTitle.textContent = '仅预览，需在 KernelSU 管理器中打开';
  ui.environmentDetail.textContent = `${reason} 可试写和导出文本；读取、保存和恢复均已禁用，不会操作设备。`;
  feedback('预览模式不会读取设备，也不会模拟保存或生效。示例仅为占位提示；输入的草稿只保留在当前页面内存中。', 'warning');
  render();
}

async function initialize() {
  render();
  let bridge;
  try {
    // Equivalent named contract: { exec, isKernelSU } from './bridge.js'.
    bridge = await import('./bridge.js');
  } catch {
    enterPreview('设备桥接未提供或无法加载。');
    return;
  }
  const { exec, isKernelSU } = bridge;
  if (typeof exec !== 'function' || (typeof isKernelSU !== 'function' && typeof isKernelSU !== 'boolean')) {
    enterPreview('设备桥接接口不符合约定。');
    return;
  }
  try {
    const detected = typeof isKernelSU === 'function' ? await isKernelSU() : isKernelSU;
    if (detected !== true) {
      enterPreview('没有检测到 KernelSU 设备环境。');
      return;
    }
  } catch {
    enterPreview('无法确认 KernelSU 设备环境。');
    return;
  }
  state.exec = exec;
  state.ready = true;
  ui.environment.dataset.mode = 'connected';
  ui.environmentTitle.textContent = '已连接 KernelSU 桥接';
  ui.environmentDetail.textContent = '只通过模块固定助手访问本地配置。桥接可用不代表规则已挂载或已生效。';
  await reloadDevice(true);
}

ui.input.addEventListener('input', () => {
  updateMetrics();
  render();
  if (!state.needsReload) {
    feedback(state.preview ? '这是预览草稿，未连接设备；可以导出 .txt，不能保存到模块。'
      : dirty() ? '有未保存的修改。保存后供下次重启加载；离开页面前请保存或导出。'
        : '编辑区与最近读取的版本一致。', dirty() ? 'warning' : 'info');
  }
});
ui.refresh.addEventListener('click', () => { void reloadDevice(); });
ui.save.addEventListener('click', () => { void saveHosts(); });
ui.restoreBackup.addEventListener('click', () => { void restoreHosts('backup'); });
ui.restoreOriginal.addEventListener('click', () => { void restoreHosts('original'); });
ui.export.addEventListener('click', exportText);
byId('confirm-form').addEventListener('submit', (event) => {
  event.preventDefault(); // method=dialog is local, but avoid any form navigation under CSP.
  ui.dialog.close(event.submitter?.value === 'confirm' ? 'confirm' : 'cancel');
});
ui.dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  ui.dialog.close('cancel');
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!ui.save.disabled) void saveHosts();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirty() || state.busy === 'save' || state.busy === 'restore') {
    event.preventDefault();
    event.returnValue = ''; // WebView may suppress this; the persistent draft notice remains visible.
  }
});
void initialize();
