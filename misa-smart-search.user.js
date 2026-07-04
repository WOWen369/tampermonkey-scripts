// ==UserScript==
// @name         MISA SMART SEARCH - VTV
// @namespace    misa-smart-search
// @version      1.0
// @description  Am tham "bat" API list-combo + get-inventory-quantity-by-stock cua MISA de lay san pham + TON KHO dong bo nhau ngay lap tuc (khong con doi "nghe lom"). Sua loi ton kho bi ket o "-" vinh vien. Thay watchdog-polling 2.5s bang property-setter trap de tra dung tu khoa 100% ke ca khi chon tu dropdown rieng cua script. Tai list-combo kieu lazy (chi trang 1 mac dinh) + goi ton kho song song theo batch de giam tai va tang toc. FIX v6.0: (1) khi tu click item o dropdown tu ve, dung MutationObserver de bam item NGAY khi xuat hien (khong con poll 100ms) va LUON tra lai tu khoa goc ngay lap tuc du thanh cong hay het gio (khong con ket o barcode). (2) Chu dong lam giau PRODUCT_CACHE theo nhieu huong (bo tu dau/cuoi, tach token dac trung co so) va tu dong tai het cac trang con lai NGAM ngay khi dang go/dan tu khoa - khong con phu thuoc MISA bao "rong" moi kich hoat goi y, nen ca truong hop MISA tra ve sai/thieu (vd chi 1 sp) van co goi y dung. Ctrl+Space gio doc thang tu cache (tra ve tuc thi, realtime), chi du phong goi mang khi cache thuc su chua kip co du lieu. FIX v6.1 (root cause that su cua loi mat tu khoa): dropdown tu ve gio CHOT tu khoa (dropdownKeywordSnapshot) mot lan duy nhat ngay luc mo dropdown, dung cho ca click chuot lan Enter - khong con doc lai input.value tai thoi diem chon nua, vi trong luc dropdown dang mo (vd nguoi dung keo scroll xem het danh sach) MISA co the tu y xoa input.value ve rong, khien ban cu doc nham chuoi rong va VO TINH BO QUA LUON buoc phuc hoi tu khoa (do chuoi rong la falsy).
// @author       VTV
// @match        https://eshopapp.misa.vn/sale/pos*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/misa-smart-search.user.js
// @downloadURL  https://raw.githubusercontent.com/WOWen369/tampermonkey-scripts/main/misa-smart-search.user.js
// ==/UserScript==

