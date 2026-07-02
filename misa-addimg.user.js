// ==UserScript==
// @name         MISA ADD IMAGE
// @namespace    misa-addimg
// @version      1.0.0
// @description  Thêm cột hình ảnh vào đơn hàng
// @author       VTV
// @match        https://eshopapp.misa.vn/sale/pos*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/misa-addimg.user.js
// @downloadURL  https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/misa-addimg.user.js
// ==/UserScript==

(function () {
  const imageCache = {};
  const norm = (code) => (code || '').replace(/[-\s]/g, '').toUpperCase();

  // --- Lightbox (tạo 1 lần, dùng chung) ---
  const lightbox = document.createElement('div');
  lightbox.style.cssText = `
    display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85);
    z-index:999999; align-items:center; justify-content:center; cursor:zoom-out;
  `;
  const lightboxImg = document.createElement('img');
  lightboxImg.style.cssText = 'max-width:90vw; max-height:90vh; border-radius:8px; box-shadow:0 0 30px rgba(0,0,0,0.6);';
  lightbox.appendChild(lightboxImg);
  lightbox.addEventListener('click', () => { lightbox.style.display = 'none'; });
  document.body.appendChild(lightbox);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.style.display === 'flex') {
      lightbox.style.display = 'none';
    }
  });

  function openLightbox(url) {
    lightboxImg.src = url;
    lightbox.style.display = 'flex';
  }

  // --- Theo dõi dropdown gợi ý -> cache ảnh ---
  function watchDropdown() {
    const obs = new MutationObserver(() => {
      document.querySelectorAll('.inventory-item-info-wrapper').forEach(item => {
        const img = item.querySelector('.item-image img');
        const skuEl = item.querySelector('.sku-code');
        if (img && skuEl) {
          const code = norm(skuEl.innerText);
          if (code && img.src) imageCache[code] = img.src;
        }
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // --- Theo dõi dòng đơn hàng -> chèn ảnh + click để zoom ---
  function watchOrderRows() {
    const obs = new MutationObserver(() => {
      document.querySelectorAll('.list-item-in-order .row').forEach(row => {
        const codeEl = row.querySelector('.barcode .code');
        const nameLineEl = row.querySelector('.name > div:first-child');
        if (!codeEl || !nameLineEl) return;

        const code = norm(codeEl.innerText);
        const url = imageCache[code];
        if (!url) return;

        let img = row.querySelector('.custom-item-image');
        if (!img) {
          img = document.createElement('img');
          img.className = 'custom-item-image';
          img.style.cssText = `
            width:48px; height:48px; object-fit:cover; border-radius:6px;
            margin-right:8px; flex-shrink:0; cursor:zoom-in;
            border:1px solid rgba(255,255,255,0.15); transition:transform 0.15s;
          `;
          img.addEventListener('mouseenter', () => img.style.transform = 'scale(1.05)');
          img.addEventListener('mouseleave', () => img.style.transform = 'scale(1)');
          img.addEventListener('click', (e) => {
            e.stopPropagation(); // tránh ảnh hưởng tới việc chọn dòng của MISA
            openLightbox(img.src);
          });
          nameLineEl.prepend(img);
        }
        if (img.src !== url) img.src = url;
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  watchDropdown();
  watchOrderRows();
})();