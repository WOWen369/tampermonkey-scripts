// ==UserScript==
// @name         MISA Auto Search (Tampermonkey port)
// @namespace    misa-autosearch
// @version      1.0.2
// @description  Tự động paste SKU vào ô tìm kiếm MISA — port 100% logic + UI/UX từ Chrome Extension gốc (content.js v3.7 + popup.js v4.0)
// @author       —
// @match        https://*.misa.vn/*
// @match        https://*.misacdn.net/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/misa-autosearch.user.js
// @downloadURL  https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/misa-autosearch.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   *  0. CONFIG / CONSTANTS — giữ nguyên như content.js gốc
   * ============================================================ */
  const SLEEP_AFTER_SELECT_MS   = 400;
  const WAIT_DROPDOWN_TIMEOUT   = 5000;
  const WAIT_ROW_ADDED_TIMEOUT  = 1500;
  const SEARCH_PLACEHOLDER      = 'Tìm kiếm thông minh bằng AI (F3)';
  const ORDER_LIST_SELECTOR     = '.list-item-in-order';
  const ORDER_ROW_SELECTOR      = '.list-item-in-order > .row';
  const EMPTY_DROPDOWN_SELECTOR = '.empty-data-item';
  const STORAGE_RUN_KEYS        = ['skus', 'type', 'status', 'logs', 'current'];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ============================================================
   *  1. STORAGE LAYER
   *  Thay chrome.storage.local bằng GM_setValue/GM_getValue.
   *  GM_addValueChangeListener mô phỏng chrome.storage.onChanged
   *  (bắn cả khi set trong cùng tab lẫn khi 1 tab MISA khác đổi giá trị —
   *   đây chính là cơ chế popup <-> content giao tiếp trong bản gốc).
   * ============================================================ */
  function storageGet(keys) {
    const out = {};
    keys.forEach(k => {
      const v = GM_getValue(k, undefined);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }
  function storageSet(obj) {
    Object.keys(obj).forEach(k => GM_setValue(k, obj[k]));
  }
  function storageRemove(keys) {
    keys.forEach(k => GM_deleteValue(k));
  }

  const _changeHandlers = []; // fn(changes, area)
  ['status', 'logs', 'popupSkus', 'popupType'].forEach(key => {
    GM_addValueChangeListener(key, (name, oldValue, newValue) => {
      const changes = { [name]: { oldValue, newValue } };
      _changeHandlers.forEach(h => {
        try { h(changes, 'local'); } catch (e) { console.error('[MISA AutoSearch] listener error', e); }
      });
    });
  });
  function onStorageChanged(fn)  { _changeHandlers.push(fn); return fn; }
  function offStorageChanged(fn) {
    const i = _changeHandlers.indexOf(fn);
    if (i >= 0) _changeHandlers.splice(i, 1);
  }

  /* ============================================================
   *  2. CONTENT LOGIC — port gần như nguyên văn content.js
   * ============================================================ */
  let _isRunning      = false;
  let _shouldStop     = false;
  let _activeObserver = null;

  function isFullyVisible(el) {
    let node = el;
    while (node && node !== document.body) {
      const st = window.getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      node = node.parentElement;
    }
    return el.offsetParent !== null;
  }

  function findSearchInput() {
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && active.placeholder === SEARCH_PLACEHOLDER) return active;
    const candidates = [
      ...document.querySelectorAll(`input[placeholder="${SEARCH_PLACEHOLDER}"]`),
      ...document.querySelectorAll('input.combo-input'),
    ];
    for (const inp of candidates) {
      if (inp.type === 'text' && isFullyVisible(inp)) return inp;
    }
    return null;
  }

  function setInputValue(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, ''); else input.value = '';
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForProductAndClick() {
    if (_activeObserver) { _activeObserver.disconnect(); _activeObserver = null; }
    const _t0 = performance.now();
    return new Promise((resolve) => {
      const existing = document.querySelector('div.combobox-item.box-item');
      if (existing && existing.offsetParent !== null) {
        existing.click();
        console.log(`[MISA AutoSearch] ⏱ có sản phẩm (sẵn có) sau ${(performance.now() - _t0).toFixed(0)}ms`);
        return resolve(true);
      }

      let resolved = false;
      const observer = new MutationObserver(() => {
        if (resolved) return;

        const item = document.querySelector('div.combobox-item.box-item');
        if (item && item.offsetParent !== null) {
          resolved = true;
          observer.disconnect();
          _activeObserver = null;
          clearTimeout(timer);
          item.click();
          console.log(`[MISA AutoSearch] ⏱ có sản phẩm sau ${(performance.now() - _t0).toFixed(0)}ms`);
          return resolve(true);
        }

        const empty = document.querySelector(EMPTY_DROPDOWN_SELECTOR);
        if (empty && empty.offsetParent !== null) {
          resolved = true;
          observer.disconnect();
          _activeObserver = null;
          clearTimeout(timer);
          console.log(`[MISA AutoSearch] ⏱ KHÔNG có dữ liệu sau ${(performance.now() - _t0).toFixed(0)}ms`);
          return resolve(false);
        }
      });
      _activeObserver = observer;
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        _activeObserver = null;
        console.warn(`[MISA AutoSearch] ⏱ Timeout sau ${(performance.now() - _t0).toFixed(0)}ms — không thấy dropdown`);
        resolve(false);
      }, WAIT_DROPDOWN_TIMEOUT);
    });
  }

  function countOrderRows() {
    return document.querySelectorAll(ORDER_ROW_SELECTOR).length;
  }

  function waitForRowAdded(prevCount) {
    return new Promise((resolve) => {
      if (countOrderRows() > prevCount) return resolve(true);

      const container = document.querySelector(ORDER_LIST_SELECTOR);
      if (!container) {
        setTimeout(() => resolve(false), SLEEP_AFTER_SELECT_MS);
        return;
      }

      let resolved = false;
      const observer = new MutationObserver(() => {
        if (resolved) return;
        if (countOrderRows() > prevCount) {
          resolved = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(true);
        }
      });
      observer.observe(container, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        resolve(false);
      }, WAIT_ROW_ADDED_TIMEOUT);
    });
  }

  // Callback cập nhật UI trực tiếp — thay cho việc chờ GM_addValueChangeListener
  // bắn ngược lại (không đáng tin cậy khi ghi liên tục nhiều lần trong 1 tab/1 context).
  // GM storage vẫn được ghi song song để restoreState() dùng khi người dùng reload trang.
  let _onProgress = null;
  function setProgressCallback(fn) { _onProgress = fn; }

  async function writeLog(logs, current, status) {
    storageSet({ logs, current, status });
    if (_onProgress) {
      try { _onProgress(logs, current, status); } catch (e) { console.error('[MISA AutoSearch] onProgress error', e); }
    }
  }

  function requestStop() { _shouldStop = true; }

  async function runAutoSearch(skus, type) {
    if (_isRunning) {
      console.warn('[MISA AutoSearch] Đang chạy rồi, bỏ qua lệnh mới');
      return;
    }
    _isRunning  = true;
    _shouldStop = false;

    const logs = [];
    storageSet({ logs, current: 0, status: 'running', type });

    for (let i = 0; i < skus.length; i++) {

      if (_shouldStop) {
        if (_activeObserver) { _activeObserver.disconnect(); _activeObserver = null; }
        logs.push({ sku: '—', msg: '⛔ Đã dừng theo yêu cầu', state: 'stop' });
        await writeLog(logs, logs.filter(l => l.state === 'done').length, 'stopped');
        _isRunning = false;
        return;
      }

      const sku = skus[i].trim();
      if (!sku) continue;

      const input = findSearchInput();
      if (!input) {
        logs.push({ sku, msg: '❌ Không tìm thấy ô search', state: 'error' });
        await writeLog(logs, logs.filter(l => l.state === 'done').length, 'running');
        continue;
      }

      logs.push({ sku, msg: '⏳ Đang xử lý...', state: 'pending' });
      await writeLog(logs, logs.filter(l => l.state === 'done').length, 'running');

      try {
        const rowCountBefore = countOrderRows();
        setInputValue(input, sku);
        const clicked = await waitForProductAndClick();

        logs[logs.length - 1] = clicked
          ? { sku, msg: '✅ Hoàn thành', state: 'done' }
          : { sku, msg: '⚠️ Không tìm thấy sản phẩm', state: 'error' };

        if (clicked) {
          await waitForRowAdded(rowCountBefore);
        } else {
          await sleep(SLEEP_AFTER_SELECT_MS);
        }

      } catch (e) {
        logs[logs.length - 1] = { sku, msg: `❌ Lỗi: ${e.message}`, state: 'error' };
      }

      if (_shouldStop) {
        await writeLog(logs, logs.filter(l => l.state === 'done').length, 'stopped');
        _isRunning = false;
        return;
      } else {
        await writeLog(logs, logs.filter(l => l.state === 'done').length, 'running');
      }
    }

    _isRunning  = false;
    _shouldStop = false;
    await writeLog(logs, logs.filter(l => l.state === 'done').length, 'done');
  }

  // Dọn state cũ khi trang vừa load (giữ nguyên hành vi content.js gốc)
  (function clearStaleStateOnLoad() {
    const { status } = storageGet(['status']);
    if (status === 'running' || status === 'done' || status === 'stopped') {
      storageRemove(STORAGE_RUN_KEYS);
      console.log('[MISA AutoSearch] Cleared stale state on reload:', status);
    }
  })();

  console.log('[MISA AutoSearch] Tampermonkey userscript đã inject vào:', location.href);

  /* ============================================================
   *  3. CSS — port gần như nguyên văn từ popup.html, scope dưới
   *     #misaas-panel để không đè style trang MISA
   * ============================================================ */
  GM_addStyle(`
    #misaas-panel, #misaas-panel * { box-sizing: border-box; }
    #misaas-panel button, #misaas-panel input, #misaas-panel textarea { font-family: inherit; font-size: inherit; margin:0; padding:0; }

    #misaas-panel {
      --clr-primary:       #1a73e8;
      --clr-primary-bg:    #e8f0fe;
      --clr-error:         #e53935;
      --clr-success:       #43a047;
      --clr-text:          #3c3c3c;
      --clr-text-muted:    #555;
      --clr-text-faint:    #888;
      --clr-text-dim:      #aaa;
      --clr-bg:            #f8f8f8;
      --clr-border:        #e0e0e0;
      --clr-border-light:  #f0f0f0;
      --fs-xs:  10px;
      --fs-sm:  11px;
      --fs-base:12px;
      --fs-md:  13px;

      position: fixed;
      top: 70px;
      right: 20px;
      width: 420px;
      max-height: 85vh;
      min-height: 200px;
      display: none;
      flex-direction: column;
      background: var(--clr-bg);
      color: var(--clr-text);
      font-family: "Segoe UI", system-ui, sans-serif;
      font-size: var(--fs-md);
      border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.35);
      overflow: hidden;
      z-index: 2147483000;
    }
    #misaas-panel.misaas-open { display: flex; }

    #misaas-launcher {
      position: fixed; bottom: 24px; left: 24px; width: 46px; height: 46px;
      border-radius: 50%; background: #1a5276; color:#fff;
      display:flex; align-items:center; justify-content:center; font-size:20px;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); cursor:pointer;
      z-index: 2147483000; user-select:none; transition: transform .12s;
    }
    #misaas-launcher:hover { transform: scale(1.08); }

    #misaas-header {
      background: #1a5276; color:#fff; padding:10px 14px;
      display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
    }
    #misaas-header h3 { font-size: var(--fs-md); font-weight:700; margin:0; }
    #misaas-headerMeta { display:flex; align-items:center; gap:8px; font-size: var(--fs-sm); opacity:.85; }
    #misaas-panel .auto-type-badge { background: rgba(255,255,255,.2); border-radius:4px; padding:2px 8px; font-weight:700; font-size: var(--fs-xs); letter-spacing:.5px; }
    #misaas-closeBtn { cursor:pointer; opacity:.85; font-size:16px; padding:0 4px; }
    #misaas-closeBtn:hover { opacity:1; }

    #misaas-tabStatus { padding:8px 14px; font-size: var(--fs-xs); display:flex; align-items:center; gap:6px; border-bottom:1px solid var(--clr-border); flex-shrink:0; }
    #misaas-tabDot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
    #misaas-tabDot.ok  { background: var(--clr-success); }
    #misaas-tabDot.err { background: var(--clr-error); }
    #misaas-tabDot.wait{ background: #fb8c00; }

    #misaas-pasteSection { padding:10px 14px 6px; border-bottom:1px solid var(--clr-border); flex-shrink:0; }
    #misaas-pasteSection label { display:block; font-size: var(--fs-xs); color: var(--clr-text-faint); margin-bottom:4px; }
    #misaas-pasteArea {
      width:100%; height:60px; border:1.5px solid #d0d0d0; border-radius:6px; padding:6px 8px;
      font-size: var(--fs-sm); font-family:"Courier New", Consolas, monospace; resize:none; outline:none;
      transition: border-color .15s;
    }
    #misaas-pasteArea:focus { border-color:#4a90d9; }
    #misaas-pasteHint { font-size: var(--fs-xs); color: var(--clr-text-dim); margin-top:3px; }

    #misaas-metaBar { padding:6px 14px 2px; font-size: var(--fs-sm); color: var(--clr-text-muted); flex-shrink:0; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    #misaas-progressText { font-size: var(--fs-xs); color: var(--clr-text-faint); }

    #misaas-autoSearchLog { flex:1; overflow-y:auto; padding:4px 14px 8px; min-height:80px; max-height:280px; }
    #misaas-panel .auto-log-item { display:flex; align-items:baseline; gap:8px; padding:4px 0; border-bottom:1px solid var(--clr-border-light); font-size: var(--fs-sm); }
    #misaas-panel .auto-log-item:last-child { border-bottom:none; }
    #misaas-panel .auto-log-idx { color: var(--clr-text-dim); font-size: var(--fs-xs); min-width:18px; text-align:right; flex-shrink:0; }
    #misaas-panel .auto-log-sku { font-family:"Courier New", Consolas, monospace; font-weight:600; color: var(--clr-text); flex-shrink:0; }
    #misaas-panel .auto-log-msg { color: var(--clr-text-muted); flex:1; }
    #misaas-panel .auto-log-item[data-state="done"]    .auto-log-msg { color: var(--clr-success); }
    #misaas-panel .auto-log-item[data-state="error"]   .auto-log-msg { color: var(--clr-error); }
    #misaas-panel .auto-log-item[data-state="stop"]    .auto-log-msg { color:#f57c00; }
    #misaas-panel .auto-log-item[data-state="pending"] .auto-log-msg { color: var(--clr-text-faint); font-style:italic; }

    #misaas-footer { padding:10px 14px 12px; display:flex; gap:6px; align-items:center; border-top:1px solid var(--clr-border); flex-shrink:0; }

    #misaas-panel .btn-secondary { padding:9px 11px; border:1px solid #c62828; border-radius:7px; font-weight:700; background:#e53935; color:#fff; cursor:pointer; font-size: var(--fs-sm); }
    #misaas-panel .btn-secondary:hover { background:#c62828; }

    #misaas-panel .btn-run { flex:1; padding:9px; border:none; border-radius:7px; font-size: var(--fs-md); font-weight:700; cursor:pointer; background:#2e7d32; color:#fff; transition:opacity .12s; }
    #misaas-panel .btn-run:hover { opacity:.88; }

    #misaas-panel .btn-stop { flex:1; padding:9px; border:none; border-radius:7px; font-size: var(--fs-md); font-weight:700; cursor:pointer; background: var(--clr-error); color:#fff; transition:opacity .12s; }
    #misaas-panel .btn-stop:hover { opacity:.88; }

    #misaas-panel .btn-restart { padding:9px 10px; border:1.5px solid #fb8c00; border-radius:7px; background:#fff8f0; cursor:pointer; font-size: var(--fs-sm); font-weight:600; color:#e65100; white-space:nowrap; transition:background .12s; }
    #misaas-panel .btn-restart:hover { background:#ffe0b2; }

    #misaas-panel .btn-continue { flex:1; padding:9px; border:none; border-radius:7px; font-size: var(--fs-md); font-weight:700; cursor:pointer; background:#1565c0; color:#fff; transition:opacity .12s; }
    #misaas-panel .btn-continue:hover { opacity:.88; }

    #misaas-emptyState { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px 14px; color: var(--clr-text-dim); font-size: var(--fs-sm); text-align:center; gap:6px; }
    #misaas-panel .empty-icon { font-size:28px; }

    #misaas-noTabWarn { display:none; margin:10px 14px 0; padding:8px 10px; background:#fff3e0; border:1px solid #fb8c00; border-radius:6px; font-size: var(--fs-xs); color:#e65100; }

    #misaas-tabNav { display:flex; border-bottom:1px solid var(--clr-border); background:#fff; flex-shrink:0; }
    #misaas-panel .tab-btn { flex:1; padding:7px 0; border:none; background:none; cursor:pointer; font-size: var(--fs-sm); color: var(--clr-text-muted); border-bottom:2px solid transparent; transition: color .15s, border-color .15s; }
    #misaas-panel .tab-btn.active { color: var(--clr-primary); border-bottom-color: var(--clr-primary); font-weight:700; }
    #misaas-panelMain, #misaas-panelSettings { display:flex; flex-direction:column; flex:1; overflow:hidden; }
    #misaas-panelSettings { padding:14px; gap:14px; overflow-y:auto; }

    #misaas-panel .setting-row { display:flex; flex-direction:column; gap:6px; }
    #misaas-panel .setting-row label { font-size: var(--fs-sm); font-weight:600; color: var(--clr-text); }
    #misaas-panel .setting-row .hint { font-size: var(--fs-xs); color: var(--clr-text-faint); }
    #misaas-panel .key-capture { display:flex; align-items:center; gap:8px; }
    #misaas-panel .key-display { flex:1; padding:7px 10px; border:1.5px solid var(--clr-border); border-radius:6px; font-size: var(--fs-sm); font-family:"Courier New", monospace; background:#fff; color: var(--clr-text); cursor:pointer; user-select:none; transition:border-color .15s; }
    #misaas-panel .key-display.capturing { border-color: var(--clr-primary); background: var(--clr-primary-bg); color: var(--clr-primary); }
    #misaas-panel .btn-reset-key { padding:6px 10px; border:1px solid #ccc; border-radius:6px; background:#fff; cursor:pointer; font-size: var(--fs-xs); color: var(--clr-text-muted); }
    #misaas-panel .btn-reset-key:hover { background:#f0f0f0; }
    #misaas-panel .setting-divider { border:none; border-top:1px solid var(--clr-border); margin:0; }

    #misaas-footerHint { padding:4px 14px 8px; font-size:10px; color:#aaa; border-top:1px solid #eee; text-align:center; }
    #misaas-panel kbd { background:#f0f0f0; border:1px solid #ccc; border-radius:3px; padding:1px 5px; font-size:10px; }
  `);

  /* ============================================================
   *  4. HTML — port gần như nguyên văn từ popup.html
   *     (tất cả id được prefix "misaas-" để tránh đụng id trang MISA)
   * ============================================================ */
  function injectPanelHTML() {
    const wrap = document.createElement('div');
    wrap.id = 'misaas-panel';
    wrap.innerHTML = `
      <div id="misaas-header">
        <h3>🚀 Auto Search MISA <span style="opacity:.6;font-weight:400;font-size:10px">v1.0.2</span></h3>
        <div id="misaas-headerMeta">
          <span id="misaas-autoTypeBadge" class="auto-type-badge" style="display:none"></span>
          <span id="misaas-skuCount"></span>
          <span id="misaas-closeBtn" title="Đóng">✕</span>
        </div>
      </div>

      <div id="misaas-tabNav">
        <button class="tab-btn active" id="misaas-tabBtnMain">🚀 Tìm kiếm</button>
        <button class="tab-btn" id="misaas-tabBtnSettings">⚙️ Cài đặt</button>
      </div>

      <div id="misaas-panelSettings" style="display:none">
        <div class="setting-row">
          <label>Phím tắt: CHẠY / TIẾP TỤC</label>
          <div class="key-capture">
            <div class="key-display" id="misaas-keyRun" data-key="run">Ctrl+Space</div>
            <button class="btn-reset-key" id="misaas-resetRun">↩ Mặc định</button>
          </div>
          <div class="hint">Click vào ô rồi nhấn tổ hợp phím muốn dùng</div>
        </div>
        <div class="setting-row">
          <label>Phím tắt: DỪNG</label>
          <div class="key-capture">
            <div class="key-display" id="misaas-keyStop" data-key="stop">Escape</div>
            <button class="btn-reset-key" id="misaas-resetStop">↩ Mặc định</button>
          </div>
          <div class="hint">Click vào ô rồi nhấn tổ hợp phím muốn dùng</div>
        </div>
        <hr class="setting-divider">
        <div class="setting-row">
          <label>Phím tắt: MỞ / ĐÓNG PANEL</label>
          <div class="key-capture">
            <div class="key-display" id="misaas-keyToggle" data-key="toggle">Alt+Shift+S</div>
            <button class="btn-reset-key" id="misaas-resetToggle">↩ Mặc định</button>
          </div>
          <div class="hint">Tampermonkey không có shortcut hệ thống như Chrome Extension nên phím này do chính script quản lý. Cũng có thể mở qua menu icon Tampermonkey → "🚀 Mở Auto Search MISA".</div>
        </div>
      </div>

      <div id="misaas-panelMain">
        <div id="misaas-tabStatus">
          <div id="misaas-tabDot" class="wait"></div>
          <span id="misaas-tabStatusText">Đang kiểm tra trang MISA...</span>
        </div>

        <div id="misaas-pasteSection">
          <label>Danh sách SKU (mỗi dòng 1 SKU, hoặc paste từ Google Sheets):</label>
          <textarea id="misaas-pasteArea" placeholder="53210-K73-V40ZE&#10;53206-K73-V40ZE&#10;64313-K73-V40ZE"></textarea>
          <div id="misaas-pasteHint">Nhập SKU vào ô trên và tận hưởng cuộc sống</div>
        </div>

        <div id="misaas-noTabWarn">⚠️ Chưa tìm thấy ô tìm kiếm / bảng hàng hóa MISA trên trang này.</div>

        <div id="misaas-metaBar" style="display:none">
          <span id="misaas-progressText"></span>
        </div>

        <div id="misaas-autoSearchLog"></div>

        <div id="misaas-emptyState">
          <div class="empty-icon">📋</div>
          <div>Paste SKU vào ô trên rồi nhấn <strong>CHẠY</strong></div>
          <div style="font-size:var(--fs-xs);margin-top:4px;color:var(--clr-text-dim)">
            Hoặc dùng nguồn tự động điền SKU (Google Sheets)<br>để điền vào đây.
          </div>
        </div>

        <div id="misaas-footer"></div>

        <div id="misaas-footerHint">
          <kbd id="misaas-hintRun">Ctrl+Space</kbd> Chạy &nbsp;
          <kbd id="misaas-hintStop">Esc</kbd> Dừng / Đóng &nbsp;
          <kbd id="misaas-hintToggle">Alt+Shift+S</kbd> Mở/Đóng
        </div>
      </div>
    `;
    // Ép trạng thái ẩn ngay bằng inline style — không phụ thuộc CSS ngoài (GM_addStyle)
    // vì 1 số trang có CSP style-src có thể chặn <style> khiến class toggle vô tác dụng.
    wrap.style.display = 'none';
    document.body.appendChild(wrap);

    const launcher = document.createElement('div');
    launcher.id = 'misaas-launcher';
    launcher.title = 'Auto Search MISA';
    launcher.textContent = '🚀';
    document.body.appendChild(launcher);
    launcher.addEventListener('click', () => togglePanel());
  }

  /* ============================================================
   *  5. POPUP LOGIC — port gần như nguyên văn popup.js
   * ============================================================ */
  let pasteArea, logEl, progressText, metaBar, emptyState, noTabWarn,
      tabDot, tabStatusText, skuCountEl, typeBadge, footer;

  let _running     = false;
  let _currentSkus = [];
  let _stoppedAt   = 0;
  let _isStopped   = false;
  let _batchLogs   = [];
  let _runStartTime = 0;
  // true khi vừa chạy xong hoàn tất (không phải do dừng giữa chừng) — panel vẫn giữ
  // nguyên log/ô nhập trong khi đang mở, chỉ xóa sạch vào đúng lúc người dùng ĐÓNG panel.
  let _completedPendingClear = false;

  function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}p${sec.toString().padStart(2, '0')}s`;
  }

  function cacheRefs() {
    pasteArea     = document.getElementById('misaas-pasteArea');
    logEl         = document.getElementById('misaas-autoSearchLog');
    progressText  = document.getElementById('misaas-progressText');
    metaBar       = document.getElementById('misaas-metaBar');
    emptyState    = document.getElementById('misaas-emptyState');
    noTabWarn     = document.getElementById('misaas-noTabWarn');
    tabDot        = document.getElementById('misaas-tabDot');
    tabStatusText = document.getElementById('misaas-tabStatusText');
    skuCountEl    = document.getElementById('misaas-skuCount');
    typeBadge     = document.getElementById('misaas-autoTypeBadge');
    footer        = document.getElementById('misaas-footer');
  }

  function clearRunStorage() { storageRemove(STORAGE_RUN_KEYS); }

  // ── Kiểm tra sẵn sàng (thay chrome.tabs.query + PING/PONG) ──
  function checkReady() {
    setTabStatus('wait', 'Đang kiểm tra trang MISA...');
    noTabWarn.style.display = 'none';
    const input = findSearchInput();
    const hasOrderList = !!document.querySelector(ORDER_LIST_SELECTOR);
    if (input || hasOrderList) {
      setTabStatus('ok', `Sẵn sàng — Auto đã có mặt trên ${location.hostname}`);
    } else {
      setTabStatus('err', 'Chưa tìm thấy ô search / bảng hàng hóa MISA trên trang này');
      noTabWarn.style.display = 'block';
    }
  }
  function setTabStatus(state, text) {
    tabDot.className = '';
    tabDot.classList.add(state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'wait');
    tabStatusText.textContent = text;
  }

  // ── FOOTER ──
  function renderFooter() {
    if (_running) {
      footer.innerHTML = `
        <button class="btn-secondary" id="misaas-fBtnClear">🗑 Xóa</button>
        <button class="btn-stop" id="misaas-fBtnStop">⏹ DỪNG</button>`;
      document.getElementById('misaas-fBtnStop').onclick  = stopRun;
      document.getElementById('misaas-fBtnClear').onclick = doClear;
    } else if (_isStopped && _stoppedAt < _currentSkus.length) {
      const remaining = _currentSkus.length - _stoppedAt;
      footer.innerHTML = `
        <button class="btn-secondary" id="misaas-fBtnClear">🗑 Xóa</button>
        <button class="btn-restart" id="misaas-fBtnRestart">↩ Từ đầu</button>
        <button class="btn-continue" id="misaas-fBtnContinue">▶ Tiếp tục (${remaining})</button>`;
      document.getElementById('misaas-fBtnClear').onclick    = doClear;
      document.getElementById('misaas-fBtnRestart').onclick  = () => { _stoppedAt = 0; _isStopped = false; startRun(); };
      document.getElementById('misaas-fBtnContinue').onclick = startRun;
    } else {
      footer.innerHTML = `
        <button class="btn-secondary" id="misaas-fBtnClear">🗑 Xóa</button>
        <button class="btn-run" id="misaas-fBtnRun">▶ CHẠY</button>`;
      document.getElementById('misaas-fBtnRun').onclick   = startRun;
      document.getElementById('misaas-fBtnClear').onclick = doClear;
    }
  }

  // ── SKU ──
  function parseSkus() {
    return pasteArea.value.split(/[\n,;\t]+/).map(s => s.trim()).filter(Boolean);
  }
  function updateSkuCount() {
    const skus = parseSkus();
    skuCountEl.textContent = skus.length > 0 ? `${skus.length} SKU` : '';
    _currentSkus = skus;
    if (_isStopped) { _isStopped = false; _stoppedAt = 0; _batchLogs = []; renderFooter(); }
  }

  // ── LOG ──
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function renderLog(items) {
    if (!items || items.length === 0) return;
    emptyState.style.display = 'none';
    metaBar.style.display    = 'flex';
    logEl.innerHTML = items.map((it, i) =>
      `<div class="auto-log-item" data-state="${esc(it.state||'wait')}">
        <span class="auto-log-idx">${it.sku==='—' ? '' : i+1}</span>
        <span class="auto-log-sku">${esc(it.sku)}</span>
        <span class="auto-log-msg">${esc(it.msg)}</span>
      </div>`
    ).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }
  function buildFullLog(batchLogs) {
    return _currentSkus.map((sku, i) => {
      if (i < _stoppedAt) return { sku, msg: '✅ Hoàn thành', state: 'done' };
      const found = batchLogs.find(l => l.sku === sku);
      return found || { sku, msg: '— chờ', state: 'wait' };
    });
  }

  // ── XÓA ──
  function doClear() {
    if (_running) { try { storageSet({ status: 'stop' }); } catch(e) {} }
    detachListener();
    clearRunStorage();
    pasteArea.value          = '';
    logEl.innerHTML          = '';
    progressText.textContent = '';
    typeBadge.style.display  = 'none';
    typeBadge.textContent    = '';
    skuCountEl.textContent   = '';
    metaBar.style.display    = 'none';
    emptyState.style.display = 'flex';
    noTabWarn.style.display  = 'none';
    _currentSkus = []; _stoppedAt = 0; _isStopped = false; _running = false; _batchLogs = [];
    _completedPendingClear = false;
    renderFooter();
  }

  // ── CHẠY ──
  async function startRun() {
    _currentSkus = parseSkus();
    if (_currentSkus.length === 0) {
      pasteArea.style.borderColor = '#e53935';
      setTimeout(() => { pasteArea.style.borderColor = ''; }, 1500);
      return;
    }
    if (!findSearchInput() && !document.querySelector(ORDER_LIST_SELECTOR)) {
      checkReady();
      return;
    }
    const skusToRun = _currentSkus.slice(_stoppedAt);
    if (skusToRun.length === 0) {
      progressText.textContent = '✅ Tất cả đã hoàn thành';
      return;
    }
    _running   = true;
    _isStopped = false;
    _batchLogs = [];
    _runStartTime = performance.now();
    _completedPendingClear = false;
    noTabWarn.style.display = 'none';
    renderFooter();
    renderLog(buildFullLog([]));
    progressText.textContent = `${_stoppedAt} / ${_currentSkus.length}`;
    const type = typeBadge.textContent || 'MANUAL';
    try {
      // Vẫn ghi vào GM storage để restoreState() phục hồi được nếu người dùng reload trang
      // giữa chừng — nhưng KHÔNG dùng nó để "trigger" runAutoSearch nữa (gọi thẳng bên dưới),
      // vì UI và logic chạy giờ đã chung 1 context, không cần đi vòng qua storage-listener.
      storageSet({ skus: skusToRun, type, status: 'running', logs: [], current: 0 });
      attachListener();
      runAutoSearch(skusToRun, type);
    } catch (e) {
      setTabStatus('err', 'Lỗi: ' + e.message);
      _running = false;
      renderFooter();
    }
  }

  // ── DỪNG ──
  async function stopRun() {
    requestStop(); // gọi thẳng cờ dừng trong cùng context, không cần đi vòng qua storage nữa
    progressText.textContent = '⏳ Đang dừng — chờ SKU hiện tại hoàn thành...';
  }

  // ── NHẬN CẬP NHẬT TIẾN TRÌNH TRỰC TIẾP (chạy khi đang có batch) ──
  // Trước đây phần này lắng nghe qua GM_addValueChangeListener (giống popup <-> content
  // trong bản extension gốc), nhưng vì giờ chạy chung 1 script/1 context nên nhận thẳng
  // qua setProgressCallback — đồng bộ, không trễ, không bị dồn/rớt sự kiện.
  function attachListener() {
    detachListener();
    setProgressCallback((logs, current, status) => {
      if (logs !== undefined) {
        _batchLogs = logs;
        const done = _stoppedAt + logs.filter(l => l.state === 'done').length;
        progressText.textContent = `${done} / ${_currentSkus.length}`;
        renderLog(buildFullLog(logs));
      }

      if (status === 'done') {
        const doneCount = _stoppedAt + (logs || []).filter(l => l.state === 'done').length;
        const total     = _currentSkus.length;
        const elapsed   = formatDuration(performance.now() - _runStartTime);
        _running = false; _isStopped = false; _stoppedAt = 0; _batchLogs = [];
        _completedPendingClear = true;
        progressText.textContent = `✅ Hoàn thành tất cả ${doneCount}/${total} — ${elapsed}`;
        detachListener();
        renderFooter();
        clearRunStorage();
      }

      if (status === 'stopped') {
        const batchDone = (_batchLogs || []).filter(l => l.state === 'done').length;
        _stoppedAt = _stoppedAt + batchDone;
        _running = false; _isStopped = true;
        progressText.textContent = `⛔ Đã dừng — ${_stoppedAt}/${_currentSkus.length} SKU`;
        detachListener();
        renderFooter();
        renderLog(buildFullLog(_batchLogs));
      }
    });
  }
  function detachListener() {
    setProgressCallback(null);
  }

  // ── NHẬN SKU TỪ NGUỒN NGOÀI (vd Google Sheets) ──
  async function loadFromStorage() {
    try {
      const data = storageGet(['popupSkus', 'popupType']);
      if (data.popupSkus?.length > 0) {
        applyIncomingSkus(data.popupSkus, data.popupType || '');
        storageRemove(['popupSkus', 'popupType']);
      }
    } catch(e) {}
  }
  function applyIncomingSkus(skus, type) {
    pasteArea.value        = skus.join('\n');
    _currentSkus           = skus;
    _stoppedAt              = 0;
    _isStopped              = false;
    _batchLogs              = [];
    skuCountEl.textContent = `${skus.length} SKU`;
    if (type) { typeBadge.textContent = type; typeBadge.style.display = 'inline-block'; }
    emptyState.style.display = 'none';
    renderLog(skus.map(sku => ({ sku, msg: '— chờ chạy', state: 'wait' })));
    metaBar.style.display = 'flex';
    renderFooter();
  }
  onStorageChanged((changes) => {
    if (_running) return;
    if (changes.popupSkus) {
      const skus = changes.popupSkus.newValue || [];
      const type = changes.popupType?.newValue || '';
      if (skus.length > 0) {
        applyIncomingSkus(skus, type);
        storageRemove(['popupSkus', 'popupType']);
      }
    }
  });

  // ── RESTORE STATE KHI MỞ PANEL LẠI ──
  async function restoreState() {
    try {
      const data = storageGet(STORAGE_RUN_KEYS);
      const { skus, type, status, logs } = data;

      if (!status || status === 'idle' || status === 'done' || !skus || skus.length === 0) {
        clearRunStorage();
        return;
      }

      pasteArea.value         = skus.join('\n');
      _currentSkus            = skus;
      skuCountEl.textContent  = `${skus.length} SKU`;
      if (type) { typeBadge.textContent = type; typeBadge.style.display = 'inline-block'; }
      emptyState.style.display = 'none';
      metaBar.style.display    = 'flex';

      if (status === 'running') {
        _batchLogs = logs || [];
        const batchDone = _batchLogs.filter(l => l.state === 'done').length;
        _stoppedAt = batchDone;
        _running   = false;
        _isStopped = true;
        progressText.textContent = `⛔ Đã dừng — ${_stoppedAt}/${_currentSkus.length} SKU`;
        renderLog(buildFullLog(_batchLogs));
        renderFooter();
        attachListener();

      } else if (status === 'stopped') {
        _batchLogs = logs || [];
        const batchDone = _batchLogs.filter(l => l.state === 'done').length;
        _stoppedAt = batchDone;
        _running   = false;
        _isStopped = true;
        progressText.textContent = `⛔ Đã dừng — ${_stoppedAt}/${_currentSkus.length} SKU`;
        renderLog(buildFullLog(_batchLogs));
        renderFooter();
      }
    } catch(e) {}
  }

  /* ============================================================
   *  6. PHÍM TẮT ĐỘNG (run / stop / toggle panel)
   * ============================================================ */
  const DEFAULT_KEYS = {
    run:    { code: 'Space',  ctrl: true,  shift: false, alt: false, label: 'Ctrl+Space' },
    stop:   { code: 'Escape', ctrl: false, shift: false, alt: false, label: 'Escape' },
    toggle: { code: 'KeyS',   ctrl: false, shift: true,  alt: true,  label: 'Alt+Shift+S' },
  };
  let _hotkeys   = { run: {...DEFAULT_KEYS.run}, stop: {...DEFAULT_KEYS.stop}, toggle: {...DEFAULT_KEYS.toggle} };
  let _capturing = null;

  async function loadHotkeys() {
  
      try {
  
          const saved = GM_getValue('hotkeys', null);
  
          if (saved?.run?.code)
              _hotkeys.run = saved.run;
  
          if (saved?.stop?.code)
              _hotkeys.stop = saved.stop;
  
          if (saved?.toggle?.code)
              _hotkeys.toggle = saved.toggle;
  
      } catch(e){}
  
      syncHotkeyUI();
  }
  function syncHotkeyUI() {
    const map = { run: 'misaas-keyRun', stop: 'misaas-keyStop', toggle: 'misaas-keyToggle' };
    const hintMap = { run: 'misaas-hintRun', stop: 'misaas-hintStop', toggle: 'misaas-hintToggle' };
    Object.keys(map).forEach(k => {
      const el = document.getElementById(map[k]);
      if (el) el.textContent = _hotkeys[k].label;
      const hint = document.getElementById(hintMap[k]);
      if (hint) hint.textContent = _hotkeys[k].label;
    });
  }
  function saveHotkeys() { GM_setValue('hotkeys', _hotkeys); }

  function matchHotkey(e, hk) {
      return e.code === hk.code
          && e.ctrlKey === hk.ctrl
          && e.shiftKey === hk.shift
          && e.altKey === hk.alt;
  }

  // Keydown: hotkeys (run/stop chỉ có tác dụng khi panel đang mở — giống việc phải mở popup mới bấm nút trong bản gốc)
  // Đăng ký ở CAPTURE PHASE (tham số cuối = true) và trên cả window lẫn document:
  // input "Tìm kiếm thông minh" của MISA là 1 component autocomplete, rất hay tự
  // bắt phím Escape rồi gọi stopPropagation() để đóng dropdown riêng — nếu mình
  // nghe ở bubble phase (mặc định) thì sự kiện không bao giờ tới được listener này.
  // Nghe ở capture phase giúp mình chặn được sự kiện SỚM HƠN, trước khi MISA kịp chặn.
  function handleGlobalHotkey(e) {
    if (_capturing) return;
    if (matchHotkey(e, _hotkeys.toggle)) { e.preventDefault(); e.stopPropagation(); togglePanel(); return; }
    const panel = document.getElementById('misaas-panel');
    if (!panel || !panel.classList.contains('misaas-open')) return;
    if (matchHotkey(e, _hotkeys.stop) && _running)  { e.preventDefault(); e.stopPropagation(); stopRun();  return; }
    // Không chạy gì cả -> Esc dùng để ĐÓNG panel thay vì dừng (không có gì để dừng)
    if (matchHotkey(e, _hotkeys.stop) && !_running) { e.preventDefault(); e.stopPropagation(); togglePanel(false); return; }
    if (matchHotkey(e, _hotkeys.run)  && !_running) { e.preventDefault(); e.stopPropagation(); startRun(); return; }
  }
  document.addEventListener('keydown', handleGlobalHotkey, true);

  // Key capture
  function startCapture(which) {
    _capturing = which;
    const idMap = { run: 'misaas-keyRun', stop: 'misaas-keyStop', toggle: 'misaas-keyToggle' };
    const el = document.getElementById(idMap[which]);
    el.textContent = '[ nhấn phím... ]';
    el.classList.add('capturing');
  }
  function stopCapture() {
    if (!_capturing) return;
    const idMap = { run: 'misaas-keyRun', stop: 'misaas-keyStop', toggle: 'misaas-keyToggle' };
    document.getElementById(idMap[_capturing]).classList.remove('capturing');
    _capturing = null;
  }

  document.addEventListener('keydown', (e) => {
    if (!_capturing) return;
    if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey)   parts.push('Alt');
    const keyLabel = e.key === ' ' ? 'Space' : e.key;
    parts.push(keyLabel);
    const label = parts.join('+');
    _hotkeys[_capturing] = { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, label };
    syncHotkeyUI();
    stopCapture();
    saveHotkeys();
  }, true);

  document.addEventListener('click', (e) => {
    if (_capturing && !e.target.classList.contains('key-display')) stopCapture();
  });

  /* ============================================================
   *  7. TOGGLE PANEL / LAUNCHER / MENU COMMAND
   * ============================================================ */
  function togglePanel(forceState) {
    const panel = document.getElementById('misaas-panel');
    if (!panel) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !panel.classList.contains('misaas-open');

    // Vừa chạy xong hoàn tất trước đó (không phải bị dừng giữa chừng) và giờ người dùng
    // ĐÓNG panel lại -> dọn sạch ô nhập + log ngay lúc này, để lần mở sau là trạng thái trắng.
    if (!shouldOpen && _completedPendingClear) {
      doClear();
    }

    panel.classList.toggle('misaas-open', shouldOpen);
    // Set thêm inline style trực tiếp — CSP style-src (nếu có) không chặn được CSSOM,
    // nên dòng này đảm bảo show/hide luôn ăn dù stylesheet ngoài có bị chặn hay không.
    panel.style.display = shouldOpen ? 'flex' : 'none';
    if (shouldOpen) {
      checkReady();
      // Focus thẳng vào ô nhập SKU ngay khi mở panel lên, khỏi phải bấm chuột vào trước.
      if (pasteArea) setTimeout(() => pasteArea.focus(), 0);
    }
  }

  /* ============================================================
   *  8. BIND EVENTS + TAB SWITCHING + INIT
   * ============================================================ */
  function bindEvents() {
    pasteArea.addEventListener('input', updateSkuCount);
    document.getElementById('misaas-closeBtn').addEventListener('click', () => togglePanel(false));

    document.getElementById('misaas-tabBtnMain').addEventListener('click', () => {
      document.getElementById('misaas-tabBtnMain').classList.add('active');
      document.getElementById('misaas-tabBtnSettings').classList.remove('active');
      document.getElementById('misaas-panelMain').style.display = 'flex';
      document.getElementById('misaas-panelSettings').style.display = 'none';
    });
    document.getElementById('misaas-tabBtnSettings').addEventListener('click', () => {
      document.getElementById('misaas-tabBtnSettings').classList.add('active');
      document.getElementById('misaas-tabBtnMain').classList.remove('active');
      document.getElementById('misaas-panelMain').style.display = 'none';
      document.getElementById('misaas-panelSettings').style.display = 'flex';
    });

    document.getElementById('misaas-keyRun').addEventListener('click',    () => startCapture('run'));
    document.getElementById('misaas-keyStop').addEventListener('click',   () => startCapture('stop'));
    document.getElementById('misaas-keyToggle').addEventListener('click', () => startCapture('toggle'));

    document.getElementById('misaas-resetRun').addEventListener('click', () => {
      _hotkeys.run = {...DEFAULT_KEYS.run}; syncHotkeyUI(); saveHotkeys();
    });
    document.getElementById('misaas-resetStop').addEventListener('click', () => {
      _hotkeys.stop = {...DEFAULT_KEYS.stop}; syncHotkeyUI(); saveHotkeys();
    });
    document.getElementById('misaas-resetToggle').addEventListener('click', () => {
      _hotkeys.toggle = {...DEFAULT_KEYS.toggle}; syncHotkeyUI(); saveHotkeys();
    });
  }

  async function init() {
    injectPanelHTML();
    cacheRefs();
    bindEvents();
    await restoreState();
    await loadFromStorage();
    await loadHotkeys();
    checkReady();
    renderFooter();

    GM_registerMenuCommand('🚀 Mở Auto Search MISA', () => togglePanel(true));

    console.log('[MISA AutoSearch] v1.0.2 sẵn sàng trên', location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
