// ==UserScript==
// @name         TikTok Web - COPY - PASTE ẢNH
// @namespace    tiktok-clipboard-paste
// @version      1.0
// @description  Ctrl+V ảnh -> bấm nút đính kèm -> ảnh tự bơm vào -> tự động bấm Gửi, không cần thao tác thêm
// @author       VTV
// @match        *://*.tiktok.com/*
// @all-frames   true
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/tiktok-clipboard-paste.user.js
// @downloadURL  https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/tiktok-clipboard-paste.user.js
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[TT-Paste]';
  let pendingFiles = [];
  let toastEl = null;

  // ---------- Popup nhỏ ----------
  function ensureStyle() {
    if (document.getElementById('tt-paste-style')) return;
    const style = document.createElement('style');
    style.id = 'tt-paste-style';
    style.textContent = `
      .tt-paste-toast {
        position: fixed; z-index: 2147483647;
        background: #1c1c1e; color: #fff;
        padding: 8px 14px; border-radius: 8px;
        font-size: 13px; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.12);
        display: flex; align-items: center; gap: 8px;
        pointer-events: none; max-width: 300px;
        animation: tt-paste-fade-in 0.15s ease-out;
      }
      .tt-paste-toast .dot { width: 8px; height: 8px; border-radius: 50%; background: #25F4EE; flex: none; }
      @keyframes tt-paste-fade-in { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; transform: translateY(0);} }
      @keyframes tt-paste-fade-out { from { opacity: 1;} to { opacity: 0;} }
    `;
    document.head.appendChild(style);
  }

  function removeToast() {
    if (!toastEl) return;
    const el = toastEl; toastEl = null;
    el.style.animation = 'tt-paste-fade-out 0.2s ease-in forwards';
    setTimeout(() => el.remove(), 200);
  }

  function showToast(text, anchorEl) {
    ensureStyle();
    removeToast();
    const toast = document.createElement('div');
    toast.className = 'tt-paste-toast';
    toast.innerHTML = `<span class="dot"></span><span>${text}</span>`;
    document.body.appendChild(toast);
    toastEl = toast;

    let top, left;
    try {
      const rect = anchorEl?.getBoundingClientRect?.();
      if (rect && rect.width > 0) {
        top = rect.top - toast.offsetHeight - 10;
        left = rect.left;
        if (top < 8) top = rect.bottom + 10;
      }
    } catch (e) {}
    if (top === undefined) { top = window.innerHeight - 70; left = window.innerWidth - 320; }
    toast.style.top = `${Math.max(8, top)}px`;
    toast.style.left = `${Math.max(8, left)}px`;

    setTimeout(() => { if (toastEl === toast) removeToast(); }, 5000);
  }

  // ---------- Bắt Ctrl+V ----------
  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items;
    if (!items) return;

    const rawImages = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) rawImages.push(f);
      }
    }
    if (rawImages.length === 0) return; // không có ảnh -> để mặc định xử lý

    pendingFiles = rawImages.map((raw, i) => {
      const ext = (raw.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([raw], `clipboard-image-${i + 1}.${ext}`, { type: raw.type });
    });

    console.log(TAG, `Đã lưu ${pendingFiles.length} ảnh từ clipboard, chờ bạn bấm nút đính kèm.`);
    showToast(
      pendingFiles.length > 1
        ? `📎 Nhấn vào nút đính kèm để gửi ${pendingFiles.length} hình`
        : '📎 Nhấn vào nút đính kèm để gửi hình',
      e.target || document.activeElement
    );

    e.preventDefault();
  }, true);

  // ---------- Tìm nút Gửi bằng heuristic ----------
  const SEND_MEDIA_BTN_SELECTOR = '[data-e2e="dm-new-send-media-btn"]';

  function findSendButton(root = document) {
    // Ưu tiên selector chính xác đã xác nhận
    const exact = root.querySelector(SEND_MEDIA_BTN_SELECTOR);
    if (exact) return exact;

    // Dự phòng: heuristic, phòng khi TikTok đổi giao diện
    const candidates = root.querySelectorAll('button, div[role="button"]');
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const e2e = (el.getAttribute('data-e2e') || '').toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      if (
        label.includes('gửi') || label.includes('send') ||
        e2e.includes('send') ||
        text.includes('gửi') || text.includes('send')
      ) {
        if (e2e.includes('media-btn') && !e2e.includes('send-media-btn')) continue; // loại nút đính kèm
        if (e2e.includes('emoji-btn')) continue;
        return el;
      }
    }
    return null;
  }

  // ---------- Sau khi ảnh được bơm vào input, rình DOM để tự bấm nút Gửi ----------
  function waitAndAutoSend() {
    const start = Date.now();
    const TIMEOUT_MS = 4000;

    const tryClickSend = () => {
      const btn = findSendButton();
      if (btn) {
        console.log(TAG, 'Tìm thấy nút Gửi, tự động bấm:', btn.outerHTML.slice(0, 200));
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    };

    if (tryClickSend()) return;

    const observer = new MutationObserver(() => {
      if (tryClickSend()) {
        observer.disconnect();
      } else if (Date.now() - start > TIMEOUT_MS) {
        observer.disconnect();
        console.warn(TAG, 'Không tự tìm được nút Gửi trong', TIMEOUT_MS, 'ms. Cần bấm tay, hoặc gửi outerHTML của nút Gửi để mình chỉnh selector chính xác.');
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }

  // ---------- Chặn click() của input[type=file], bơm ảnh, rồi tự gửi ----------
  const OrigClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (...args) {
    if (this.type === 'file' && pendingFiles.length > 0) {
      console.log(TAG, `Bơm ${pendingFiles.length} ảnh clipboard vào input:`, this.outerHTML);

      const dt = new DataTransfer();
      pendingFiles.forEach(f => dt.items.add(f));

      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (desc && desc.set) desc.set.call(this, dt.files);
      else this.files = dt.files;

      pendingFiles = [];
      removeToast();
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));

      waitAndAutoSend();
      return; // không mở hộp thoại OS
    }
    return OrigClick.apply(this, args);
  };

  console.log(TAG, 'Đã sẵn sàng trong frame:', location.href);
})();