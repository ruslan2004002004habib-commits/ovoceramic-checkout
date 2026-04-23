(function () {
  "use strict";
  var BUILD_VERSION = "2026-04-28-page-v8-dedupe-fix";
  window.NovoDeliveryPageVersion = BUILD_VERSION;

  var CONFIG = Object.assign(
    {
      tariffsUrl: "",
      fieldPrefix: "nc_delivery_",
      containerSelector: "",
      formSelector: ".js-form-proccess, form",
      defaultCity: "",
      defaultCarrier: "novoceramic",
      snapshotStorageKey: "nc_checkout_cart_snapshot",
      productFormatMapStorageKey: "nc_product_format_map",
      submitMode: "lead_only", // lead_only | redirect | tbank
      paymentRedirectUrl: "",
      redirectDelayMs: 1500,
      tbankCreatePaymentUrl: "",
      tbankSuccessUrl: "",
      tbankFailUrl: "",
      tbankNotificationUrl: "",
      carriers: [
        { id: "novoceramic", title: "Курьер Новокерамик", hasPickup: false },
        { id: "sdek", title: "СДЭК", hasPickup: true },
        { id: "delovye-linii", title: "Деловые Линии", hasPickup: true },
      ],
      pickupPoints: [
        { value: "", label: "Выберите пункт получения (опционально)" },
        { value: "pickup-1", label: "Пункт выдачи 1" },
        { value: "pickup-2", label: "Пункт выдачи 2" },
        { value: "pickup-3", label: "Пункт выдачи 3" },
      ],
      carrierMultipliers: {
        novoceramic: 1,
        sdek: 1,
        "delovye-linii": 1,
      },
      photoMaxFiles: 6,
      debug: false,
    },
    window.NovoDeliveryPageConfig || window.NovoDeliveryConfig || {}
  );

  var state = {
    tariffsData: null,
    columnsMeta: {},
    products: [],
    selectedCity: "",
    selectedCarrier: CONFIG.defaultCarrier,
    selectedPickupPoint: "",
    attachedPhotoNames: [],
    snapshotSourceUrl: "",
    calculation: null,
    cartSubtotal: null,
    mounted: false,
    hiddenFields: {},
    selectedForm: null,
    currentStep: 1,
  };

  var refs = {
    root: null,
    status: null,
    warning: null,
    productsSummary: null,
    productsList: null,
    stats: null,
    details: null,
    payButton: null,
    customerName: null,
    customerPhone: null,
    customerAddress: null,
    customerStreet: null,
    customerHouse: null,
    customerFlat: null,
    deliveryTotal: null,
    orderTotal: null,
    cartTotal: null,
    carrierHost: null,
    carrierButtons: {},
    nativeCityRadios: [],
    citySelect: null,
    pickupWrap: null,
    pickupSelect: null,
    photoInput: null,
    photoList: null,
    photoFallbackHost: null,
    photoFallbackInput: null,
    boundPhotoInput: null,
    photoWatcher: null,
    photoPollTimer: null,
    photoBindRetryTimer: null,
    autoRefreshObserver: null,
    autoRefreshTimer: null,
    hiddenFieldsHost: null,
  };
  var PHOTO_INPUT_SELECTOR =
    "input[role='upwidget-uploader'], .t-upwidget input[type='file'], .t-upwidget input, input[data-tilda-upwidget-key], input[name='File'], input[name='file'], input[name^='File'], input[name^='file'], .t-input-group_uw input, [data-field-type='uw'] input, input[type='file']";

  function log() {
    if (!CONFIG.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[NovoDeliveryPage]");
    console.log.apply(console, args);
  }

  function installTildaZeroGuard() {
    if (window.__ncT396GuardInstalled) return;
    window.__ncT396GuardInstalled = true;

    function shouldIgnoreT396Error(err) {
      var message = String((err && err.message) || err || "");
      return /screens/i.test(message) || /Error trying to resize rec/i.test(message);
    }

    function wrapFunction(name) {
      var fn = window[name];
      if (typeof fn !== "function") return false;
      if (fn.__ncGuardWrapped) return true;

      var wrapped = function () {
        try {
          return fn.apply(this, arguments);
        } catch (err) {
          if (shouldIgnoreT396Error(err)) {
            console.warn("[NovoDeliveryPage] Ignored Tilda Zero runtime error in " + name, err);
            return null;
          }
          throw err;
        }
      };
      wrapped.__ncGuardWrapped = true;
      window[name] = wrapped;
      return true;
    }

    function applyGuards() {
      wrapFunction("t396_detectResolution");
      wrapFunction("t396_doResize");
      wrapFunction("t396_init");
    }

    applyGuards();

    var attempts = 0;
    var timer = window.setInterval(function () {
      attempts += 1;
      applyGuards();
      if (attempts >= 30) {
        window.clearInterval(timer);
      }
    }, 400);
  }

  installTildaZeroGuard();

  function parseNumber(raw) {
    if (raw === null || raw === undefined || raw === "") return NaN;
    var normalized = String(raw)
      .replace(/\u00a0/g, " ")
      .replace(/[^\d,.\- ]/g, "")
      .replace(/\s+/g, "")
      .replace(",", ".");
    return Number(normalized);
  }

  function parseRub(raw) {
    return parseNumber(raw);
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return "";
    }
  }

  function parseProductPricing(raw, qty) {
    var unitCandidates = [
      raw.price,
      raw.priceValueOld,
      raw.priceValue,
      raw.pricevalue,
      raw.priceWithDiscount,
      raw.price_with_discount,
      raw.productPrice,
      raw.unitPrice,
      raw.cost,
      raw.tprice,
      raw.finalPrice,
    ];
    var lineCandidates = [raw.total, raw.sum, raw.subtotal, raw.totalPrice, raw.lineTotal, raw.amount, raw.tsum];

    var unitPrice = NaN;
    for (var i = 0; i < unitCandidates.length; i += 1) {
      unitPrice = parseNumber(unitCandidates[i]);
      if (Number.isFinite(unitPrice)) break;
    }

    var lineTotal = NaN;
    for (var j = 0; j < lineCandidates.length; j += 1) {
      lineTotal = parseNumber(lineCandidates[j]);
      if (Number.isFinite(lineTotal)) break;
    }

    if (!Number.isFinite(lineTotal) && Number.isFinite(unitPrice) && Number.isFinite(qty) && qty > 0) {
      lineTotal = unitPrice * qty;
    }
    if (!Number.isFinite(unitPrice) && Number.isFinite(lineTotal) && Number.isFinite(qty) && qty > 0) {
      unitPrice = lineTotal / qty;
    }

    return {
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
      lineTotal: Number.isFinite(lineTotal) ? lineTotal : null,
    };
  }

  function formatRub(value) {
    if (!Number.isFinite(value)) return "0 ₽";
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      maximumFractionDigits: 2,
    }).format(value);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function detectFormatByText(raw) {
    var text = normalizeText(raw).toLowerCase();
    var flat = text.replace(/\\+/g, "");
    if (/120\s*[xх*]\s*60/.test(flat) || /60\s*[xх*]\s*120/.test(flat)) return "120x60";
    if (/60\s*[xх*]\s*60/.test(flat)) return "60x60";
    if (/1200\s*[/xх*]\s*600/.test(flat) || /600\s*[/xх*]\s*1200/.test(flat)) return "120x60";
    if (/600\s*[/xх*]\s*600/.test(flat)) return "60x60";
    if (
      /(?:pack_x|size_x|width|dim_x|x)["'\s:=]*1200/.test(flat) &&
      /(?:pack_y|size_y|height|dim_y|y)["'\s:=]*600/.test(flat)
    ) {
      return "120x60";
    }
    if (
      /(?:pack_x|size_x|width|dim_x|x)["'\s:=]*600/.test(flat) &&
      /(?:pack_y|size_y|height|dim_y|y)["'\s:=]*1200/.test(flat)
    ) {
      return "120x60";
    }
    if (
      /(?:pack_x|size_x|width|dim_x|x)["'\s:=]*600/.test(flat) &&
      /(?:pack_y|size_y|height|dim_y|y)["'\s:=]*600/.test(flat)
    ) {
      return "60x60";
    }
    return "";
  }

  function normalizeDimensionValue(raw) {
    var value = parseNumber(raw);
    if (!Number.isFinite(value) || value <= 0) return NaN;
    if (value >= 500) return value / 10;
    return value;
  }

  function detectFormatByDimensions(first, second) {
    var a = normalizeDimensionValue(first);
    var b = normalizeDimensionValue(second);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
    var maxSide = Math.max(a, b);
    var minSide = Math.min(a, b);
    if (Math.abs(maxSide - 120) <= 2 && Math.abs(minSide - 60) <= 2) return "120x60";
    if (Math.abs(maxSide - 60) <= 2 && Math.abs(minSide - 60) <= 2) return "60x60";
    return "";
  }

  function detectFormatByObject(raw) {
    if (!raw || typeof raw !== "object") return "";
    var pairs = [
      [raw.pack_x, raw.pack_y],
      [raw.packX, raw.packY],
      [raw.width, raw.height],
      [raw.w, raw.h],
      [raw.x, raw.y],
      [raw.dim_x, raw.dim_y],
      [raw.size_x, raw.size_y],
      [raw.length, raw.width],
      [raw.len, raw.width],
    ];

    for (var i = 0; i < pairs.length; i += 1) {
      var byDims = detectFormatByDimensions(pairs[i][0], pairs[i][1]);
      if (byDims) return byDims;
    }

    var hintsText = [
      raw.size,
      raw.dimensions,
      raw.dimension,
      raw.pack_label,
      raw.pack_m,
      raw.pack_x,
      raw.pack_y,
      raw.pack_z,
      raw.characteristics && safeStringify(raw.characteristics),
      raw.properties && safeStringify(raw.properties),
      raw.params && safeStringify(raw.params),
    ]
      .filter(Boolean)
      .join(" ");

    return detectFormatByText(hintsText);
  }

  function normalizeImageUrl(raw) {
    var value = normalizeText(raw);
    if (!value) return "";
    if (/^data:/i.test(value)) return value;
    if (/^\/\//.test(value)) return window.location.protocol + value;
    if (/^https?:\/\//i.test(value)) {
      if (window.location.protocol === "https:" && /^http:\/\//i.test(value)) {
        return "https://" + value.replace(/^http:\/\//i, "");
      }
      return value;
    }
    if (/^\//.test(value)) return window.location.origin + value;
    return "";
  }

  function extractImageUrlFromText(rawText) {
    var text = String(rawText || "")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"');
    if (!text) return "";

    var byJsonKey =
      /"(?:img|image|imageUrl|photo|picture|src|thumbnail|cover)"\s*:\s*"([^"]+)"/i.exec(text) ||
      /(?:img|image|imageUrl|photo|picture|src|thumbnail|cover)\s*[:=]\s*["']([^"']+)["']/i.exec(text);
    if (byJsonKey && byJsonKey[1]) {
      var fromJson = normalizeImageUrl(byJsonKey[1]);
      if (fromJson) return fromJson;
    }

    var urlMatch = /(https?:\/\/[^\s"'<>]+?\.(?:webp|png|jpe?g|gif|avif|svg)(?:\?[^\s"'<>]*)?)/i.exec(text);
    if (urlMatch && urlMatch[1]) {
      var fromUrl = normalizeImageUrl(urlMatch[1]);
      if (fromUrl) return fromUrl;
    }

    return "";
  }

  function detectProductImage(raw, optionsRaw) {
    if (!raw || typeof raw !== "object") return extractImageUrlFromText(optionsRaw);

    var directCandidates = [
      raw.img,
      raw.image,
      raw.imageUrl,
      raw.image_url,
      raw.photo,
      raw.picture,
      raw.pic,
      raw.preview,
      raw.thumbnail,
      raw.src,
      raw.cover,
      raw.coverImage,
      raw.mainImage,
      raw.poster,
    ];

    for (var i = 0; i < directCandidates.length; i += 1) {
      var direct = normalizeImageUrl(directCandidates[i]);
      if (direct) return direct;
    }

    var listCandidates = [raw.images, raw.gallery, raw.photos, raw.pictures];
    for (var j = 0; j < listCandidates.length; j += 1) {
      var list = listCandidates[j];
      if (!Array.isArray(list) || !list.length) continue;
      for (var k = 0; k < list.length; k += 1) {
        var node = list[k];
        var fromList =
          normalizeImageUrl(node) ||
          normalizeImageUrl(node && (node.url || node.src || node.image || node.img || node.original));
        if (fromList) return fromList;
      }
    }

    return extractImageUrlFromText((optionsRaw || "") + " " + safeStringify(raw));
  }

  function detectFormatByUrl(rawUrl) {
    var text = normalizeText(rawUrl).toLowerCase();
    if (!text) return "";
    if (/60x120|60-120|120x60|120-60/.test(text)) return "120x60";
    if (/60x60|60-60/.test(text)) return "60x60";
    return "";
  }

  function getPathFromUrl(rawUrl) {
    try {
      return String(new URL(String(rawUrl || ""), window.location.origin).pathname || "/")
        .split("?")[0]
        .split("#")[0]
        .replace(/\/+$/, "") || "/";
    } catch (err) {
      return String(window.location.pathname || "/").replace(/\/+$/, "") || "/";
    }
  }

  function getFormatMapKey(title, sourceUrl) {
    return normalizeText(title).toLowerCase() + "|" + getPathFromUrl(sourceUrl || state.snapshotSourceUrl || "");
  }

  function readProductFormatMap() {
    if (!window.localStorage) return {};
    try {
      var raw = localStorage.getItem(CONFIG.productFormatMapStorageKey);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function isSupportedFormat(value) {
    return value === "120x60" || value === "60x60";
  }

  function getFormatByTitleFromMap(formatMap, title) {
    if (!formatMap) return "";
    var normalizedTitle = normalizeText(title).toLowerCase();
    if (!normalizedTitle) return "";

    var wildcard = formatMap[normalizedTitle + "|*"];
    if (isSupportedFormat(wildcard)) return wildcard;

    var seen = {};
    Object.keys(formatMap).forEach(function (key) {
      if (key.indexOf(normalizedTitle + "|") !== 0) return;
      var value = formatMap[key];
      if (!isSupportedFormat(value)) return;
      seen[value] = true;
    });
    var variants = Object.keys(seen);
    return variants.length === 1 ? variants[0] : "";
  }

  function isElementVisible(element) {
    if (!element || !element.getClientRects) return false;
    if (element.getClientRects().length === 0) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  }

  function getCandidateForms() {
    return Array.prototype.slice.call(document.querySelectorAll(CONFIG.formSelector)).filter(Boolean);
  }

  function scoreForm(form) {
    if (!form || !form.querySelector) return -1;
    var score = 0;
    if (form.querySelector(PHOTO_INPUT_SELECTOR + ", .t-upwidget")) score += 5;
    if (form.querySelector("input[name='towns_delivery'], .t-input-group_dl")) score += 4;
    if (form.closest(".t706")) score += 3;
    if (form.classList.contains("js-form-proccess")) score += 2;
    if (isElementVisible(form)) score += 1;
    return score;
  }

  function pickPreferredForm(onlyVisible) {
    var forms = getCandidateForms();
    if (onlyVisible) {
      forms = forms.filter(isElementVisible);
      if (!forms.length) forms = getCandidateForms();
    }
    if (!forms.length) return null;
    forms.sort(function (a, b) {
      return scoreForm(b) - scoreForm(a);
    });
    return forms[0] || null;
  }

  function getScriptBasePath() {
    var scripts = document.querySelectorAll("script[src]");
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var src = scripts[i].getAttribute("src");
      if (src && /delivery-checkout-page(\.with-tariffs)?\.js/i.test(src)) {
        return src.split("/").slice(0, -1).join("/");
      }
    }
    return "";
  }

  function resolveTariffsUrl() {
    if (CONFIG.tariffsUrl) return CONFIG.tariffsUrl;
    var base = getScriptBasePath();
    return base ? base + "/delivery-tariffs.json" : "delivery-tariffs.json";
  }

  function getInlineTariffsData() {
    if (CONFIG.tariffsData && CONFIG.tariffsData.formats) return CONFIG.tariffsData;
    if (window.NovoDeliveryTariffs && window.NovoDeliveryTariffs.formats) return window.NovoDeliveryTariffs;
    return null;
  }

  function parseQtyFromLabel(label) {
    var inBrackets = /\(([^)]+)\)/.exec(String(label || ""));
    if (!inBrackets) return NaN;
    var values = inBrackets[1]
      .split("/")
      .map(function (chunk) {
        return parseNumber(chunk);
      })
      .filter(function (n) {
        return Number.isFinite(n);
      });
    if (!values.length) return NaN;
    return values[values.length - 1];
  }

  function parseWeightFromLabel(label) {
    var text = String(label || "");
    var byKg = /(\d[\d\s\u00a0.,]*)\s*кг/i.exec(text);
    if (byKg) return parseNumber(byKg[1]);
    var byColon = /(\d[\d\s\u00a0.,]*)\s*[:=]/i.exec(text);
    if (byColon) return parseNumber(byColon[1]);
    return NaN;
  }

  function buildColumnsMeta() {
    if (!state.tariffsData || !state.tariffsData.formats) return;
    ["120x60", "60x60"].forEach(function (formatKey) {
      var formatData = state.tariffsData.formats[formatKey];
      if (!formatData || !Array.isArray(formatData.columns)) return;
      state.columnsMeta[formatKey] = {
        labels: formatData.columns.slice(),
        weights: formatData.columns.map(parseWeightFromLabel),
      };
    });
  }

  function getFormatUnitWeight(formatKey) {
    var meta = state.columnsMeta[formatKey];
    if (!meta || !meta.weights || !meta.weights.length) return NaN;
    var firstWeight = meta.weights[0];
    var qtyFromFirstLabel = parseQtyFromLabel(meta.labels[0]);
    if (!Number.isFinite(firstWeight) || !Number.isFinite(qtyFromFirstLabel) || qtyFromFirstLabel <= 0) {
      return NaN;
    }
    return firstWeight / qtyFromFirstLabel;
  }

  function resolveColumnIndexByWeight(formatKey, totalWeight) {
    var meta = state.columnsMeta[formatKey];
    if (!meta || !meta.weights || !meta.weights.length || !Number.isFinite(totalWeight)) return 0;
    for (var i = 0; i < meta.weights.length; i += 1) {
      if (Number.isFinite(meta.weights[i]) && totalWeight <= meta.weights[i]) return i;
    }
    return meta.weights.length - 1;
  }

  function normalizeProduct(raw) {
    var optionsRaw = "";
    if (Array.isArray(raw.options)) {
      optionsRaw = raw.options
        .map(function (opt) {
          if (!opt) return "";
          return String(opt.value || opt.variant || opt.title || opt.name || "");
        })
        .join(" ");
    } else if (typeof raw.options === "string") {
      optionsRaw = raw.options;
    }

    var extraHints = [
      raw.format,
      raw.tileFormat,
      raw.tile_size,
      raw.product_format,
      raw.gen_uid,
      raw.uid,
      raw.productId,
      raw.product_id,
      raw.id,
      raw.variantName,
      raw.size,
      raw.dimensions,
      raw.dimension,
      raw.variant,
      raw.variation,
      raw.sku,
      raw.article,
      raw.articul,
      raw.description,
      raw.desc,
      raw.url,
      raw.link,
      raw.href,
      raw.page,
      raw.params && JSON.stringify(raw.params),
      raw.characteristics && JSON.stringify(raw.characteristics),
      raw.props && JSON.stringify(raw.props),
      raw.properties && JSON.stringify(raw.properties),
      raw.options && typeof raw.options === "object" && safeStringify(raw.options),
      raw.variants && safeStringify(raw.variants),
      safeStringify(raw),
    ]
      .filter(Boolean)
      .join(" ");

    if (extraHints) {
      optionsRaw = normalizeText(optionsRaw + " " + extraHints);
    }

    var title = normalizeText(raw.title || raw.name || raw.product || raw.productName || "");
    var qty = parseNumber(raw.quantity || raw.qty || raw.count || 1);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    var pricing = parseProductPricing(raw, qty);

    var detectedByObject = detectFormatByObject(raw);
    var imageUrl = detectProductImage(raw, optionsRaw);

    return {
      title: title,
      quantity: qty,
      options: normalizeText(optionsRaw),
      unitPrice: pricing.unitPrice,
      lineTotal: pricing.lineTotal,
      detectedFormat: raw.detectedFormat || detectedByObject || detectFormatByText(title + " " + optionsRaw),
      sourceUrl: normalizeText(raw.sourceUrl || raw.url || raw.link || ""),
      sku: normalizeText(raw.sku || raw.article || raw.articul || ""),
      imageUrl: imageUrl,
    };
  }

  function parseSnapshotFromStorage() {
    if (!window.localStorage) return null;
    try {
      var raw = localStorage.getItem(CONFIG.snapshotStorageKey);
      if (!raw) return null;
      var snapshot = JSON.parse(raw);
      if (!snapshot || !Array.isArray(snapshot.products)) return null;
      state.snapshotSourceUrl = normalizeText(snapshot.sourceUrl || "");
      return snapshot;
    } catch (err) {
      return null;
    }
  }

  function getCartProductsFromGlobal() {
    var candidates = [
      window.tcart && window.tcart.products,
      window.tcart && window.tcart.prod,
      window.tcart && window.tcart.cart && window.tcart.cart.products,
      window.tcart_products,
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      if (Array.isArray(candidates[i]) && candidates[i].length) {
        return candidates[i].map(normalizeProduct);
      }
    }
    return [];
  }

  function getCartProductsFromDom() {
    var nodes = document.querySelectorAll(
      ".t706__product, [data-cart-product-id], .t706__order-prod, .t-store__prod-popup, .js-product"
    );
    var list = [];

    nodes.forEach(function (node) {
      var titleNode = node.querySelector(
        ".t706__product-title, .t-store__card__title, [data-product-title], .js-store-prod-name"
      );
      var qtyNode = node.querySelector("input[name='quantity'], input[name='amount'], .t706__product-plusminus input");
      var qtyTextNode = node.querySelector(".t706__product-amount, [data-product-amount], .js-store-prod-quantity");
      var priceNode = node.querySelector(
        ".t706__product-price, .t706__product-total, .t706__product-sum, [data-product-price], [data-price]"
      );
      var imageNode = node.querySelector("img[src], [data-original], [data-img-zoom-url]");

      var qty = 1;
      if (qtyNode && qtyNode.value) qty = parseNumber(qtyNode.value);
      if ((!qty || !Number.isFinite(qty)) && qtyTextNode) qty = parseNumber(qtyTextNode.textContent);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;

      var title = normalizeText(titleNode ? titleNode.textContent : node.textContent);
      if (!title) return;

      list.push(
        normalizeProduct({
          title: title,
          quantity: qty,
          options: normalizeText(node.textContent),
          price: priceNode ? priceNode.textContent : "",
          image:
            (imageNode && (imageNode.getAttribute("src") || imageNode.getAttribute("data-original"))) ||
            (imageNode && imageNode.getAttribute("data-img-zoom-url")) ||
            "",
        })
      );
    });

    return list;
  }

  function collectProductsFromObject(value, out, depth) {
    if (depth > 4 || value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach(function (item) {
        collectProductsFromObject(item, out, depth + 1);
      });
      return;
    }

    if (typeof value !== "object") return;

    var hasProductTitle =
      (typeof value.title === "string" && value.title.trim()) ||
      (typeof value.name === "string" && value.name.trim()) ||
      (typeof value.product === "string" && value.product.trim()) ||
      (typeof value.productName === "string" && value.productName.trim());

    var hasQty = value.quantity || value.amount || value.count;

    if (hasProductTitle && hasQty) {
      var normalized = normalizeProduct(value);
      if (normalized.title) out.push(normalized);
    }

    Object.keys(value).forEach(function (key) {
      if (key === "__proto__") return;
      collectProductsFromObject(value[key], out, depth + 1);
    });
  }

  function getCartProductsFromLocalStorage() {
    if (!window.localStorage) return [];
    var result = [];
    for (var i = 0; i < localStorage.length; i += 1) {
      var key = localStorage.key(i);
      if (!key) continue;
      // Читаем только родные ключи корзины Tilda. Наш собственный snapshot
      // (nc_*) и кеш тарифов исключаем — иначе товары дублируются и в
      // список попадают строки из тарифной таблицы (Анапа/при заказе...).
      if (!/^tcart($|[^a-z])|^tilda-?cart|^basket/i.test(key)) continue;
      if (/^nc[_-]/i.test(key)) continue;
      if (/tariff|delivery/i.test(key)) continue;
      try {
        var raw = localStorage.getItem(key);
        if (!raw || (raw[0] !== "{" && raw[0] !== "[")) continue;
        var parsed = JSON.parse(raw);
        collectProductsFromObject(parsed, result, 0);
      } catch (err) {
        // ignore malformed payload
      }
    }
    return result;
  }

  function dedupeProducts(products) {
    var map = new Map();
    products.forEach(function (item) {
      var key = item.title + "|" + item.options;
      var prev = map.get(key);
      var itemQty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      var itemLine =
        Number.isFinite(item.lineTotal) && item.lineTotal > 0
          ? item.lineTotal
          : Number.isFinite(item.unitPrice)
          ? item.unitPrice * itemQty
          : NaN;
      if (prev) {
        var prevQty = Number.isFinite(prev.quantity) && prev.quantity > 0 ? prev.quantity : 1;
        var prevLine =
          Number.isFinite(prev.lineTotal) && prev.lineTotal > 0
            ? prev.lineTotal
            : Number.isFinite(prev.unitPrice)
            ? prev.unitPrice * prevQty
            : NaN;
        prev.quantity += item.quantity;
        if (!prev.detectedFormat && item.detectedFormat) prev.detectedFormat = item.detectedFormat;
        if (!prev.sourceUrl && item.sourceUrl) prev.sourceUrl = item.sourceUrl;
        if (!prev.sku && item.sku) prev.sku = item.sku;
        if (!prev.imageUrl && item.imageUrl) prev.imageUrl = item.imageUrl;
        if (Number.isFinite(prevLine) || Number.isFinite(itemLine)) {
          var mergedLine = (Number.isFinite(prevLine) ? prevLine : 0) + (Number.isFinite(itemLine) ? itemLine : 0);
          prev.lineTotal = mergedLine;
          prev.unitPrice = mergedLine / Math.max(1, prev.quantity);
        }
      } else {
        map.set(key, {
          title: item.title,
          options: item.options,
          quantity: item.quantity,
          unitPrice: Number.isFinite(item.unitPrice) ? item.unitPrice : null,
          lineTotal: Number.isFinite(itemLine) ? itemLine : null,
          detectedFormat: item.detectedFormat || "",
          sourceUrl: item.sourceUrl || "",
          sku: item.sku || "",
          imageUrl: item.imageUrl || "",
        });
      }
    });
    return Array.from(map.values());
  }

  function getProductKey(product) {
    return normalizeText((product && product.title) || "") + "|" + normalizeText((product && product.options) || "");
  }

  function hasAnyProductPricing(products) {
    if (!Array.isArray(products) || !products.length) return false;
    for (var i = 0; i < products.length; i += 1) {
      var p = products[i] || {};
      if (Number.isFinite(p.lineTotal) || Number.isFinite(p.unitPrice)) return true;
    }
    return false;
  }

  function enrichPricingFromSource(targetProducts, sourceProducts) {
    if (!Array.isArray(targetProducts) || !targetProducts.length) return targetProducts;
    if (!Array.isArray(sourceProducts) || !sourceProducts.length) return targetProducts;
    var sourceMap = new Map();
    sourceProducts.forEach(function (item) {
      var key = getProductKey(item);
      if (!key) return;
      if (!sourceMap.has(key) && (Number.isFinite(item.lineTotal) || Number.isFinite(item.unitPrice))) {
        sourceMap.set(key, item);
      }
    });

    return targetProducts.map(function (item) {
      if (Number.isFinite(item.lineTotal) || Number.isFinite(item.unitPrice)) return item;
      var source = sourceMap.get(getProductKey(item));
      if (!source) return item;
      return Object.assign({}, item, {
        unitPrice: Number.isFinite(source.unitPrice) ? source.unitPrice : item.unitPrice,
        lineTotal: Number.isFinite(source.lineTotal) ? source.lineTotal : item.lineTotal,
      });
    });
  }

  function calculateProductsSubtotal(products) {
    if (!Array.isArray(products) || !products.length) return null;
    var sum = 0;
    var hasAny = false;
    products.forEach(function (item) {
      var qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      var line =
        Number.isFinite(item.lineTotal) && item.lineTotal > 0
          ? item.lineTotal
          : Number.isFinite(item.unitPrice)
          ? item.unitPrice * qty
          : NaN;
      if (Number.isFinite(line) && line >= 0) {
        hasAny = true;
        sum += line;
      }
    });
    return hasAny ? sum : null;
  }

  function parseCartSubtotalFromDom() {
    var node = document.querySelector(
      ".t706__cartwin-totalamount-info_value, .t706__cartwin-totalamount-value, .t706__sidebar-prodamount, .t706__cartwin-prodamount, .t706__cartpage-prodamount, [data-cart-total]"
    );
    if (!node) return null;
    var value = parseNumber(node.textContent);
    return Number.isFinite(value) ? value : null;
  }

  function collectCartProducts() {
    state.snapshotSourceUrl = "";
    var snapshot = parseSnapshotFromStorage();
    if (snapshot && Array.isArray(snapshot.products) && snapshot.products.length) {
      var normalizedSnapshotProducts = dedupeProducts(snapshot.products.map(normalizeProduct));
      if (!hasAnyProductPricing(normalizedSnapshotProducts)) {
        var pricingSource =
          dedupeProducts(getCartProductsFromGlobal())
            .concat(dedupeProducts(getCartProductsFromLocalStorage()))
            .concat(dedupeProducts(getCartProductsFromDom()));
        normalizedSnapshotProducts = enrichPricingFromSource(normalizedSnapshotProducts, dedupeProducts(pricingSource));
      }
      state.cartSubtotal = Number.isFinite(parseNumber(snapshot.subtotal))
        ? parseNumber(snapshot.subtotal)
        : calculateProductsSubtotal(normalizedSnapshotProducts);
      return normalizedSnapshotProducts;
    }

    var source = getCartProductsFromGlobal();
    if (!source.length) source = getCartProductsFromDom();
    if (!source.length) source = getCartProductsFromLocalStorage();

    if (!Number.isFinite(state.cartSubtotal)) {
      state.cartSubtotal = parseCartSubtotalFromDom() || calculateProductsSubtotal(source);
    }

    return dedupeProducts(source);
  }

  function parseCityFromLabel(rawText) {
    var text = normalizeText(rawText || "");
    if (!text) return "";
    return text.replace(/\([^)]*\)/g, "").trim();
  }

  function getNativeCities() {
    var cities = [];
    refs.nativeCityRadios.forEach(function (radio) {
      var label = radio.closest("label");
      var city = parseCityFromLabel(label ? label.textContent : "");
      if (city) cities.push(city);
    });
    return cities;
  }

  function getTariffCities() {
    var formats = (state.tariffsData && state.tariffsData.formats) || {};
    var keys = {};
    Object.keys(formats).forEach(function (formatKey) {
      var tariffs = (formats[formatKey] && formats[formatKey].tariffs) || {};
      Object.keys(tariffs).forEach(function (city) {
        if (city) keys[city] = true;
      });
    });
    return Object.keys(keys);
  }

  function buildCityOptions() {
    var all = getTariffCities().concat(getNativeCities(), [CONFIG.defaultCity, state.selectedCity]);
    var uniq = {};
    all.forEach(function (city) {
      if (!city) return;
      uniq[city] = true;
    });
    return Object.keys(uniq).sort(function (a, b) {
      return a.localeCompare(b, "ru");
    });
  }

  function getSelectedCityFromNativeRadios() {
    for (var i = 0; i < refs.nativeCityRadios.length; i += 1) {
      var radio = refs.nativeCityRadios[i];
      if (!radio.checked) continue;
      var label = radio.closest("label");
      var city = parseCityFromLabel(label ? label.textContent : "");
      if (!city) continue;
      return city;
    }
    return "";
  }

  function syncNativeRadioByCity(cityName) {
    if (!cityName || !refs.nativeCityRadios.length) return;
    var normalizedCity = normalizeText(cityName).toLowerCase();
    var matched = null;
    refs.nativeCityRadios.forEach(function (radio) {
      var label = radio.closest("label");
      var city = parseCityFromLabel(label ? label.textContent : "").toLowerCase();
      if (!matched && city === normalizedCity) matched = radio;
    });
    if (!matched || matched.checked) return;
    matched.checked = true;
    matched.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function renderCitySelectOptions() {
    if (!refs.cityDatalist) return;
    var cities = buildCityOptions();
    refs.cityDatalist.innerHTML = "";
    cities.forEach(function (city) {
      var option = document.createElement("option");
      option.value = city;
      refs.cityDatalist.appendChild(option);
    });

    var preferredCity = state.selectedCity || getSelectedCityFromNativeRadios() || CONFIG.defaultCity || "";
    if (preferredCity && refs.customerAddress && !refs.customerAddress.value) {
      refs.customerAddress.value = preferredCity;
      state.selectedCity = preferredCity;
    }
  }

  function getSelectedNativeDeliveryPrice() {
    for (var i = 0; i < refs.nativeCityRadios.length; i += 1) {
      var radio = refs.nativeCityRadios[i];
      if (!radio.checked) continue;
      var direct = parseNumber(radio.getAttribute("data-delivery-price"));
      if (Number.isFinite(direct)) return direct;

      var label = radio.closest("label");
      var text = normalizeText(label ? label.textContent : "");
      var inBrackets = /\(([^)]*)\)/.exec(text);
      if (inBrackets) {
        var parsed = parseNumber(inBrackets[1]);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return NaN;
  }

  function resolveProductFormat(product) {
    var direct =
      product.detectedFormat || detectFormatByText([(product.title || ""), (product.options || ""), (product.sku || "")].join(" "));
    if (isSupportedFormat(direct)) return direct;

    var formatMap = readProductFormatMap();
    var fromMap = formatMap[getFormatMapKey(product.title || "", product.sourceUrl || state.snapshotSourceUrl)];
    if (!isSupportedFormat(fromMap)) {
      fromMap = getFormatByTitleFromMap(formatMap, product.title || "");
    }
    if (isSupportedFormat(fromMap)) return fromMap;

    var fromSourceUrl = detectFormatByUrl(product.sourceUrl || "");
    if (fromSourceUrl) return fromSourceUrl;

    var fromSnapshotUrl = detectFormatByUrl(state.snapshotSourceUrl || "");
    if (fromSnapshotUrl) return fromSnapshotUrl;

    return "";
  }

  function calculateDelivery(products) {
    var city = state.selectedCity;
    var totalsByFormat = { "120x60": 0, "60x60": 0 };
    var unknown = [];

    products.forEach(function (product) {
      var formatKey = resolveProductFormat(product);
      if (!formatKey) {
        unknown.push(product.title || "неизвестный товар");
        return;
      }
      totalsByFormat[formatKey] += product.quantity;
    });

    var calculation = {
      city: city,
      carrier: state.selectedCarrier,
      deliveryCost: 0,
      details: [],
      unknownProducts: unknown,
      totalsByFormat: totalsByFormat,
      hasAnyKnownFormat: totalsByFormat["120x60"] > 0 || totalsByFormat["60x60"] > 0,
      cartSubtotal: Number.isFinite(state.cartSubtotal) ? state.cartSubtotal : calculateProductsSubtotal(products),
      orderTotal: null,
      nativeFallbackUsed: false,
    };

    if (city && state.tariffsData && state.tariffsData.formats) {
      ["120x60", "60x60"].forEach(function (formatKey) {
        var qty = totalsByFormat[formatKey];
        if (qty <= 0) return;

        var unitWeight = getFormatUnitWeight(formatKey);
        var totalWeight = Number.isFinite(unitWeight) ? qty * unitWeight : NaN;
        var index = resolveColumnIndexByWeight(formatKey, totalWeight);
        var formatData = state.tariffsData.formats[formatKey];
        var cityTariff = formatData && formatData.tariffs && formatData.tariffs[city];
        var rawValue = cityTariff && cityTariff[index] ? cityTariff[index] : "";
        var parsedValue = parseRub(rawValue);

        if (Number.isFinite(parsedValue)) calculation.deliveryCost += parsedValue;

        calculation.details.push({
          format: formatKey,
          quantity: qty,
          totalWeight: totalWeight,
          columnIndex: index,
          columnLabel: state.columnsMeta[formatKey] && state.columnsMeta[formatKey].labels[index],
          rawValue: rawValue,
          parsedValue: parsedValue,
        });
      });
    }

    if (!Number.isFinite(calculation.deliveryCost) || calculation.deliveryCost <= 0) {
      var nativeDelivery = getSelectedNativeDeliveryPrice();
      if (Number.isFinite(nativeDelivery)) {
        calculation.deliveryCost = nativeDelivery;
        calculation.nativeFallbackUsed = true;
      }
    }

    var multiplier = Number(CONFIG.carrierMultipliers[state.selectedCarrier]);
    if (Number.isFinite(multiplier) && multiplier > 0) {
      calculation.deliveryCost = calculation.deliveryCost * multiplier;
    }

    var subtotal = Number.isFinite(calculation.cartSubtotal) ? calculation.cartSubtotal : 0;
    var delivery = Number.isFinite(calculation.deliveryCost) ? calculation.deliveryCost : 0;
    calculation.orderTotal = subtotal + delivery;

    return calculation;
  }

  function createContainer() {
    var container = null;
    if (CONFIG.containerSelector) container = document.querySelector(CONFIG.containerSelector);
    if (!container || !isElementVisible(container)) {
      var candidates = Array.prototype.slice.call(document.querySelectorAll("[data-nc-delivery-page]"));
      container = candidates.find(isElementVisible) || null;
    }
    if (container) return container;

    container = document.createElement("div");
    container.setAttribute("data-nc-delivery-page", "true");

    var preferredForm = pickPreferredForm(true) || pickPreferredForm(false);
    if (preferredForm && preferredForm.parentNode) {
      preferredForm.parentNode.insertBefore(container, preferredForm);
      return container;
    }

    // Если контейнер не задан явно, добавляем в конец #allrecords,
    // чтобы не ломать порядок инициализации штатных блоков Tilda.
    var allRecords = document.querySelector("#allrecords");
    if (allRecords) {
      allRecords.appendChild(container);
    } else if (document.body) {
      document.body.appendChild(container);
    }
    return container;
  }

  function ensureStyles() {
    if (document.getElementById("nc-delivery-page-style")) return;
    var style = document.createElement("style");
    style.id = "nc-delivery-page-style";
    style.textContent =
      ".nc-delivery-page{--nc-orange:#FF6B35;--nc-orange-dark:#E85A2A;--nc-ink:#1A1A1A;--nc-muted:#8D8D8D;--nc-line:#EDEDED;--nc-bg:#fff;--nc-bg-soft:#F8F8F8;margin:0 0 20px;padding:32px 36px;border:1px solid var(--nc-line);border-radius:16px;background:var(--nc-bg);font-family:inherit;color:var(--nc-ink);box-shadow:0 4px 28px rgba(0,0,0,.05);letter-spacing:0}" +
      ".nc-delivery-page__head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin:0 0 26px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--nc-line)}" +
      ".nc-delivery-page__head-title{font-size:26px;font-weight:700;letter-spacing:.02em;margin:0;text-transform:uppercase;line-height:1.1}" +
      ".nc-delivery-page__head-sub{font-size:13px;color:var(--nc-muted);margin-top:8px;line-height:1.5;max-width:560px}" +
      ".nc-delivery-page__layout{display:grid;grid-template-columns:minmax(290px,.95fr) minmax(380px,1.1fr);gap:40px;align-items:start}" +
      ".nc-delivery-page__left{display:flex;flex-direction:column;gap:22px}" +
      ".nc-delivery-page__right{padding-left:32px;border-left:1px solid var(--nc-line);display:flex;flex-direction:column;gap:16px}" +
      ".nc-delivery-page__field{margin:0}" +
      ".nc-delivery-page__field-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}" +
      ".nc-delivery-page__field-label{font-size:11px;font-weight:700;color:var(--nc-ink);letter-spacing:.14em;text-transform:uppercase;margin:0}" +
      ".nc-delivery-page__tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--nc-ink);color:#fff;font-size:10px;font-weight:700;cursor:help;user-select:none;line-height:1}" +
      ".nc-delivery-page__tip::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:var(--nc-ink);color:#fff;font-size:11px;font-weight:500;line-height:1.35;text-transform:none;letter-spacing:0;padding:8px 10px;border-radius:8px;white-space:normal;width:240px;opacity:0;pointer-events:none;transition:opacity .15s;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:10}" +
      ".nc-delivery-page__tip::before{content:'';position:absolute;bottom:calc(100% + 2px);left:50%;transform:translateX(-50%) rotate(45deg);width:8px;height:8px;background:var(--nc-ink);opacity:0;pointer-events:none;transition:opacity .15s}" +
      ".nc-delivery-page__tip:hover::after,.nc-delivery-page__tip:focus::after,.nc-delivery-page__tip:hover::before,.nc-delivery-page__tip:focus::before{opacity:1}" +
      ".nc-delivery-page__hint{font-size:11px;color:var(--nc-muted);margin-top:6px;line-height:1.45}" +
      ".nc-delivery-page__hint a{color:var(--nc-orange);text-decoration:none;border-bottom:1px dashed var(--nc-orange)}" +
      ".nc-delivery-page__hint a:hover{color:var(--nc-orange-dark);border-bottom-color:var(--nc-orange-dark)}" +
      ".nc-delivery-page__carriers{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}" +
      ".nc-delivery-page__carrier{border:1.5px solid var(--nc-line);background:var(--nc-bg);padding:18px 12px;border-radius:12px;font-size:12px;font-weight:600;letter-spacing:.03em;cursor:pointer;transition:all .2s;color:var(--nc-ink);text-align:center;line-height:1.35;min-height:64px;display:flex;align-items:center;justify-content:center}" +
      ".nc-delivery-page__carrier:hover{border-color:var(--nc-ink)}" +
      ".nc-delivery-page__carrier[aria-pressed='true']{border-color:var(--nc-ink);background:var(--nc-ink);color:#fff}" +
      ".nc-delivery-page__field select,.nc-delivery-page__field input{width:100%;height:42px;padding:0 12px;border:1px solid var(--nc-line);border-radius:10px;background:var(--nc-bg);font-size:13px;color:var(--nc-ink);font-family:inherit;transition:.15s;outline:none}" +
      ".nc-delivery-page__field select#nc-delivery-city{max-width:360px}" +
      ".nc-delivery-page__stats{display:grid;grid-template-columns:repeat(2,minmax(120px,1fr));gap:8px}" +
      ".nc-delivery-page__stat{padding:10px 10px;border:1px solid var(--nc-line);border-radius:10px;background:var(--nc-bg-soft)}" +
      ".nc-delivery-page__stat-label{display:block;font-size:10px;color:var(--nc-muted);text-transform:uppercase;letter-spacing:.08em}" +
      ".nc-delivery-page__stat-value{display:block;margin-top:4px;font-size:13px;font-weight:700;color:var(--nc-ink)}" +
      ".nc-delivery-page__field select:focus,.nc-delivery-page__field input:focus{border-color:var(--nc-ink)}" +
      ".nc-delivery-page__field select{appearance:none;-webkit-appearance:none;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' stroke='%23111' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>\");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}" +
      ".nc-delivery-page__status{font-size:12px;color:var(--nc-muted);margin:0}" +
      ".nc-delivery-page__summary{display:none}" +
      ".nc-delivery-page__warning{font-size:12px;color:#c7352c;margin:0;line-height:1.5}" +
      ".nc-delivery-page__details{display:none}" +
      ".nc-delivery-page__customer{display:grid;grid-template-columns:1fr 1fr;gap:12px}" +
      ".nc-delivery-page__customer .nc-delivery-page__field{margin:0}" +
      ".nc-delivery-page__customer .nc-delivery-page__field--full{grid-column:1/-1}" +
      ".nc-delivery-page__customer input{width:100%;height:48px;padding:0 16px;border:1px solid var(--nc-line);border-radius:10px;background:var(--nc-bg);font-size:14px;color:var(--nc-ink);font-family:inherit;transition:border-color .15s;outline:none}" +
      ".nc-delivery-page__customer input:focus{border-color:var(--nc-ink)}" +
      ".nc-delivery-page__customer input::placeholder{color:#B0B0B0}" +
      ".nc-delivery-page__city-input{width:100%;height:48px;padding:0 16px;border:1px solid var(--nc-line);border-radius:10px;background:var(--nc-bg);font-size:14px;color:var(--nc-ink);font-family:inherit;transition:border-color .15s;outline:none}" +
      ".nc-delivery-page__city-input:focus{border-color:var(--nc-ink)}" +
      ".nc-delivery-page__city-input::placeholder{color:#B0B0B0}" +
      ".nc-delivery-page__pay{margin-top:14px}" +
      ".nc-delivery-page__pay button{width:100%;height:46px;padding:0 20px;border:0;border-radius:10px;background:var(--nc-ink);color:#fff;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:.15s;font-family:inherit}" +
      ".nc-delivery-page__pay button:hover{background:#000}" +
      ".nc-delivery-page__products-title{margin:0 0 6px;font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--nc-ink)}" +
      ".nc-delivery-page__products-wrap{display:flex;flex-direction:column}" +
      ".nc-delivery-page__product-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--nc-line)}" +
      ".nc-delivery-page__product-row:last-child{border-bottom:0}" +
      ".nc-delivery-page__product-meta{display:flex;align-items:center;gap:14px;min-width:0}" +
      ".nc-delivery-page__product-image{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--nc-line);flex:0 0 64px;background:var(--nc-bg-soft)}" +
      ".nc-delivery-page__product-name{font-size:13px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:240px;text-transform:uppercase;letter-spacing:.04em}" +
      ".nc-delivery-page__product-sub{display:block;font-size:11px;color:var(--nc-muted);margin-top:5px;letter-spacing:.01em}" +
      ".nc-delivery-page__product-price{font-size:14px;font-weight:600;white-space:nowrap;color:var(--nc-ink)}" +
      ".nc-delivery-page__totals{margin-top:18px;padding:18px 0 0;border-top:1px solid var(--nc-line)}" +
      ".nc-delivery-page__row{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin:10px 0;color:var(--nc-ink);align-items:baseline}" +
      ".nc-delivery-page__row span{color:var(--nc-muted);letter-spacing:.02em}" +
      ".nc-delivery-page__row strong{font-size:14px;font-weight:600}" +
      ".nc-delivery-page__row--final{font-size:14px;font-weight:700;margin-top:16px;padding-top:18px;border-top:1px solid var(--nc-ink);text-transform:uppercase;letter-spacing:.08em}" +
      ".nc-delivery-page__row--final span{color:var(--nc-ink);font-weight:700}" +
      ".nc-delivery-page__row--final strong{font-size:28px;color:var(--nc-orange);letter-spacing:0}" +
      ".nc-delivery-page__empty{color:var(--nc-muted);font-size:13px;padding:12px 0}" +
      ".nc-delivery-page__pickup-wrap{margin-top:10px}" +
      ".nc-delivery-page__pickup-wrap label{display:block;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--nc-ink);margin-bottom:6px}" +
      ".nc-delivery-page__pickup-wrap select{width:100%;height:42px;padding:0 12px;border:1px solid var(--nc-line);border-radius:10px;background:var(--nc-bg);font-family:inherit}" +
      ".nc-delivery-page__stepper{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 24px;padding-bottom:20px;border-bottom:1px solid var(--nc-line);flex-wrap:wrap}" +
      ".nc-delivery-page__step-item{display:flex;align-items:center;gap:12px;flex:0 1 auto}" +
      ".nc-delivery-page__step-dot{flex:0 0 28px;width:28px;height:28px;border-radius:50%;background:var(--nc-bg-soft);border:1.5px solid var(--nc-line);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--nc-muted);transition:.2s}" +
      ".nc-delivery-page__step-title{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--nc-muted);line-height:1.2;transition:.2s}" +
      ".nc-delivery-page__step-item--active .nc-delivery-page__step-dot{background:var(--nc-orange);border-color:var(--nc-orange);color:#fff}" +
      ".nc-delivery-page__step-item--active .nc-delivery-page__step-title{color:var(--nc-ink)}" +
      ".nc-delivery-page__step-item--done .nc-delivery-page__step-dot{background:var(--nc-ink);border-color:var(--nc-ink);color:#fff}" +
      ".nc-step-panel{display:none}" +
      ".nc-step-panel--active{display:block}" +
      ".nc-delivery-page__nav-row{display:flex;gap:10px;margin-top:14px;justify-content:space-between;align-items:center;flex-wrap:wrap}" +
      ".nc-delivery-page__btn-back{background:transparent;border:1px solid var(--nc-line);color:var(--nc-ink);height:46px;padding:0 18px;border-radius:10px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:.15s}" +
      ".nc-delivery-page__btn-back:hover{border-color:var(--nc-ink)}" +
      ".nc-delivery-page__btn-next{background:var(--nc-orange);border:0;color:#fff;height:46px;padding:0 28px;border-radius:10px;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:.15s;flex:1 0 auto;max-width:340px;box-shadow:0 4px 14px rgba(255,90,31,.25)}" +
      ".nc-delivery-page__btn-next:hover{background:var(--nc-orange-dark);box-shadow:0 6px 18px rgba(255,90,31,.35)}" +
      ".nc-delivery-page__btn-next:disabled{background:#cccccc;box-shadow:none;cursor:not-allowed}" +
      ".nc-delivery-page__error{color:#c7352c;font-size:12px;margin:8px 0 0;line-height:1.45;min-height:0;font-weight:600}" +
      ".nc-delivery-page__review{background:var(--nc-bg-soft);border:1px solid var(--nc-line);border-radius:12px;padding:16px;margin:0 0 14px}" +
      ".nc-delivery-page__review-row{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed var(--nc-line)}" +
      ".nc-delivery-page__review-row:last-child{border-bottom:0}" +
      ".nc-delivery-page__review-row span{color:var(--nc-muted)}" +
      ".nc-delivery-page__review-row strong{color:var(--nc-ink);font-weight:600;text-align:right;word-break:break-word;max-width:62%}" +
      ".nc-delivery-page__secure{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--nc-muted);margin-top:8px;justify-content:center;flex-wrap:wrap}" +
      ".nc-delivery-page__secure svg{flex:0 0 14px}" +
      ".nc-delivery-page__pay button{background:var(--nc-orange);color:#fff;box-shadow:0 4px 14px rgba(255,90,31,.25)}" +
      ".nc-delivery-page__pay button:hover{background:var(--nc-orange-dark);box-shadow:0 6px 18px rgba(255,90,31,.35)}" +
      ".nc-skeleton{position:relative;overflow:hidden;background:var(--nc-bg-soft);border-radius:8px;min-height:20px}" +
      ".nc-skeleton::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);animation:nc-shimmer 1.3s infinite}" +
      "@keyframes nc-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}" +
      "@media (max-width: 980px){.nc-delivery-page{padding:18px}.nc-delivery-page__layout{grid-template-columns:1fr;gap:18px}.nc-delivery-page__right{padding-left:0;border-left:0;border-top:1px solid var(--nc-line);padding-top:18px;order:-1;position:sticky;top:0;background:var(--nc-bg);z-index:5}.nc-delivery-page__product-name{max-width:200px}.nc-delivery-page__tip::after{width:200px}.nc-delivery-page__field select#nc-delivery-city{max-width:100%}.nc-delivery-page__stepper{gap:6px}.nc-delivery-page__step-item{min-width:130px;gap:6px}.nc-delivery-page__step-title{font-size:10px}}" +
      "@media (max-width: 640px){.nc-delivery-page{padding:14px;border-radius:14px}.nc-delivery-page__head-title{font-size:18px}.nc-delivery-page__carriers{grid-template-columns:1fr 1fr 1fr;gap:6px}.nc-delivery-page__carrier{min-height:48px;font-size:11px;padding:10px 6px}.nc-delivery-page__product-name{font-size:13px}.nc-delivery-page__product-price{font-size:14px}.nc-delivery-page__row--final strong{font-size:20px}.nc-delivery-page__tip::after{width:170px;left:0;transform:none}.nc-delivery-page__tip::before{left:8px;transform:rotate(45deg)}.nc-delivery-page__customer{grid-template-columns:1fr}.nc-delivery-page__step-title{display:none}.nc-delivery-page__step-bar{min-width:24px}.nc-delivery-page__btn-next{padding:0 18px;font-size:12px}}";
    document.head.appendChild(style);
  }

  function buildFieldBlock(label, tip, hintHtml, innerHtml) {
    return (
      "<div class='nc-delivery-page__field'>" +
      "<div class='nc-delivery-page__field-head'>" +
      "<span class='nc-delivery-page__field-label'>" + escapeHtml(label) + "</span>" +
      (tip ? "<span class='nc-delivery-page__tip' tabindex='0' data-tip=\"" + escapeHtml(tip) + "\">?</span>" : "") +
      "</div>" +
      innerHtml +
      (hintHtml ? "<div class='nc-delivery-page__hint'>" + hintHtml + "</div>" : "") +
      "</div>"
    );
  }

  function buildUi() {
    ensureStyles();
    refs.root = createContainer();
    refs.root.classList.add("nc-delivery-page");

    var carrierBlock = buildFieldBlock(
      "Транспортная компания",
      "Выберите удобную для вас службу доставки. «Курьер Новокерамик» — доставка по Краснодарскому краю нашим транспортом. Для СДЭК и Деловых Линий ниже появится поле выбора пункта выдачи.",
      "Не знаете, что выбрать? Напишите нам в мессенджер — поможем подобрать оптимальный способ доставки под ваш заказ.",
      "<div class='nc-delivery-page__carriers' data-role='carriers'></div>"
    );

    var cityBlock = "";

    var productsHintHtml =
      "Если вы видите не те позиции или не хватает товара — <a href='/catalog' >вернитесь в каталог</a> и проверьте корзину.";

    var stepperHtml =
      "<div class='nc-delivery-page__stepper' role='navigation' aria-label='Шаги оформления'>" +
      "<div class='nc-delivery-page__step-item nc-delivery-page__step-item--active' data-step='1'>" +
      "<span class='nc-delivery-page__step-dot'>1</span>" +
      "<span class='nc-delivery-page__step-title'>Доставка и данные</span>" +
      "</div>" +
      "<div class='nc-delivery-page__step-item' data-step='2'>" +
      "<span class='nc-delivery-page__step-dot'>2</span>" +
      "<span class='nc-delivery-page__step-title'>Подтверждение и оплата</span>" +
      "</div>" +
      "</div>";

    var step1Html =
      "<div class='nc-step-panel nc-step-panel--active' data-role='step-1'>" +
      carrierBlock +
      "<datalist id='nc-city-datalist' data-role='city-datalist'></datalist>" +
      "<div class='nc-delivery-page__field'>" +
      "<div class='nc-delivery-page__field-head'>" +
      "<span class='nc-delivery-page__field-label'>Город доставки</span>" +
      "<span class='nc-delivery-page__tip' tabindex='0' data-tip='Начните вводить город — появятся подсказки из тарифной таблицы. Стоимость доставки посчитается автоматически.'>?</span>" +
      "</div>" +
      "<input type='text' data-role='customer-address' placeholder='Начните вводить город' autocomplete='address-level2' list='nc-city-datalist' class='nc-delivery-page__city-input'>" +
      "<div class='nc-delivery-page__hint'>Если вашего города нет в списке — <a href='https://wa.me/79189860121' target='_blank' rel='noopener'>обратитесь к менеджеру</a>, мы вам поможем.</div>" +
      "</div>" +
      "<div class='nc-delivery-page__status' data-role='status'></div>" +
      "<div class='nc-delivery-page__customer' style='margin-top:6px'>" +
      "<div class='nc-delivery-page__field nc-delivery-page__field--full'><input type='text' data-role='customer-name' placeholder='Ваше имя' autocomplete='name'></div>" +
      "<div class='nc-delivery-page__field nc-delivery-page__field--full'><input type='tel' data-role='customer-phone' placeholder='+7 (___) ___-__-__' autocomplete='tel' inputmode='tel'></div>" +
      "<div class='nc-delivery-page__field nc-delivery-page__field--full'><input type='text' data-role='customer-street' placeholder='Улица' autocomplete='address-line1'></div>" +
      "<div class='nc-delivery-page__field'><input type='text' data-role='customer-house' placeholder='Дом' autocomplete='address-line2' inputmode='numeric'></div>" +
      "<div class='nc-delivery-page__field'><input type='text' data-role='customer-flat' placeholder='Квартира' autocomplete='off' inputmode='numeric'></div>" +
      "</div>" +
      "<div class='nc-delivery-page__summary' data-role='products-summary'></div>" +
      "<div class='nc-delivery-page__warning' data-role='warning'></div>" +
      "<div class='nc-delivery-page__details' data-role='details'></div>" +
      "<div class='nc-delivery-page__error' data-role='step1-error'></div>" +
      "<div class='nc-delivery-page__nav-row'>" +
      "<span></span>" +
      "<button type='button' class='nc-delivery-page__btn-next' data-role='go-to-step-2'>Далее &rarr;</button>" +
      "</div>" +
      "</div>";

    var step2Html =
      "<div class='nc-step-panel' data-role='step-2'>" +
      "<div class='nc-delivery-page__review' data-role='review'></div>" +
      "<div class='nc-delivery-page__error' data-role='step2-error'></div>" +
      "<div class='nc-delivery-page__pay'><button type='button' data-role='pay-now'>Оплатить 0 ₽</button></div>" +
      "<div class='nc-delivery-page__secure'>" +
      "<svg width='14' height='14' viewBox='0 0 24 24' fill='none'><path d='M12 2L4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4z' stroke='%238a8a8a' stroke-width='1.6'/></svg>" +
      "<span>Защищённый платёж через Т-Банк · SSL</span>" +
      "</div>" +
      "<div class='nc-delivery-page__nav-row'>" +
      "<button type='button' class='nc-delivery-page__btn-back' data-role='go-to-step-1'>&larr; Назад</button>" +
      "<span></span>" +
      "</div>" +
      "</div>";

    refs.root.innerHTML =
      "<div class='nc-delivery-page__head'>" +
      "<div>" +
      "<div class='nc-delivery-page__head-title'>Оформление заказа</div>" +
      "<div class='nc-delivery-page__head-sub'>Выберите доставку и заполните данные — на следующем шаге подтвердите заказ и оплатите через Т-Банк.</div>" +
      "</div>" +
      "</div>" +
      stepperHtml +
      "<div class='nc-delivery-page__layout'>" +
      "<div class='nc-delivery-page__left'>" +
      step1Html +
      step2Html +
      "</div>" +
      "<div class='nc-delivery-page__right'>" +
      "<div class='nc-delivery-page__field-head' style='margin-bottom:0'>" +
      "<span class='nc-delivery-page__field-label'>Ваш заказ</span>" +
      "<span class='nc-delivery-page__tip' tabindex='0' data-tip='Состав заказа переносится автоматически из корзины каталога. Изменить количество можно в стандартной корзине Tilda.'>?</span>" +
      "</div>" +
      "<div class='nc-delivery-page__products' data-role='products-list'></div>" +
      "<div class='nc-delivery-page__hint'>" + productsHintHtml + "</div>" +
      "<div class='nc-delivery-page__totals'>" +
      "<div class='nc-delivery-page__row'><span>Сумма товаров</span><strong data-role='cart-total'>0 ₽</strong></div>" +
      "<div class='nc-delivery-page__row'><span>Доставка</span><strong data-role='delivery-total'>0 ₽</strong></div>" +
      "<div class='nc-delivery-page__row nc-delivery-page__row--final'><span>Итого к оплате</span><strong data-role='order-total'>0 ₽</strong></div>" +
      "</div>" +
      "</div>" +
      "</div>";

    refs.carrierHost = refs.root.querySelector("[data-role='carriers']");
    refs.citySelect = null;
    refs.cityDatalist = refs.root.querySelector("[data-role='city-datalist']");
    refs.status = refs.root.querySelector("[data-role='status']");
    refs.stats = null;
    refs.productsSummary = refs.root.querySelector("[data-role='products-summary']");
    refs.productsList = refs.root.querySelector("[data-role='products-list']");
    refs.photoInput = null;
    refs.photoList = null;
    refs.photoFallbackHost = null;
    refs.photoFallbackInput = null;
    refs.warning = refs.root.querySelector("[data-role='warning']");
    refs.details = refs.root.querySelector("[data-role='details']");
    refs.cartTotal = refs.root.querySelector("[data-role='cart-total']");
    refs.deliveryTotal = refs.root.querySelector("[data-role='delivery-total']");
    refs.orderTotal = refs.root.querySelector("[data-role='order-total']");
    refs.payButton = refs.root.querySelector("[data-role='pay-now']");
    refs.customerName = refs.root.querySelector("[data-role='customer-name']");
    refs.customerPhone = refs.root.querySelector("[data-role='customer-phone']");
    refs.customerAddress = refs.root.querySelector("[data-role='customer-address']");
    refs.customerStreet = refs.root.querySelector("[data-role='customer-street']");
    refs.customerHouse = refs.root.querySelector("[data-role='customer-house']");
    refs.customerFlat = refs.root.querySelector("[data-role='customer-flat']");
    refs.stepPanel1 = refs.root.querySelector("[data-role='step-1']");
    refs.stepPanel2 = refs.root.querySelector("[data-role='step-2']");
    refs.stepBtnNext = refs.root.querySelector("[data-role='go-to-step-2']");
    refs.stepBtnBack = refs.root.querySelector("[data-role='go-to-step-1']");
    refs.stepItems = refs.root.querySelectorAll(".nc-delivery-page__step-item");
    refs.stepBar1 = refs.root.querySelector("[data-role='step-bar-1']");
    refs.step1Error = refs.root.querySelector("[data-role='step1-error']");
    refs.step2Error = refs.root.querySelector("[data-role='step2-error']");
    refs.review = refs.root.querySelector("[data-role='review']");

    buildCarrierButtons();
    ensurePickupField();
    bindUiHandlers();
    bindPhoneFormatter();
  }

  function bindPhoneFormatter() {
    if (!refs.customerPhone) return;
    refs.customerPhone.addEventListener("input", function (e) {
      var digits = (e.target.value || "").replace(/\D/g, "");
      if (digits.startsWith("8")) digits = "7" + digits.slice(1);
      if (!digits.startsWith("7")) digits = "7" + digits;
      digits = digits.slice(0, 11);
      var out = "+7";
      if (digits.length > 1) out += " (" + digits.slice(1, 4);
      if (digits.length >= 5) out += ") " + digits.slice(4, 7);
      if (digits.length >= 8) out += "-" + digits.slice(7, 9);
      if (digits.length >= 10) out += "-" + digits.slice(9, 11);
      e.target.value = out;
    });
  }

  function goToStep(step) {
    state.currentStep = step;
    if (refs.stepPanel1) refs.stepPanel1.classList.toggle("nc-step-panel--active", step === 1);
    if (refs.stepPanel2) refs.stepPanel2.classList.toggle("nc-step-panel--active", step === 2);
    if (refs.stepItems && refs.stepItems.length) {
      refs.stepItems.forEach(function (el) {
        var s = Number(el.getAttribute("data-step"));
        el.classList.toggle("nc-delivery-page__step-item--active", s === step);
        el.classList.toggle("nc-delivery-page__step-item--done", s < step);
      });
    }
    /* step-bar removed */
    if (refs.step1Error) refs.step1Error.textContent = "";
    if (refs.step2Error) refs.step2Error.textContent = "";
    if (step === 2) renderReview();
    try {
      refs.root.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {}
  }

  function renderReview() {
    if (!refs.review) return;
    var calc = state.calculation || {};
    var customer = getCustomerFromCheckoutUi();
    var carrier = getCarrierById(state.selectedCarrier);
    var rows = [
      { label: "Имя", value: customer.name || "—" },
      { label: "Телефон", value: customer.phone || "—" },
      { label: "Город", value: calc.city || customer.address || "—" },
      { label: "Улица", value: customer.street || "—" },
      { label: "Дом / кв.", value: (customer.house || "—") + (customer.flat ? ", кв. " + customer.flat : "") },
      { label: "Транспорт", value: carrier ? carrier.title : "—" },
      { label: "Сумма товаров", value: formatRub(calc.cartSubtotal || 0) },
      { label: "Доставка", value: formatRub(calc.deliveryCost || 0) },
    ];
    refs.review.innerHTML = rows.map(function (r) {
      return "<div class='nc-delivery-page__review-row'><span>" + escapeHtml(r.label) + "</span><strong>" + escapeHtml(r.value) + "</strong></div>";
    }).join("");
  }

  function getCarrierById(carrierId) {
    for (var i = 0; i < CONFIG.carriers.length; i += 1) {
      if (CONFIG.carriers[i].id === carrierId) return CONFIG.carriers[i];
    }
    return null;
  }

  function buildCarrierButtons() {
    refs.carrierHost.innerHTML = "";
    refs.carrierButtons = {};

    CONFIG.carriers.forEach(function (carrier) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nc-delivery-page__carrier";
      button.textContent = carrier.title;
      button.dataset.carrier = carrier.id;
      button.setAttribute("aria-pressed", carrier.id === state.selectedCarrier ? "true" : "false");
      button.addEventListener("click", function () {
        selectCarrier(carrier.id);
      });
      refs.carrierButtons[carrier.id] = button;
      refs.carrierHost.appendChild(button);
    });
  }

  function selectCarrier(carrierId) {
    state.selectedCarrier = carrierId;
    Object.keys(refs.carrierButtons).forEach(function (id) {
      refs.carrierButtons[id].setAttribute("aria-pressed", id === carrierId ? "true" : "false");
    });
    togglePickupField();
    recalcAndRender();
  }

  function ensurePickupField() {
    if (refs.pickupWrap) return;
    var houseInput = document.querySelector(
      "input[placeholder*='номер дома'], input[placeholder*='Номер дома'], input[name*='house']"
    );
    var anchor = houseInput ? houseInput.closest(".t-input-group") : null;
    if (!anchor || !anchor.parentNode) return;

    var wrap = document.createElement("div");
    wrap.className = "nc-delivery-page__pickup-wrap";
    wrap.style.display = "none";

    var label = document.createElement("label");
    label.textContent = "Пункт получения (опционально)";
    label.setAttribute("for", "nc-delivery-pickup");

    var select = document.createElement("select");
    select.id = "nc-delivery-pickup";

    CONFIG.pickupPoints.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });

    select.addEventListener("change", function () {
      state.selectedPickupPoint = select.value;
      if (state.calculation) syncHiddenFields(state.calculation);
    });

    wrap.appendChild(label);
    wrap.appendChild(select);

    if (anchor.nextSibling) {
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    } else {
      anchor.parentNode.appendChild(wrap);
    }

    refs.pickupWrap = wrap;
    refs.pickupSelect = select;
    togglePickupField();
  }

  function togglePickupField() {
    if (!refs.pickupWrap) return;
    var carrier = getCarrierById(state.selectedCarrier);
    var shouldShow = Boolean(carrier && carrier.hasPickup);
    refs.pickupWrap.style.display = shouldShow ? "block" : "none";
    if (!shouldShow) {
      state.selectedPickupPoint = "";
      if (refs.pickupSelect) refs.pickupSelect.value = "";
    }
  }

  function getAttachedPhotoNames() {
    var unique = {};
    (state.products || []).forEach(function (item) {
      var imageUrl = normalizeText(item && item.imageUrl ? item.imageUrl : "");
      if (!imageUrl) return;
      var clean = imageUrl.split("?")[0].split("#")[0];
      var slashIndex = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
      var fileName = slashIndex >= 0 ? clean.slice(slashIndex + 1) : clean;
      if (fileName) unique[fileName] = true;
    });
    return Object.keys(unique);
  }

  function renderPhotoSelection() {
    var maxFiles = Math.max(1, Number(CONFIG.photoMaxFiles) || 1);
    var names = getAttachedPhotoNames()
      .filter(Boolean)
      .slice(0, maxFiles);
    state.attachedPhotoNames = names.slice();
    if (!refs.photoList) return;
    refs.photoList.textContent = "";
  }

  function bindNativePhotoField() {
    refs.photoInput = null;
    if (refs.photoFallbackHost) refs.photoFallbackHost.style.display = "none";
    if (refs.photoWatcher) refs.photoWatcher.disconnect();
    if (refs.photoPollTimer) window.clearInterval(refs.photoPollTimer);
    if (refs.photoBindRetryTimer) window.clearTimeout(refs.photoBindRetryTimer);
    renderPhotoSelection();
  }

  function bindNativeCityControls() {
    refs.nativeCityRadios = Array.prototype.slice.call(document.querySelectorAll("input[name='towns_delivery']"));
    refs.nativeCityRadios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        state.selectedCity = getSelectedCityFromNativeRadios();
        if (refs.customerAddress && !refs.customerAddress.value && state.selectedCity) {
          refs.customerAddress.value = state.selectedCity;
        }
        recalcAndRender();
      });
    });

    state.selectedCity = getSelectedCityFromNativeRadios() || state.selectedCity || CONFIG.defaultCity || "";
    renderCitySelectOptions();
  }

  function bindUiHandlers() {
    if (refs.customerAddress) {
      var onCityChange = function () {
        state.selectedCity = normalizeText(refs.customerAddress.value);
        syncNativeRadioByCity(state.selectedCity);
        recalcAndRender();
      };
      refs.customerAddress.addEventListener("change", onCityChange);
      refs.customerAddress.addEventListener("input", onCityChange);
    }

    if (refs.stepBtnNext) {
      refs.stepBtnNext.addEventListener("click", function () {
        var customer = getCustomerFromCheckoutUi();
        if (!state.selectedCity) {
          if (refs.step1Error) refs.step1Error.textContent = "Выберите город доставки.";
          return;
        }
        var err = validateCustomerForPayment(customer);
        if (err) {
          if (refs.step1Error) refs.step1Error.textContent = err;
          return;
        }
        if (refs.step1Error) refs.step1Error.textContent = "";
        goToStep(2);
      });
    }

    if (refs.stepBtnBack) {
      refs.stepBtnBack.addEventListener("click", function () {
        goToStep(1);
      });
    }

    if (refs.payButton) {
      refs.payButton.addEventListener("click", function () {
        if (CONFIG.submitMode !== "redirect" && CONFIG.submitMode !== "tbank") {
          if (refs.step2Error) refs.step2Error.textContent = "Оплата временно недоступна. Свяжитесь с менеджером.";
          return;
        }
        if (refs.step2Error) refs.step2Error.textContent = "";
        refs.payButton.disabled = true;
        refs.payButton.textContent = "Создаём ссылку на оплату...";
        startPaymentFlow(null).catch(function (err) {
          refs.payButton.disabled = false;
          if (refs.step2Error) refs.step2Error.textContent = (err && err.message) || "Ошибка оплаты. Попробуйте ещё раз.";
          updatePayButtonLabel();
        });
      });
    }
  }

  function updatePayButtonLabel() {
    if (!refs.payButton) return;
    var total = state.calculation && Number.isFinite(state.calculation.orderTotal) ? state.calculation.orderTotal : 0;
    refs.payButton.textContent = "Оплатить " + formatRub(total);
  }

  function setStatus(text) {
    refs.status.textContent = text || "";
  }

  function ensureHiddenFieldsHost() {
    if (refs.hiddenFieldsHost) return refs.hiddenFieldsHost;
    var chosen = pickPreferredForm(false) || pickPreferredForm(true);
    refs.hiddenFieldsHost = chosen || null;
    state.selectedForm = refs.hiddenFieldsHost;
    return refs.hiddenFieldsHost;
  }

  function ensureHiddenField(name) {
    var host = ensureHiddenFieldsHost();
    if (!host) return null;
    if (state.hiddenFields[name]) return state.hiddenFields[name];
    var fullName = CONFIG.fieldPrefix + name;
    var field = host.querySelector("input[name='" + fullName + "']");
    if (!field) {
      field = document.createElement("input");
      field.type = "hidden";
      field.name = fullName;
      host.appendChild(field);
    }
    state.hiddenFields[name] = field;
    return field;
  }

  function ensureNativeField(name) {
    var host = ensureHiddenFieldsHost();
    if (!host) return null;
    var field = host.querySelector("input[name='" + name + "']");
    if (!field) {
      field = document.createElement("input");
      field.type = "hidden";
      field.name = name;
      host.appendChild(field);
    }
    return field;
  }

  function setHidden(name, value) {
    var field = ensureHiddenField(name);
    if (field) field.value = value || "";
  }

  function setNative(name, value) {
    var field = ensureNativeField(name);
    if (field) field.value = value || "";
  }

  function buildDetailsText(calc) {
    if (!calc.details.length) return "";
    return calc.details
      .map(function (item) {
        var cost = Number.isFinite(item.parsedValue) ? formatRub(item.parsedValue) : "N/A";
        return item.format + ": qty " + item.quantity + ", cost " + cost;
      })
      .join("; ");
  }

  function getTotalWeight(calc) {
    if (!calc.details.length) return "";
    var sum = 0;
    calc.details.forEach(function (item) {
      if (Number.isFinite(item.totalWeight)) sum += item.totalWeight;
    });
    return Number.isFinite(sum) && sum > 0 ? String(sum.toFixed(1)) : "";
  }

  function syncHiddenFields(calc) {
    setHidden("city", calc.city || "");
    setHidden("carrier", state.selectedCarrier);
    setHidden("pickup_point", state.selectedPickupPoint || "");
    setHidden("photo_names", state.attachedPhotoNames.join(", "));
    setHidden("photo_count", String(state.attachedPhotoNames.length || 0));
    setHidden(
      "product_images",
      state.products
        .map(function (item) {
          return item && item.imageUrl ? item.imageUrl : "";
        })
        .filter(Boolean)
        .join(", ")
    );
    setHidden("cost", Number.isFinite(calc.deliveryCost) ? String(calc.deliveryCost) : "");
    setHidden("qty_120x60", String(calc.totalsByFormat["120x60"] || 0));
    setHidden("qty_60x60", String(calc.totalsByFormat["60x60"] || 0));
    setHidden("cart_subtotal", Number.isFinite(calc.cartSubtotal) ? String(calc.cartSubtotal) : "");
    setHidden("final_total", Number.isFinite(calc.orderTotal) ? String(calc.orderTotal) : "");
    setHidden("details", buildDetailsText(calc));

    setNative("delivery_city", calc.city || "");
    setNative("delivery_cost", Number.isFinite(calc.deliveryCost) ? String(calc.deliveryCost) : "");
    setNative("delivery_weight", getTotalWeight(calc));
    setNative(
      "tile_size",
      [
        (calc.totalsByFormat["120x60"] || 0) > 0 ? "120x60" : "",
        (calc.totalsByFormat["60x60"] || 0) > 0 ? "60x60" : "",
      ]
        .filter(Boolean)
        .join(", ")
    );

    var nativeDeliveryField =
      document.querySelector("input[name='delivery']") || document.querySelector("input[name='delivery_price']");
    if (nativeDeliveryField && Number.isFinite(calc.deliveryCost)) {
      nativeDeliveryField.value = String(calc.deliveryCost);
    }
  }

  function renderProductsSummary(calc) {
    refs.productsSummary.textContent =
      "Товары для расчета: 120x60 = " +
      (calc.totalsByFormat["120x60"] || 0) +
      " шт, 60x60 = " +
      (calc.totalsByFormat["60x60"] || 0) +
      " шт";
  }

  function renderStats(calc) {
    return;
    /* stats block removed for cleaner UI */
    if (!refs.stats) return;
    var carrier = getCarrierById(state.selectedCarrier);
    var carrierTitle = carrier ? carrier.title : "Не выбрано";
    var city = calc.city || "Не выбран";
    var html =
      "<div class='nc-delivery-page__stat'><span class='nc-delivery-page__stat-label'>Город</span><span class='nc-delivery-page__stat-value'>" +
      escapeHtml(city) +
      "</span></div>" +
      "<div class='nc-delivery-page__stat'><span class='nc-delivery-page__stat-label'>ТК</span><span class='nc-delivery-page__stat-value'>" +
      escapeHtml(carrierTitle) +
      "</span></div>" +
      "<div class='nc-delivery-page__stat'><span class='nc-delivery-page__stat-label'>120x60</span><span class='nc-delivery-page__stat-value'>" +
      escapeHtml(String(calc.totalsByFormat["120x60"] || 0) + " шт") +
      "</span></div>" +
      "<div class='nc-delivery-page__stat'><span class='nc-delivery-page__stat-label'>60x60</span><span class='nc-delivery-page__stat-value'>" +
      escapeHtml(String(calc.totalsByFormat["60x60"] || 0) + " шт") +
      "</span></div>";
    refs.stats.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderProductsList() {
    if (!refs.productsList) return;
    if (!Array.isArray(state.products) || !state.products.length) {
      refs.productsList.innerHTML = "<div class='nc-delivery-page__empty'>Корзина пока пустая или не удалось получить товары из каталога.</div>";
      return;
    }

    var html = "<div class='nc-delivery-page__products-title'>Товары из корзины</div>" + "<div class='nc-delivery-page__products-wrap'>";

    state.products.forEach(function (item) {
      var qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      var unitPrice = Number.isFinite(item.unitPrice) ? item.unitPrice : null;
      var lineTotal =
        Number.isFinite(item.lineTotal) && item.lineTotal > 0
          ? item.lineTotal
          : Number.isFinite(item.unitPrice)
          ? item.unitPrice * qty
          : null;
      var rightText = Number.isFinite(lineTotal)
        ? formatRub(lineTotal) + " (" + qty + " шт)"
        : qty + " шт";
      var subText = Number.isFinite(unitPrice) ? formatRub(unitPrice) + " / шт" : "";
      var imageHtml = item.imageUrl
        ? "<img src='" +
          escapeHtml(item.imageUrl) +
          "' alt='" +
          escapeHtml(item.title || "Товар") +
          "' class='nc-delivery-page__product-image'/>"
        : "<div class='nc-delivery-page__product-image'></div>";
      html +=
        "<div class='nc-delivery-page__product-row'>" +
        "<span class='nc-delivery-page__product-meta'>" +
        imageHtml +
        "<span>" +
        "<span class='nc-delivery-page__product-name'>" +
        escapeHtml(item.title || "Товар") +
        "</span>" +
        "<span class='nc-delivery-page__product-sub'>" +
        escapeHtml(subText) +
        "</span>" +
        "</span>" +
        "</span>" +
        "<strong class='nc-delivery-page__product-price'>" +
        escapeHtml(rightText) +
        "</strong>" +
        "</div>";
    });

    html += "</div>";
    refs.productsList.innerHTML = html;
  }

  function renderDetails(calc) {
    if (!calc.details.length) {
      refs.details.textContent = "";
      return;
    }
    refs.details.textContent = calc.details
      .map(function (item) {
        var weightText = Number.isFinite(item.totalWeight) ? item.totalWeight.toFixed(1) + " кг" : "n/a";
        var costText = Number.isFinite(item.parsedValue) ? formatRub(item.parsedValue) : "n/a";
        return item.format + " — " + item.quantity + " шт, " + weightText + ", " + costText;
      })
      .join(" | ");
  }

  function renderWarning(calc) {
    if (!state.selectedCity) {
      refs.warning.textContent = "Выберите город доставки в блоке ниже.";
      return;
    }

    if (!calc.hasAnyKnownFormat) {
      refs.warning.textContent =
        "Не удалось автоматически определить формат 120x60/60x60 для товаров в корзине.";
      return;
    }

    if (calc.unknownProducts.length) {
      refs.warning.textContent = "Некоторые товары пропущены: " + calc.unknownProducts.join(", ");
      return;
    }

    refs.warning.textContent = "";
  }

  function renderTotals(calc) {
    refs.deliveryTotal.textContent = formatRub(calc.deliveryCost);
    refs.cartTotal.textContent = formatRub(calc.cartSubtotal || 0);
    refs.orderTotal.textContent = formatRub(calc.orderTotal || 0);
    updatePayButtonLabel();
    if (state.currentStep === 2) renderReview();
  }

  function renderStatus(calc) {
    var carrier = getCarrierById(state.selectedCarrier);
    var carrierTitle = carrier ? carrier.title : state.selectedCarrier;
    var cityPart = calc.city ? "Город: " + calc.city : "Город не выбран";
    var carrierPart = "ТК: " + carrierTitle;
    var fallbackPart = calc.nativeFallbackUsed ? " (цена взята из формы доставки)" : "";
    setStatus(cityPart + " | " + carrierPart + fallbackPart);
  }

  function recalcAndRender() {
    var cityFromInput = refs.customerAddress ? normalizeText(refs.customerAddress.value) : "";
    var cityFromNative = getSelectedCityFromNativeRadios();
    state.selectedCity = cityFromInput || cityFromNative || state.selectedCity || CONFIG.defaultCity || "";
    state.calculation = calculateDelivery(state.products);
    var calc = state.calculation;

    renderStatus(calc);
    renderStats(calc);
    renderProductsSummary(calc);
    renderProductsList();
    renderPhotoSelection();
    renderWarning(calc);
    renderDetails(calc);
    renderTotals(calc);
    syncHiddenFields(calc);
  }

  function refreshProductsAndRender() {
    bindNativePhotoField();
    state.products = collectCartProducts();
    recalcAndRender();
  }

  function bindAutoRefresh() {
    if (refs.autoRefreshObserver) refs.autoRefreshObserver.disconnect();
    if (refs.autoRefreshTimer) window.clearTimeout(refs.autoRefreshTimer);

    var observeRoot =
      (refs.hiddenFieldsHost && refs.hiddenFieldsHost.closest(".t706")) ||
      refs.hiddenFieldsHost ||
      document.body;
    if (!observeRoot || typeof MutationObserver === "undefined") return;

    refs.autoRefreshObserver = new MutationObserver(function (mutations) {
      var shouldRefresh = mutations.some(function (mutation) {
        if (!refs.root) return true;
        var target = mutation.target;
        if (target && refs.root.contains(target)) return false;
        for (var i = 0; i < mutation.addedNodes.length; i += 1) {
          if (!refs.root.contains(mutation.addedNodes[i])) return true;
        }
        for (var j = 0; j < mutation.removedNodes.length; j += 1) {
          if (!refs.root.contains(mutation.removedNodes[j])) return true;
        }
        return mutation.type === "attributes";
      });

      if (!shouldRefresh) return;
      if (refs.autoRefreshTimer) window.clearTimeout(refs.autoRefreshTimer);
      refs.autoRefreshTimer = window.setTimeout(function () {
        refreshProductsAndRender();
      }, 220);
    });

    refs.autoRefreshObserver.observe(observeRoot, { childList: true, subtree: true, attributes: true });
  }

  function buildRedirectUrl(calc) {
    if (!CONFIG.paymentRedirectUrl) return "";
    return CONFIG.paymentRedirectUrl
      .replace("{deliveryCost}", encodeURIComponent(calc.deliveryCost || 0))
      .replace("{orderTotal}", encodeURIComponent(calc.orderTotal || 0))
      .replace("{city}", encodeURIComponent(calc.city || ""))
      .replace("{carrier}", encodeURIComponent(state.selectedCarrier || ""));
  }

  async function startPaymentFlow(form) {
    if (CONFIG.submitMode !== "redirect" && CONFIG.submitMode !== "tbank") return;
    if (!state.calculation) return;
    if (window.__ncPaymentRedirectInProgress) return;

    var target = "";
    try {
      window.__ncPaymentRedirectInProgress = true;
      if (CONFIG.submitMode === "tbank") {
        setStatus("Создаем ссылку на оплату Т-Банк...");
        target = await requestTbankPaymentUrl(state.calculation, form);
        if (!target) {
          setStatus("Не удалось создать ссылку на оплату. Проверьте настройки Т-Банк.");
          window.__ncPaymentRedirectInProgress = false;
          return;
        }
      } else {
        target = buildRedirectUrl(state.calculation);
      }
    } catch (err) {
      console.error("[NovoDeliveryPage] Payment init error", err);
      var message = err && err.message ? err.message : "";
      setStatus(message || "Ошибка инициализации оплаты. Попробуйте еще раз или свяжитесь с менеджером.");
      window.__ncPaymentRedirectInProgress = false;
      return;
    }

    if (!target) {
      window.__ncPaymentRedirectInProgress = false;
      return;
    }

    window.setTimeout(function () {
      window.location.href = target;
    }, Math.max(0, Number(CONFIG.redirectDelayMs) || 0));
  }

  function normalizePhone(raw) {
    var text = normalizeText(raw);
    if (!text) return "";
    var digits = text.replace(/[^\d+]/g, "");
    if (!digits) return "";
    if (digits[0] !== "+" && digits[0] === "8") return "+7" + digits.slice(1);
    if (digits[0] !== "+" && digits[0] === "7") return "+" + digits;
    return digits;
  }

  function getCustomerFromCheckoutUi() {
    return {
      name: normalizeText(refs.customerName && refs.customerName.value),
      phone: normalizePhone(refs.customerPhone && refs.customerPhone.value),
      email: "",
      address: normalizeText(refs.customerAddress && refs.customerAddress.value),
      street: normalizeText(refs.customerStreet && refs.customerStreet.value),
      house: normalizeText(refs.customerHouse && refs.customerHouse.value),
      flat: normalizeText(refs.customerFlat && refs.customerFlat.value),
    };
  }

  function getCustomerFromForm(form) {
    var fromUi = getCustomerFromCheckoutUi();
    if (fromUi.name || fromUi.phone || fromUi.address || fromUi.street || fromUi.house) {
      return fromUi;
    }

    var scope = form && form.querySelectorAll ? form : document;
    var fields = Array.prototype.slice.call(scope.querySelectorAll("input, textarea"));
    var out = { name: "", phone: "", email: "", address: "", street: "", house: "", flat: "" };

    fields.forEach(function (field) {
      if (!field) return;
      var value = normalizeText(field.value);
      if (!value) return;
      var bag = (field.name || "") + " " + (field.id || "") + " " + (field.placeholder || "");
      bag = bag.toLowerCase();
      if (!out.email && /mail|e-mail|почт/.test(bag) && /@/.test(value)) out.email = value;
      if (!out.phone && /phone|tel|тел|моб/.test(bag)) out.phone = normalizePhone(value);
      if (!out.name && /name|имя|fio|фио/.test(bag)) out.name = value;
    });

    return out;
  }

  function validateCustomerForPayment(customer) {
    if (!customer.name) return "Введите имя.";
    if (!customer.phone || customer.phone.replace(/[^\d]/g, "").length < 11) return "Введите корректный номер телефона.";
    if (!customer.address) return "Введите адрес доставки.";
    if (!customer.street) return "Введите улицу.";
    if (!customer.house) return "Введите номер дома.";
    return "";
  }

  function buildTbankOrderId() {
    return "NC-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
  }

  async function requestTbankPaymentUrl(calc, form) {
    if (!CONFIG.tbankCreatePaymentUrl) return "";
    var totalRub = Number(calc && calc.orderTotal);
    if (!Number.isFinite(totalRub) || totalRub <= 0) return "";

    var customer = getCustomerFromForm(form);
    var customerError = validateCustomerForPayment(customer);
    if (customerError) throw new Error(customerError);
    var payload = {
      orderId: buildTbankOrderId(),
      amount: Math.round(totalRub * 100),
      description: "Оплата заказа NovoCeramic",
      city: calc.city || "",
      carrier: state.selectedCarrier || "",
      deliveryCost: Number.isFinite(calc.deliveryCost) ? calc.deliveryCost : 0,
      cartSubtotal: Number.isFinite(calc.cartSubtotal) ? calc.cartSubtotal : 0,
      customer: customer,
      successUrl: CONFIG.tbankSuccessUrl || "",
      failUrl: CONFIG.tbankFailUrl || "",
      notificationUrl: CONFIG.tbankNotificationUrl || "",
      products: (state.products || []).map(function (item) {
        var qty = Number.isFinite(item.quantity) ? item.quantity : 1;
        var price = Number.isFinite(item.unitPrice) ? item.unitPrice : 0;
        return {
          title: item.title || "Товар",
          quantity: qty,
          unitPrice: price,
          lineTotal: Number.isFinite(item.lineTotal) ? item.lineTotal : price * qty,
          sku: item.sku || "",
        };
      }),
    };

    var response = await fetch(CONFIG.tbankCreatePaymentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("tbank_init_failed_" + response.status);
    var data = await response.json();
    return normalizeText(data.paymentUrl || data.PaymentURL || data.url || "");
  }

  function bindFormHandlers() {
    var forms = document.querySelectorAll(CONFIG.formSelector);
    forms.forEach(function (form) {
      form.addEventListener("submit", function () {
        if (state.calculation) syncHiddenFields(state.calculation);
      });

      form.addEventListener("tildaform:aftersuccess", async function () {
        await startPaymentFlow(form);
      });
    });
  }

  async function loadTariffsData() {
    var inlineData = getInlineTariffsData();
    if (inlineData) {
      state.tariffsData = inlineData;
      buildColumnsMeta();
      return;
    }

    var url = resolveTariffsUrl();
    var response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("tariff_load_failed_" + response.status);
    state.tariffsData = await response.json();
    buildColumnsMeta();
  }

  async function init() {
    if (state.mounted) return;

    var tariffsLoadError = null;
    try {
      await loadTariffsData();
    } catch (err) {
      tariffsLoadError = err;
      // Не блокируем рендер страницы, если таблица тарифов недоступна.
      state.tariffsData = state.tariffsData || { formats: {} };
      state.columnsMeta = state.columnsMeta || {};
      console.error("[NovoDeliveryPage] Tariffs load error (fallback mode)", err);
    }

    try {
      buildUi();
      bindNativeCityControls();
      ensureHiddenFieldsHost();
      bindNativePhotoField();
      refreshProductsAndRender();
      bindAutoRefresh();
      bindFormHandlers();
      state.mounted = true;

      if (tariffsLoadError) {
        setStatus("Тарифы временно недоступны. Применен резервный расчет доставки.");
      }

      try {
        window.NovoDeliveryCheckoutLoadedAt = Date.now();
        document.dispatchEvent(
          new CustomEvent("nc_checkout_ready", {
            detail: { mounted: true, tariffsLoaded: !tariffsLoadError },
          })
        );
      } catch (eventErr) {
        // ignore event errors
      }

      log("initialized", { tariffsLoaded: !tariffsLoadError, version: BUILD_VERSION });
    } catch (err) {
      console.error("[NovoDeliveryPage] Init error", err);
      try {
        document.dispatchEvent(
          new CustomEvent("nc_checkout_ready", {
            detail: { mounted: false, error: String(err && err.message ? err.message : err) },
          })
        );
      } catch (eventErr) {
        // ignore event errors
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