(function () {
  'use strict';

  const INPUT_SELECTOR = 'input[shortkey-target="searchProduct"]';
  const LIST_COMBO_PATH = '/g2/api/di/InventoryItems/list-combo';
  const STOCK_PATH = '/g2/api/business/InventoryQuantitys/get-inventory-quantity-by-stock';
  const STOCK_BATCH_SIZE = 100; // so luong inventory_item_id gui trong 1 lan goi ngam ton kho

  // Trang dau tien luon tai ngay (du bao phu da so truong hop). Cac trang sau CHI tai
  // "lazy" khi thuc su can (xem loadNextPageIfAvailable / prepareSuggestion) - FIX 1.5.
  // v1.0: tang take 300 -> 500 va giam so trang toi da 4 -> 2 (van ~1500 sp/tu khoa goc,
  // nhung it round-trip mang hon, giam nguy co Ctrl+Space rơi dung luc trang giua dang bay ve.
  const BACKGROUND_TAKE = 500;
  const MAX_BACKGROUND_PAGES = 3; // chan an toan: toi da 3 trang (~1500 sp) cho 1 tu khoa
  // FIX v1.0: tach rieng gioi han so lan LUI TU KHOA (prepareSuggestion) khoi so trang
  // mang (MAX_BACKGROUND_PAGES) - 2 khai niem khac nhau, khong nen dung chung 1 hang so
  // (truoc day dung chung MAX_BACKGROUND_PAGES nen khi giam trang mang 4->2 se vo tinh
  // lam giam luon so lan lui tu khoa, gay yeu di co che fallback).
  const MAX_KEYWORD_SHORTEN_STEPS = 4;

  const WAIT_PENDING_TIMEOUT_MS = 1500;

  // Luoi an toan tuyet doi cho property-setter trap (FIX vde 2): khong con y nghia "phai
  // du dai de kip watchdog" nhu truoc, chi la moc don dep cuoi cung phong truong hop khong
  // co tin hieu release nao khac xay ra. Moi lan MISA co ghi de trong luc nay deu bi chan
  // NGAY LAP TUC (0ms), khong con phu thuoc thoi diem polling nhu ban cu.
  const PROTECT_FALLBACK_MS = 5000;

  // Key luu vao sessionStorage de nho lai stock_id + headers TON KHO THAT giua cac lan go
  // tu khoa (va giua cac lan F5 trong cung 1 phien dang nhap) - FIX 1.2.
  const STOCK_SESSION_KEY = 'misaHelper_stockInfo_v1';

  const PRODUCT_CACHE = new Map(); // key: itemId, value: { itemId, barcode, name, nameNorm, tokens, price, image, inventoryItemId }

  // Cache ton kho. Su co mat trong Map nay = "DA CO DU LIEU" (ke ca gia tri 0), khac voi
  // "chua tung hoi" (khong co trong Map) - FIX 1.3: phan biet ro 2 trang thai nay.
  const STOCK_CACHE = new Map(); // key: inventory_item_id, value: { quantity, sellableQuantity }

  // Chong goi lap ton kho cho cung 1 id nhieu lan cung luc (dedupe khi dang cho ket qua).
  const STOCK_REQUESTED_IDS = new Set();

  // Thong tin request TON KHO THAT gan nhat (url/headers/stock_id) - dung de tu chu dong
  // goi ngam ton kho cho BAT KY batch sp nao, khong chi 20 sp MISA tu hien thi.
  let LAST_STOCK_REQUEST_INFO = null; // { url, headers, stockId }

  const RECENT_BACKGROUND_CALLS = new Map(); // key: filter string, value: timestamp
  const DEDUPE_WINDOW_MS = 800;

  const PENDING_PROMISES = new Map(); // key: filter string, value: Promise

  // Thong tin request list-combo THAT gan nhat (dung de "moi" them du lieu bang tu khoa
  // rut gon, va de biet dedupeKey nao dang load lazy o LOADED_PAGES).
  let LAST_REQUEST_INFO = null; // { url, headers, payload, keyword }

  // Trang thai load-lazy cho tung dedupeKey (tu khoa/filter) - FIX 1.5.
  // value: { skip, total, payload, url, headers, done }
  const LOADED_PAGES = new Map();

  // ================= Tien ich chung =================
  function removeDiacritics(str) {
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();
  }
  function tokenize(str) {
    return str.trim().split(/\s+/).filter(Boolean);
  }
  function formatPrice(num) {
    if (num === null || num === undefined || isNaN(num)) return '';
    return Math.round(Number(num))
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function getDbIdFromCookie() {
    const match = document.cookie.match(/(?:^|;\s*)_eshop_dbid=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function buildImageUrl(fileName) {
    if (!fileName) {
      return 'https://eshopapp.misa.vn/g2/api/file/files/image?type=1&name=default-img.png';
    }
    const dbId = getDbIdFromCookie();
    if (!dbId) return '';
    return `https://eshopappg2.misacdn.net/api/file/files/image.jpg?type=3&dbId=${dbId}&name=${fileName}`;
  }
  function safeParseJson(str) {
    try {
      return typeof str === 'string' ? JSON.parse(str) : str;
    } catch (e) {
      return null;
    }
  }
  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  function normalizeHeaders(rawHeaders) {
    const result = {};
    if (!rawHeaders) return result;
    if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        result[key.toLowerCase()] = value;
      });
      return result;
    }
    if (Array.isArray(rawHeaders)) {
      rawHeaders.forEach(([key, value]) => {
        result[String(key).toLowerCase()] = value;
      });
      return result;
    }
    Object.keys(rawHeaders).forEach((key) => {
      result[key.toLowerCase()] = rawHeaders[key];
    });
    return result;
  }

  // ================= FIX 1.2: luu/doc stock_id + headers qua sessionStorage =================
  // Muc dich: khong con phai phu thuoc "nghe lom" duoc 1 lan MISA tu goi API ton kho that
  // trong PHIEN HIEN TAI moi co the chu dong bu ton kho - neu phien truoc (cung tab) da
  // tung nghe duoc, dung lai luon tu dau, giam do tre "khoang trong khong co ton kho".
  function saveStockInfoToSession(info) {
    try {
      sessionStorage.setItem(STOCK_SESSION_KEY, JSON.stringify(info));
    } catch (e) {
      // sessionStorage co the bi chan (vi du che do rieng tu) - bo qua, khong anh huong
      // chuc nang chinh, chi mat di loi ich "nho lai giua cac lan F5".
    }
  }
  function loadStockInfoFromSession() {
    try {
      const raw = sessionStorage.getItem(STOCK_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  LAST_STOCK_REQUEST_INFO = loadStockInfoFromSession();

  // ================= Chuyen doi 1 record tu API JSON -> object cache =================
  // Mapping da doi chieu voi DOM that cua MISA (khung dropdown + khung gio hang), XAC NHAN DUNG:
  //   - itemId  = field "barcode" (dang KHONG dau gach) -> dung de khop hau to DOM "-item-{id}"
  //   - barcode (dien vao o search) = field "sku_code" (dang CO dau gach) -> trung voi ma
  //     hien thi that tren UI dropdown va tren dong hang trong gio hang cua MISA.
  //   - inventoryItemId = field "inventory_item_id" (uuid) -> khop truc tiep voi ton kho.
  function mapApiItemToCacheEntry(item) {
    if (!item || !item.inventory_item_name) return null;
    const itemId = item.barcode || item.inventory_item_id;
    const searchBarcode = item.sku_code || item.barcode;
    if (!itemId || !searchBarcode) return null;

    const name = item.inventory_item_name;
    const nameNorm = removeDiacritics(name);
    return {
      itemId,
      barcode: searchBarcode,
      name,
      price: formatPrice(item.unit_price),
      image: buildImageUrl(item.file_name),
      nameNorm,
      tokens: tokenize(nameNorm),
      inventoryItemId: item.inventory_item_id || item.inventoryItemId || item.id || null,
    };
  }

  // Tra ve them danh sach inventoryItemId MOI duoc them (de FIX 1.1: goi ngam ton kho
  // NGAY LAP TUC theo dung batch nay, khong doi quet lai toan cuc).
  function mergeItemsIntoCache(items) {
    if (!Array.isArray(items)) return { addedCount: 0, addedInventoryIds: [] };
    let addedCount = 0;
    const addedInventoryIds = [];
    items.forEach((raw) => {
      const entry = mapApiItemToCacheEntry(raw);
      if (!entry) return;
      const isNew = !PRODUCT_CACHE.has(entry.itemId);
      PRODUCT_CACHE.set(entry.itemId, entry);
      if (isNew) {
        addedCount++;
        if (entry.inventoryItemId) addedInventoryIds.push(entry.inventoryItemId);
      }
    });
    return { addedCount, addedInventoryIds };
  }

  // ================= FIX 1.1 + 1.3 + 1.4: goi ngam ton kho chu dong, song song, doi chieu ro =================
  // reconcileStockBatch: doi chieu DUNG danh sach id da GUI DI voi id THUC SU co trong
  // response. Id nao khong co trong response (vi du sp khong ton tai o kho stock_id nay)
  // se duoc set TUONG MINH quantity=0/sellable=0 - khong con bi "treo" o trang thai
  // "chua ro" (hien thi "-") mai mai nhu ban cu.
  function reconcileStockBatch(requestedIds, responseList) {
    const returned = new Set();
    if (Array.isArray(responseList)) {
      responseList.forEach((raw) => {
        if (!raw || !raw.inventory_item_id) return;
        STOCK_CACHE.set(raw.inventory_item_id, {
          quantity: raw.quantity,
          sellableQuantity: raw.sellable_quantity,
        });
        returned.add(raw.inventory_item_id);
      });
    }
    requestedIds.forEach((id) => {
      if (!returned.has(id)) {
        STOCK_CACHE.set(id, { quantity: 0, sellableQuantity: 0 });
      }
    });
  }

  // Chu dong goi ngam ton kho cho 1 danh sach inventory_item_id CU THE (vd: vua lay tu 1
  // trang list-combo). Chay cac batch SONG SONG (Promise.all) - FIX 1.4, thay vi tuan tu.
  async function fetchStockForIds(ids) {
    if (!LAST_STOCK_REQUEST_INFO || !LAST_STOCK_REQUEST_INFO.stockId) return; // chua tung biet stock_id nao - se tu bu lai sau khi hoc duoc (xem mergeStockFromRealResponse)
    const toFetch = [];
    (ids || []).forEach((id) => {
      if (!id) return;
      if (STOCK_CACHE.has(id)) return;
      if (STOCK_REQUESTED_IDS.has(id)) return;
      toFetch.push(id);
    });
    if (toFetch.length === 0) return;
    toFetch.forEach((id) => STOCK_REQUESTED_IDS.add(id));

    const { url, headers, stockId } = LAST_STOCK_REQUEST_INFO;
    const baseHeaders = normalizeHeaders(headers);
    if (!baseHeaders['content-type']) baseHeaders['content-type'] = 'application/json';
    const batches = chunkArray(toFetch, STOCK_BATCH_SIZE);

    await Promise.all(
      batches.map(async (batch) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify({ list_combo_id: [], list_inventory_item_id: batch, stock_id: stockId }),
            credentials: 'same-origin',
          });
          if (res.ok) {
            const data = await res.json();
            reconcileStockBatch(batch, data);
          } else {
            batch.forEach((id) => STOCK_REQUESTED_IDS.delete(id)); // that bai -> cho co hoi thu lai sau
          }
        } catch (e) {
          batch.forEach((id) => STOCK_REQUESTED_IDS.delete(id));
          console.warn('[MISA-Helper] Loi khi goi ngam bu ton kho:', e);
        }
      })
    );
  }

  // Quet toan cuc PRODUCT_CACHE tim id con thieu (luoi an toan bo sung, phong truong hop
  // 1 sp lot qua khoi FIX 1.1 vi ly do nao do - vd duoc them vao cache truoc khi biet stock_id).
  function fetchMissingStockInBackground() {
    if (!LAST_STOCK_REQUEST_INFO || !LAST_STOCK_REQUEST_INFO.stockId) return;
    const missingIds = [];
    for (const p of PRODUCT_CACHE.values()) {
      const id = p.inventoryItemId;
      if (!id) continue;
      if (STOCK_CACHE.has(id)) continue;
      if (STOCK_REQUESTED_IDS.has(id)) continue;
      missingIds.push(id);
    }
    if (missingIds.length === 0) return;
    fetchStockForIds(missingIds);
  }

  // Duoc goi khi "nghe lom" duoc 1 response TON KHO THAT tu chinh MISA (khong phai do
  // script tu ban). requestedIds la danh sach id THAT da gui trong payload cua request do.
  function mergeStockFromRealResponse(requestedIds, list) {
    reconcileStockBatch(requestedIds || [], list);
    console.log('[MISA-Helper] Da nhan ton kho THAT tu MISA cho', (requestedIds || []).length, 'sp. Tong STOCK_CACHE:', STOCK_CACHE.size);
    // Vua hoc/xac nhan lai stock_id hop le -> nhan tien bu ngay cho cac sp con thieu.
    fetchMissingStockInBackground();
  }

  // ================= FIX 1.5: tai list-combo kieu LAZY (mac dinh chi trang 1) =================
  function getDedupeKey(payload) {
    return payload.filter || JSON.stringify(payload);
  }

  function loadFirstPageInBackground(url, headers, payload) {
    const dedupeKey = getDedupeKey(payload);
    const now = Date.now();
    const lastCall = RECENT_BACKGROUND_CALLS.get(dedupeKey);
    if (lastCall && now - lastCall < DEDUPE_WINDOW_MS) {
      const existing = PENDING_PROMISES.get(dedupeKey);
      return existing || Promise.resolve();
    }
    RECENT_BACKGROUND_CALLS.set(dedupeKey, now);

    const baseHeaders = normalizeHeaders(headers);
    if (!baseHeaders['content-type']) baseHeaders['content-type'] = 'application/json';

    const work = (async () => {
      try {
        const pagePayload = Object.assign({}, payload, { skip: 0, take: BACKGROUND_TAKE });
        const res = await fetch(url, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(pagePayload),
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const data = await res.json();
        const { addedCount, addedInventoryIds } = mergeItemsIntoCache(data.Data);
        const total = data.Total || 0;
        LOADED_PAGES.set(dedupeKey, {
          skip: BACKGROUND_TAKE,
          total,
          payload,
          url,
          headers,
          done: BACKGROUND_TAKE >= total || !data.Data || data.Data.length === 0,
        });
        if (addedCount > 0) {
          console.log('[MISA-Helper] Nen (trang 1): +', addedCount, 'sp. Tong cache:', PRODUCT_CACHE.size);
          // FIX 1.1: goi ngam ton kho NGAY cho dung batch sp vua lay, khong doi bu sau.
          fetchStockForIds(addedInventoryIds);
          refreshOpenDropdownIfStale(); // FIX v1.0 (diem 2): cap nhat dropdown dang mo neu co
        }
        // FIX REALTIME: khong con doi "lazy tren-nhu-cau" khi nguoi dung bam Ctrl+Space
        // nua. Ngay khi biet con trang tiep theo, tu dong tai het cac trang con lai NGAM
        // O DAY (trong luc nguoi dung con dang go phim) de khi ho bam Ctrl+Space, cache
        // da san sang - tra ket qua tuc thi, khong con do tre goi mang.
        if (!LOADED_PAGES.get(dedupeKey).done) {
          loadRemainingPagesInBackground(dedupeKey);
        }
      } catch (e) {
        console.warn('[MISA-Helper] Loi khi goi ngam trang 1 list-combo:', e);
      }
    })();

    PENDING_PROMISES.set(dedupeKey, work);
    work.finally(() => {
      PENDING_PROMISES.delete(dedupeKey);
    });
    return work;
  }

  // Tu dong tai HET cac trang con lai (toi da MAX_BACKGROUND_PAGES) cho 1 dedupeKey,
  // chay ngam hoan toan. FIX v1.0 (diem 1): dang ky vao PENDING_PROMISES (voi key rieng,
  // khong trung key cua loadFirstPageInBackground) de waitForPendingBackgroundCalls BIET
  // DUNG la con dang tai trang tiep theo hay khong - truoc day vong lap nay chay "vo hinh",
  // khien Ctrl+Space tuong nham la "het viec can cho" trong khi trang 2 van dang bay ve.
  function loadRemainingPagesInBackground(dedupeKey) {
    const pendingKey = dedupeKey + '::morePages';
    const work = (async () => {
      let more = true;
      while (more) {
        more = await loadNextPageIfAvailable(dedupeKey).catch(() => false);
      }
    })();
    PENDING_PROMISES.set(pendingKey, work);
    work.finally(() => {
      PENDING_PROMISES.delete(pendingKey);
    });
    return work;
  }

  // Tai THEM 1 trang tiep theo cho 1 dedupeKey cu the - CHI duoc goi khi thuc su can
  // (vd: prepareSuggestion khong tim thay candidate nao o cac trang da co) - FIX 1.5.
  async function loadNextPageIfAvailable(dedupeKey) {
    const state = LOADED_PAGES.get(dedupeKey);
    if (!state || state.done) return false;
    if (state.skip >= MAX_BACKGROUND_PAGES * BACKGROUND_TAKE) {
      state.done = true;
      return false;
    }
    const baseHeaders = normalizeHeaders(state.headers);
    if (!baseHeaders['content-type']) baseHeaders['content-type'] = 'application/json';
    try {
      const pagePayload = Object.assign({}, state.payload, { skip: state.skip, take: BACKGROUND_TAKE });
      const res = await fetch(state.url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(pagePayload),
        credentials: 'same-origin',
      });
      if (!res.ok) return false;
      const data = await res.json();
      const { addedCount, addedInventoryIds } = mergeItemsIntoCache(data.Data);
      const total = data.Total || state.total;
      const newSkip = state.skip + BACKGROUND_TAKE;
      state.skip = newSkip;
      state.total = total;
      state.done = newSkip >= total || !data.Data || data.Data.length === 0;
      if (addedCount > 0) {
        console.log('[MISA-Helper] Nen (lazy trang tiep theo): +', addedCount, 'sp. Tong cache:', PRODUCT_CACHE.size);
        fetchStockForIds(addedInventoryIds); // FIX 1.1 ap dung ca cho trang lazy
        refreshOpenDropdownIfStale(); // FIX v1.0 (diem 2): cap nhat dropdown dang mo neu co
      }
      return addedCount > 0;
    } catch (e) {
      console.warn('[MISA-Helper] Loi khi tai lazy trang tiep theo:', e);
      return false;
    }
  }

  function handleInterceptedListCombo(url, headers, rawBody) {
    const payload = safeParseJson(rawBody);
    if (!payload || typeof payload !== 'object') return;

    const input = document.querySelector(INPUT_SELECTOR);
    const keyword = input ? input.value.trim() : '';
    LAST_REQUEST_INFO = { url, headers, payload, keyword };

    loadFirstPageInBackground(url, headers, payload);

    // FIX VAN DE 2 (lam giau cache da huong, khong cho ket qua sai/thieu cua MISA quyet
    // dinh co goi y hay khong): moi lan MISA tu search that (du tra ve 0, 1 hay nhieu sp),
    // ta CHU DONG bam them vai bien the tu khoa NGAM O DAY - ngay trong luc nguoi dung
    // con dang go/dan, KHONG cho Ctrl+Space moi bat dau. Nho vay khi nguoi dung bam
    // Ctrl+Space, cache da co san du lieu tu nhieu huong -> tra ket qua tuc thi (realtime).
    enrichCacheInBackground(url, headers, payload, keyword);
  }

  // ================= FIX VAN DE 2: lam giau cache theo nhieu huong, chay hoan toan ngam =================
  // Cat tu cuoi cung (giu dau cau).
  function shortenKeywordFromEnd(keyword) {
    const toks = keyword.trim().split(/\s+/).filter(Boolean);
    if (toks.length <= 1) return null;
    toks.pop();
    return toks.join(' ');
  }
  // Cat tu dau tien (phong truong hop tu gay loi search nam o DAU cum, khong phai cuoi).
  function shortenKeywordFromStart(keyword) {
    const toks = keyword.trim().split(/\s+/).filter(Boolean);
    if (toks.length <= 1) return null;
    toks.shift();
    return toks.join(' ');
  }
  // Tach rieng token "dac trung" nhat (uu tien token co chua chu so - thuong la ma mau/
  // ma hang, vd "vis15") de tu no tim ra toan bo sp lien quan, khong phu thuoc cac tu con lai.
  function getMostDistinctiveToken(keyword) {
    const toks = keyword.trim().split(/\s+/).filter(Boolean);
    if (toks.length <= 1) return null;
    const withDigit = toks.find((t) => /\d/.test(t));
    return withDigit || null;
  }

  // Bam song song (khong await, khong chan nhau, khong ai cho) vai bien the cua tu khoa
  // hien tai de "vet" them du lieu tu nhieu huong khac nhau vao PRODUCT_CACHE. Day la
  // "luoi an toan" cho ca 2 truong hop: (a) MISA tra rong, (b) MISA tra sai/thieu (vd chi
  // dung 1 sp do loi search cua MISA) - vi ta khong con phu thuoc vao viec MISA "bao rong"
  // moi kich hoat, ma luon chu dong lam giau cache o moi lan search that.
  function enrichCacheInBackground(url, headers, payload, keyword) {
    if (!keyword) return;
    const variants = new Set();
    const fromEnd = shortenKeywordFromEnd(keyword);
    if (fromEnd) variants.add(fromEnd);
    const fromStart = shortenKeywordFromStart(keyword);
    if (fromStart) variants.add(fromStart);
    const distinctive = getMostDistinctiveToken(keyword);
    if (distinctive) variants.add(distinctive);

    variants.forEach((variantKeyword) => {
      const variantPayload = buildPayloadForKeyword(payload, keyword, variantKeyword);
      loadFirstPageInBackground(url, headers, variantPayload); // fire-and-forget, chay song song
    });
  }

  // ================= Intercept fetch =================
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      let isStockCall = false;
      let requestedIdsForThisCall = [];
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
        const isPost = String(method).toUpperCase() === 'POST';
        if (url.includes(LIST_COMBO_PATH) && isPost) {
          const body = init && init.body;
          const headers = init && init.headers;
          handleInterceptedListCombo(url, headers, body);
        }
        if (url.includes(STOCK_PATH) && isPost) {
          isStockCall = true;
          const stockHeaders = init && init.headers;
          const stockBody = safeParseJson(init && init.body);
          if (stockBody) {
            requestedIdsForThisCall = Array.isArray(stockBody.list_inventory_item_id)
              ? stockBody.list_inventory_item_id
              : [];
            if (stockBody.stock_id) {
              LAST_STOCK_REQUEST_INFO = { url, headers: normalizeHeaders(stockHeaders), stockId: stockBody.stock_id };
              saveStockInfoToSession(LAST_STOCK_REQUEST_INFO); // FIX 1.2
            }
          }
        }
      } catch (e) {
        // khong de loi o day lam vo hieu request that cua trang
      }

      const fetchPromise = originalFetch.apply(this, arguments);

      if (isStockCall) {
        fetchPromise
          .then((res) => {
            try {
              res
                .clone()
                .json()
                .then((data) => mergeStockFromRealResponse(requestedIdsForThisCall, data))
                .catch(() => {});
            } catch (e) {
              // bo qua
            }
          })
          .catch(() => {});
      }

      return fetchPromise;
    };
  }

  // ================= Intercept XMLHttpRequest =================
  const OriginalOpen = XMLHttpRequest.prototype.open;
  const OriginalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const OriginalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__misaHelperMethod = method;
    this.__misaHelperUrl = url;
    this.__misaHelperHeaders = {};
    return OriginalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__misaHelperHeaders) this.__misaHelperHeaders[name] = value;
    return OriginalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__misaHelperUrl || '';
      const method = this.__misaHelperMethod || '';
      const isPost = String(method).toUpperCase() === 'POST';
      if (url.includes(LIST_COMBO_PATH) && isPost) {
        handleInterceptedListCombo(url, this.__misaHelperHeaders, body);
      }
      if (url.includes(STOCK_PATH) && isPost) {
        const stockBody = safeParseJson(body);
        const requestedIds = stockBody && Array.isArray(stockBody.list_inventory_item_id) ? stockBody.list_inventory_item_id : [];
        if (stockBody && stockBody.stock_id) {
          LAST_STOCK_REQUEST_INFO = { url, headers: normalizeHeaders(this.__misaHelperHeaders), stockId: stockBody.stock_id };
          saveStockInfoToSession(LAST_STOCK_REQUEST_INFO); // FIX 1.2
        }
        this.addEventListener('load', function () {
          try {
            const data = safeParseJson(this.responseText);
            mergeStockFromRealResponse(requestedIds, data);
          } catch (e) {
            // bo qua
          }
        });
      }
    } catch (e) {
      // khong de loi o day lam vo hieu request that cua trang
    }
    return OriginalSend.apply(this, arguments);
  };

  // ================= Thuat toan tim san pham lien quan trong cache (khong doi) =================
  function findCandidatesFromCache(userTokensNorm) {
    const candidates = [];
    for (const p of PRODUCT_CACHE.values()) {
      const usedIdx = new Set();
      const positions = [];
      let matchedAll = true;
      for (const tok of userTokensNorm) {
        let foundIdx = -1;
        for (let i = 0; i < p.tokens.length; i++) {
          if (usedIdx.has(i)) continue;
          if (p.tokens[i] === tok) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx === -1) {
          matchedAll = false;
          break;
        }
        usedIdx.add(foundIdx);
        positions.push(foundIdx);
      }
      if (matchedAll) {
        const startPos = Math.min(...positions);
        const span = Math.max(...positions) - startPos;
        candidates.push({ product: p, startPos, span });
      }
    }

    candidates.sort((a, b) => {
      if (a.startPos !== b.startPos) return a.startPos - b.startPos;
      if (a.span !== b.span) return a.span - b.span;
      return a.product.name.localeCompare(b.product.name);
    });

    return candidates.map((c) => c.product);
  }

  // ================= Xu ly race condition khi go qua nhanh toi tu khoa rong =================
  function buildPayloadForKeyword(basePayload, oldKeyword, newKeyword) {
    const copy = Object.assign({}, basePayload);
    if (typeof copy.filter === 'string' && oldKeyword) {
      copy.filter = copy.filter.split(oldKeyword).join(newKeyword);
    }
    return copy;
  }

  function triggerBackgroundForKeyword(newKeyword) {
    if (!LAST_REQUEST_INFO) return Promise.resolve();
    const { url, headers, payload, keyword } = LAST_REQUEST_INFO;
    const newPayload = buildPayloadForKeyword(payload, keyword, newKeyword);
    return loadFirstPageInBackground(url, headers, newPayload);
  }

  function waitForPendingBackgroundCalls(timeoutMs) {
    const promises = Array.from(PENDING_PROMISES.values());
    if (promises.length === 0) return Promise.resolve();
    const allSettled = Promise.allSettled(promises);
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return Promise.race([allSettled, timeout]);
  }

  let suggestionRequestId = 0;
  let currentSuggestionState = { promise: null, ready: true, items: null };

  // FIX REALTIME + FIX VAN DE 2: prepareSuggestion gio day uu tien tra loi TUC THI tu
  // PRODUCT_CACHE (da duoc lam giau san tu enrichCacheInBackground + loadRemainingPagesInBackground
  // ngay trong luc nguoi dung go/dan tu khoa - xem handleInterceptedListCombo). Chi khi
  // cache thuc su chua kip co du lieu (truong hop hiem, vd bam Ctrl+Space qua nhanh) moi
  // roi xuong cac buoc du phong co goi mang - chap nhan co do tre nho trong truong hop
  // hiem do, doi lay do chinh xac trong da so cac lan bam con lai la tuc thi.
  function prepareSuggestion(tokensNorm, currentKeyword) {
    const myId = ++suggestionRequestId;
    currentSuggestionState = { promise: null, ready: false, items: null };

    const finish = (result) => {
      currentSuggestionState.items = result;
      currentSuggestionState.ready = true;
      pendingSuggestion = result;
      return result;
    };

    // Buoc 1 (duong chinh - REALTIME): doc thang tu cache dang co trong bo nho, khong
    // goi mang, khong await gi ca. Da so truong hop se dung lai o day.
    let candidates = findCandidatesFromCache(tokensNorm);
    if (candidates.length > 0) {
      const result = finish(candidates);
      const resolved = Promise.resolve(result);
      currentSuggestionState.promise = resolved;
      return resolved;
    }

    // Tu day tro di la nhanh du phong (hiem gap), moi thuc su can await/goi mang.
    const promise = (async () => {
      // Buoc 2: cho ngan cac cuoc goi nen dang bay (KHONG kich hoat goi moi o day) phong
      // truong hop cache dang tren duong ve nhung chua kip toi.
      await waitForPendingBackgroundCalls(WAIT_PENDING_TIMEOUT_MS);
      if (myId !== suggestionRequestId) return null;
      candidates = findCandidatesFromCache(tokensNorm);

      // Buoc 3: neu van chua co, moi chu dong lui dan tu khoa (bo tu cuoi) VA LAP LAI
      // nhieu cap cho toi khi con 1 tu hoac tim duoc candidate - thay vi chi cat 1 cap
      // duy nhat nhu ban cu.
      let guard = 0;
      let shortKeyword = currentKeyword;
      while (candidates.length === 0 && guard < MAX_KEYWORD_SHORTEN_STEPS) {
        shortKeyword = shortenKeywordFromEnd(shortKeyword);
        if (!shortKeyword) break;
        await triggerBackgroundForKeyword(shortKeyword).catch(() => {});
        guard++;
        if (myId !== suggestionRequestId) return null;
        candidates = findCandidatesFromCache(tokensNorm);
      }

      return finish(candidates.length > 0 ? candidates : null);
    })();

    currentSuggestionState.promise = promise;
    return promise;
  }

  // ================= Ghi gia tri input theo cach Vue nhan duoc (dispatch input/change that) =================
  function setInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ================= FIX VAN DE 2: property-setter trap thay the watchdog-polling =================
  // Y tuong: thay vi "doan" xem cho bao lau la du (polling moi 80ms trong 2.5s co dinh),
  // ta chan TRUC TIEP tai nguon: bat ky lan nao MISA/Vue co GHI (set) lai input.value khac
  // voi tu khoa mong muon, ta chan va ep lai NGAY LAP TUC (0ms tre), bat ke no ghi de bao
  // nhieu lan hay vao thoi diem nao trong cua so bao ve. Khi nguoi dung THAT SU go phim
  // tiep (browser tu cap nhat value roi ban 'input' event that), ta giai phong bay ngay
  // lap tuc (xem attachToInput) - khong con can polling theo thoi gian nua.
  let activeProtectionRelease = null;

  function protectInputValue(input, desiredValue) {
    if (activeProtectionRelease) activeProtectionRelease(); // go bay cu (neu co) truoc khi gan bay moi

    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const nativeGet = desc.get;
    const nativeSet = desc.set;
    let active = true;

    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return nativeGet.call(input);
      },
      set(v) {
        if (active && v !== desiredValue) {
          nativeSet.call(input, desiredValue); // chan ghi de, ep lai dung tu khoa - NGAY LAP TUC
          return;
        }
        nativeSet.call(input, v);
      },
    });
    nativeSet.call(input, desiredValue); // dam bao gia tri hien thi dung ngay tu dau

    const release = () => {
      if (!active) return;
      active = false;
      try {
        delete input.value; // go thuoc tinh rieng -> tra lai getter/setter goc cua trinh duyet
      } catch (e) {
        // bo qua
      }
      if (activeProtectionRelease === release) activeProtectionRelease = null;
    };
    activeProtectionRelease = release;

    // Luoi don dep cuoi cung - KHONG con y nghia "phai du dai de kip bat MISA ghi de" nhu
    // watchdog cu, vi bay nay chan moi lan ghi NGAY LAP TUC bat ke thoi diem nao trong
    // khoang nay. Day chi la moc tu tha de tranh khoa input vinh vien neu thieu tin hieu.
    setTimeout(release, PROTECT_FALLBACK_MS);

    return release;
  }

  // Khi true: cac su kien mousedown/mouseup/click dang duoc chinh script TU BAN ra (gia lap
  // click vao item that de kich hoat MISA chon san pham) - listener bat click GOC cua MISA
  // can bo qua de tranh xu ly trung 2 lan.
  let SUPPRESS_NATIVE_CLICK_CAPTURE = false;

  // FIX VAN DE 1: cho item that xuat hien bang MutationObserver thay vi setInterval poll
  // 100ms - phan ung NGAY tai thoi diem DOM thuc su thay doi (khong con do tre nhan tao
  // cua chu ky poll). Neu item da co san truoc khi gan observer thi tra ve ngay lap tuc.
  function waitForItemElement(itemId, timeoutMs) {
    return new Promise((resolve) => {
      const selector = `[id$="-item-${CSS.escape(itemId)}"]`;

      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timer);
      };

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          cleanup();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
    });
  }

  // ================= Fill barcode that -> doi MISA render item that -> tu click =================
  function selectRealItem(input, itemId, barcode, originalKeyword) {
    setInputValue(input, barcode); // barcode la duy nhat, chac chan MISA search ra dung 1 sp

    const restoreKeyword = () => {
      // FIX VAN DE 1: luon tra lai tu khoa goc NGAY LAP TUC, khong phu thuoc viec co tim
      // thay item hay khong - tranh truong hop o search bi ket vinh vien o gia tri barcode
      // khi khong tim thay item (het 3s).
      if (typeof originalKeyword === 'string' && originalKeyword) {
        protectInputValue(input, originalKeyword);
      }
    };

    waitForItemElement(itemId, 3000).then((el) => {
      if (el) {
        SUPPRESS_NATIVE_CLICK_CAPTURE = true;
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        setTimeout(() => {
          SUPPRESS_NATIVE_CLICK_CAPTURE = false;
        }, 0);
        // FIX vde 2 (cu): gan bay ngay sau click - khong can dem thoi gian, moi lan Vue co
        // ghi de sau day (du som hay muon, du bao nhieu lan) deu bi chan ngay lap tuc.
        restoreKeyword();
      } else {
        console.warn('[MISA-Helper] Khong tim thay item that de tu click:', itemId, barcode);
        restoreKeyword();
      }
    });
  }

  // ================= Bat click THAT cua nguoi dung tren danh sach goi y GOC cua MISA =================
  function attachNativeItemSelectionListener() {
    document.addEventListener(
      'mousedown',
      (e) => {
        if (SUPPRESS_NATIVE_CLICK_CAPTURE) return;
        const target = e.target && e.target.closest ? e.target.closest('[id*="-item-"]') : null;
        if (!target) return;
        if (dropdownEl && dropdownEl.contains(target)) return;
        const input = document.querySelector(INPUT_SELECTOR);
        if (!input) return;
        const originalKeyword = input.value;
        if (!originalKeyword) return;
        // Cho 1 tick de MISA kip xu ly xong viec chon san pham roi moi gan bay - dung cung
        // co che protectInputValue nhu path cua script, dong bo hoa 2 luong chon san pham.
        setTimeout(() => {
          protectInputValue(input, originalKeyword);
        }, 0);
      },
      true // bat buoc capture=true de chay truoc handler chon item cua Vue/MISA
    );
  }

  // ================= Dropdown UI tu ve (goi y khi MISA tra ve rong) =================
  let dropdownEl = null;
  let dropdownItems = [];
  let dropdownActiveIdx = -1;
  // FIX VAN DE 1: chot tu khoa NGAY TAI THOI DIEM MO dropdown, dung mot lan duy nhat cho
  // toi khi dropdown dong. Khong con doc lai input.value luc click/Enter nua, vi trong
  // luc dropdown dang mo (vd nguoi dung keo scroll de xem het danh sach), MISA co the tu
  // y ghi input.value ve rong -> neu doc lai luc do se mat tu khoa goc va bo qua luon
  // buoc phuc hoi (vi chuoi rong la falsy).
  let dropdownKeywordSnapshot = null;
  // FIX v1.0 (diem 2 - live-update): luu lai tokensNorm dang dung de hien thi dropdown
  // hien tai, de co the tinh lai candidates tu cache khi co du lieu nen moi ve, ma khong
  // can nguoi dung tu dong/mo lai dropdown.
  let dropdownTokensNorm = null;

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .misa-helper-dropdown {
        position: absolute; z-index: 999999; background: #fff;
        border: 1px solid #d0d0d0; border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        max-height: 340px; overflow-y: auto;
        font-size: 14px; font-family: Arial, sans-serif;
      }
      .misa-helper-item {
        padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0;
        display: flex; align-items: center; gap: 10px;
        min-height: 56px; box-sizing: border-box;
      }
      .misa-helper-item img { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
      .misa-helper-item .info { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 4px; }
      .misa-helper-item .name { font-size: 14px; color: #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .misa-helper-item .name .highlight-match { color: #f5222d; font-weight: 700; }
      .misa-helper-item .sub-row { display: flex; align-items: center; gap: 10px; }
      .misa-helper-item .sku { color: #888; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .misa-helper-item .stock { color: #1e88e5; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
      .misa-helper-item .price { color: #333; font-size: 13px; font-weight: 600; white-space: nowrap; margin-left: auto; }
      .misa-helper-item:hover, .misa-helper-item.active { background: #eaf4ff; }
      .misa-helper-hint { padding: 6px 12px; font-size: 12px; color: #999; border-bottom: 1px solid #f0f0f0; }
      .misa-helper-hint.loading { color: #1e88e5; font-style: italic; }
    `;
    document.head.appendChild(style);
  }

  function closeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
    }
    dropdownItems = [];
    dropdownActiveIdx = -1;
    dropdownKeywordSnapshot = null;
    dropdownTokensNorm = null;
  }

  // FIX v1.0 (diem 2 - live-update): goi ham nay moi khi PRODUCT_CACHE co them du lieu
  // moi (sau mergeItemsIntoCache). Neu dropdown goi y cua script dang mo (khong phai
  // dropdown "Dang tim goi y..."), tinh lai candidates tu cache - neu co THEM san pham
  // khop hon so voi luc mo, ve lai danh sach ngay, khong bat nguoi dung phai tu dong/mo lai.
  function refreshOpenDropdownIfStale() {
    if (!dropdownEl || dropdownEl.dataset.loading === '1') return;
    if (!dropdownTokensNorm || !dropdownKeywordSnapshot) return;
    const freshCandidates = findCandidatesFromCache(dropdownTokensNorm);
    if (freshCandidates.length > dropdownItems.length) {
      const input = document.querySelector(INPUT_SELECTOR);
      if (!input) return;
      const keyword = dropdownKeywordSnapshot;
      const tokensNorm = dropdownTokensNorm;
      openDropdown(input, freshCandidates, keyword, tokensNorm);
    }
  }

  function renderActiveState() {
    if (!dropdownEl) return;
    dropdownEl.querySelectorAll('.misa-helper-item').forEach((n, i) => {
      n.classList.toggle('active', i === dropdownActiveIdx);
      if (i === dropdownActiveIdx) n.scrollIntoView({ block: 'nearest' });
    });
  }

  function getDropdownAnchorContainer(input) {
    return (
      input.closest('.left-order') ||
      input.closest('.box-select-item') ||
      input.closest('.combobox-search') ||
      input.parentElement
    );
  }

  function positionDropdown(el, input) {
    const inputRect = input.getBoundingClientRect();
    const container = getDropdownAnchorContainer(input);
    const containerRect = container ? container.getBoundingClientRect() : inputRect;
    el.style.left = `${containerRect.left + window.scrollX}px`;
    el.style.top = `${inputRect.bottom + window.scrollY + 2}px`;
    el.style.width = `${Math.max(containerRect.width, 320)}px`;
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function highlightKeywordInName(name, keyword) {
    const safeName = escapeHtml(name);
    if (!keyword) return safeName;
    const rawTokens = keyword.trim().split(/\s+/).filter(Boolean);
    if (rawTokens.length === 0) return safeName;
    const pattern = rawTokens.map(escapeRegExp).join('|');
    try {
      const re = new RegExp(`(${pattern})`, 'gi');
      return safeName.replace(re, '<span class="highlight-match">$1</span>');
    } catch (e) {
      return safeName;
    }
  }

  // Hien thi so ton "co the ban" (sellable_quantity). "-" chi con xuat hien khi THUC SU
  // chua co du lieu (chua kip goi/dang cho ket qua) - khong con bi lan voi truong hop
  // "da co du lieu, tri thuc su bang 0" nhu ban cu (FIX 1.3).
  function formatStockNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return null;
    const rounded = Math.round(Number(num) * 100) / 100;
    return rounded.toString().replace('.', ',');
  }
  function getStockDisplayForProduct(product) {
    if (!product.inventoryItemId) {
      return '—';
    }
    const stock = STOCK_CACHE.get(product.inventoryItemId);
    if (!stock) {
      return '—'; // that su chua co du lieu (khac voi "co du lieu = 0")
    }
    const formatted = formatStockNumber(stock.sellableQuantity);
    return formatted === null ? '—' : formatted;
  }

  function openLoadingDropdown(input) {
    closeDropdown();
    dropdownEl = document.createElement('div');
    dropdownEl.className = 'misa-helper-dropdown';
    dropdownEl.dataset.loading = '1';
    positionDropdown(dropdownEl, input);

    const hint = document.createElement('div');
    hint.className = 'misa-helper-hint loading';
    hint.textContent = 'Đang tìm gợi ý...';
    dropdownEl.appendChild(hint);

    document.body.appendChild(dropdownEl);
  }

  // FIX v1.0 (diem 3): phan biet ro "khong tim thay goi y nao" voi viec dropdown tu dung
  // dong lang le (truoc day 2 truong hop nay giong het nhau tren man hinh, nguoi dung
  // khong biet la script da chay xong hay dang loi). Tu dong bien mat sau 1.5s.
  function openNoResultDropdown(input) {
    closeDropdown();
    dropdownEl = document.createElement('div');
    dropdownEl.className = 'misa-helper-dropdown';
    positionDropdown(dropdownEl, input);

    const hint = document.createElement('div');
    hint.className = 'misa-helper-hint';
    hint.textContent = 'Không tìm thấy sản phẩm gợi ý phù hợp.';
    dropdownEl.appendChild(hint);

    document.body.appendChild(dropdownEl);

    const thisDropdown = dropdownEl;
    setTimeout(() => {
      if (dropdownEl === thisDropdown) closeDropdown();
    }, 1500);
  }

  function openDropdown(input, items, keyword, tokensNorm) {
    closeDropdown();
    dropdownItems = items;
    dropdownActiveIdx = 0;
    dropdownKeywordSnapshot = keyword; // FIX VAN DE 1: chot 1 lan duy nhat tai day
    dropdownTokensNorm = tokensNorm || null; // FIX v1.0: luu de co the tinh lai candidates sau nay

    dropdownEl = document.createElement('div');
    dropdownEl.className = 'misa-helper-dropdown';
    positionDropdown(dropdownEl, input);

    const hint = document.createElement('div');
    hint.className = 'misa-helper-hint';
    hint.textContent = `Co ${items.length} san pham gan dung (tu du lieu da tung search) - chon 1 (len/xuong + Enter, hoac click)`;
    dropdownEl.appendChild(hint);

    items.forEach((product, idx) => {
      const item = document.createElement('div');
      item.className = 'misa-helper-item';
      item.innerHTML = `
        <img src="${product.image}" onerror="this.style.display='none'">
        <div class="info">
          <div class="name">${highlightKeywordInName(product.name, keyword)}</div>
          <div class="sub-row">
            <span class="sku">${escapeHtml(product.barcode)}</span>
            <span class="stock">Kho: ${escapeHtml(getStockDisplayForProduct(product))}</span>
            <span class="price">${product.price}</span>
          </div>
        </div>
      `;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // FIX VAN DE 1: dung ban chot dropdownKeywordSnapshot, KHONG doc lai input.value -
        // vi input.value co the da bi MISA tu y xoa ve rong trong luc dropdown dang mo
        // (vd sau khi nguoi dung keo scroll), dan den mat tu khoa that va bo qua luon
        // buoc phuc hoi trong selectRealItem.
        const originalKeyword = dropdownKeywordSnapshot;
        closeDropdown();
        selectRealItem(input, product.itemId, product.barcode, originalKeyword);
      });
      item.addEventListener('mouseenter', () => {
        dropdownActiveIdx = idx;
        renderActiveState();
      });
      dropdownEl.appendChild(item);
    });

    document.body.appendChild(dropdownEl);
  }

  // ================= Theo doi DOM chi de phat hien "rong" =================
  function isEmptyResult(root) {
    return !!root.querySelector('.empty-data-item');
  }

  let pendingSuggestion = null;

  function handlePossibleDropdownRoot(root) {
    if (isEmptyResult(root)) {
      const input = document.querySelector(INPUT_SELECTOR);
      if (input && input.value.trim()) {
        const currentKeyword = input.value.trim();
        const userTokensNorm = tokenize(removeDiacritics(currentKeyword));
        if (userTokensNorm.length >= 2) {
          prepareSuggestion(userTokensNorm, currentKeyword);
        }
      }
    }
  }

  const domObserver = new MutationObserver(() => {
    document.querySelectorAll('.bg-box-items, [id$="-scroller"]').forEach((root) => {
      handlePossibleDropdownRoot(root);
    });
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  // ================= Gan phim tat Ctrl+Space vao o search =================
  function attachToInput(input) {
    if (input.dataset.misaHelperAttached) return;
    input.dataset.misaHelperAttached = '1';

    input.addEventListener('input', () => {
      closeDropdown();
      pendingSuggestion = null;
      suggestionRequestId++;
      currentSuggestionState = { promise: null, ready: true, items: null };
      // FIX vde 2: nguoi dung THAT SU go phim tiep -> giai phong bay ngay lap tuc, khong
      // con phu thuoc watchdog/thoi gian nua.
      if (activeProtectionRelease) activeProtectionRelease();
    });

    input.addEventListener('keydown', (e) => {
      if (dropdownEl) {
        if (e.code === 'ArrowDown') {
          e.preventDefault();
          dropdownActiveIdx = (dropdownActiveIdx + 1) % dropdownItems.length;
          renderActiveState();
          return;
        }
        if (e.code === 'ArrowUp') {
          e.preventDefault();
          dropdownActiveIdx = (dropdownActiveIdx - 1 + dropdownItems.length) % dropdownItems.length;
          renderActiveState();
          return;
        }
        if (e.code === 'Enter' && dropdownActiveIdx >= 0) {
          e.preventDefault();
          const product = dropdownItems[dropdownActiveIdx];
          // FIX VAN DE 1: dung ban chot dropdownKeywordSnapshot thay vi doc lai input.value,
          // cung ly do nhu nhanh mousedown trong openDropdown.
          const originalKeyword = dropdownKeywordSnapshot;
          closeDropdown();
          selectRealItem(input, product.itemId, product.barcode, originalKeyword);
          return;
        }
        if (e.code === 'Escape') {
          closeDropdown();
          return;
        }
      }

      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();

        const currentKeyword = input.value.trim();

        if (pendingSuggestion && pendingSuggestion.length > 0) {
          const tokensNormForPending = tokenize(removeDiacritics(currentKeyword));
          openDropdown(input, pendingSuggestion, currentKeyword, tokensNormForPending);
          pendingSuggestion = null;
          return;
        }

        if (currentSuggestionState.promise && !currentSuggestionState.ready) {
          openLoadingDropdown(input);
          const waitingTokensNorm = tokenize(removeDiacritics(currentKeyword));
          const waitingPromise = currentSuggestionState.promise;
          waitingPromise.then((items) => {
            if (dropdownEl && dropdownEl.dataset.loading === '1') {
              if (items && items.length > 0) {
                openDropdown(input, items, currentKeyword, waitingTokensNorm);
              } else {
                openNoResultDropdown(input); // FIX v1.0 (diem 3): thong bao ro thay vi im lang dong
              }
            }
          });
          return;
        }

        if (!currentKeyword) return;
        const userTokensNorm = tokenize(removeDiacritics(currentKeyword));
        if (userTokensNorm.length === 0) return;

        openLoadingDropdown(input);
        const promise = prepareSuggestion(userTokensNorm, currentKeyword);
        promise.then((items) => {
          if (dropdownEl && dropdownEl.dataset.loading === '1') {
            if (items && items.length > 0) {
              openDropdown(input, items, currentKeyword, userTokensNorm);
            } else {
              openNoResultDropdown(input); // FIX v1.0 (diem 3): thong bao ro thay vi im lang dong
            }
          }
        });
      }
    });

    document.addEventListener('click', (e) => {
      if (dropdownEl && !dropdownEl.contains(e.target) && e.target !== input) {
        closeDropdown();
      }
    });
  }

  function scanForInput() {
    const input = document.querySelector(INPUT_SELECTOR);
    if (input) attachToInput(input);
  }

  injectStyle();
  attachNativeItemSelectionListener();
  const inputObserver = new MutationObserver(scanForInput);
  inputObserver.observe(document.body, { childList: true, subtree: true });
  scanForInput();
})();