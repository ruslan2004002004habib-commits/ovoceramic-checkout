(function () {
  "use strict";
  var BUILD_VERSION = "2026-04-28-bridge-v6-ios-pagehide";
  window.NovoCheckoutBridgeVersion = BUILD_VERSION;

  var CONFIG = Object.assign(
    {
      checkoutUrl: "",
      checkoutPath: "/payment-delivery",
      snapshotStorageKey: "nc_checkout_cart_snapshot",
      productFormatMapStorageKey: "nc_product_format_map",
      cartIconRedirect: false,
      checkoutButtonRedirect: true,
      addToCartSelectors: [
        ".js-store-prod-buy-btn",
        ".t-store__card__btn",
        ".js-product-btn",
        "[data-product-action='add']",
      ],
      cartIconSelectors: [
        ".t706__carticon",
        ".t706__carticon-wrapper",
        ".t-store__carticon",
        ".js-store-cart-link",
      ],
      checkoutButtonSelectors: [
        "#tcart .t-submit",
        "#tcart .t706__order-btn",
        "#tcart .t706__cartwin .t-btn",
        "#tcart .t706__cartpage-open-form",
        "#tcart .t706__sidebar-continue",
        "#tcart .t706__sidebar-bottom .t-btn",
        "#tcart .t706__sidebar-continue-btn",
        "#tcart .t706__cartpage-open",
        "#tcart .t-btn.t-submit",
        "#tcart .t-btn.t-btn_md",
        ".t706__cartwin-bottom .t-btn",
        ".t706__cartpage-bottom .t-btn",
      ],
      checkoutCtaTextIncludes: [
        "уточнить данные и оплатить",
        "уточнить данные",
        "оплатить",
        "перейти к оплате",
        "продолжить оформление",
        "оформить заказ",
        "checkout",
      ],
      debug: false,
    },
    window.NovoCheckoutRouteConfig || {}
  );

  function log() {
    if (!CONFIG.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[NovoCheckoutBridge]");
    console.log.apply(console, args);
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
      return normalizePath(new URL(String(rawUrl || ""), window.location.origin).pathname);
    } catch (err) {
      return normalizePath(window.location.pathname);
    }
  }

  function getFormatMapKey(title, sourceUrl) {
    return normalizeText(title).toLowerCase() + "|" + getPathFromUrl(sourceUrl || window.location.href);
  }

  function isSupportedFormat(value) {
    return value === "120x60" || value === "60x60";
  }

  function resolveFormatFromMap(map, title, sourceUrl) {
    if (!map) return "";
    var normalizedTitle = normalizeText(title).toLowerCase();
    if (!normalizedTitle) return "";

    var direct = map[getFormatMapKey(title, sourceUrl)];
    if (isSupportedFormat(direct)) return direct;

    var wildcard = map[normalizedTitle + "|*"];
    if (isSupportedFormat(wildcard)) return wildcard;

    var seen = {};
    Object.keys(map).forEach(function (key) {
      if (key.indexOf(normalizedTitle + "|") !== 0) return;
      var value = map[key];
      if (!isSupportedFormat(value)) return;
      seen[value] = true;
    });
    var variants = Object.keys(seen);
    return variants.length === 1 ? variants[0] : "";
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

  function writeProductFormatMap(map) {
    if (!window.localStorage) return;
    try {
      localStorage.setItem(CONFIG.productFormatMapStorageKey, JSON.stringify(map || {}));
    } catch (err) {
      // ignore storage errors
    }
  }

  function saveProductFormatHint(title, format, sourceUrl) {
    if (!title || !format) return;
    var map = readProductFormatMap();
    map[getFormatMapKey(title, sourceUrl)] = format;
    map[normalizeText(title).toLowerCase() + "|*"] = format;
    writeProductFormatMap(map);
  }

  function applyFormatHints(products, sourceUrl) {
    if (!Array.isArray(products) || !products.length) return products || [];
    var map = readProductFormatMap();
    var sourceFormat = detectFormatByUrl(sourceUrl || window.location.href);
    return products.map(function (item) {
      var direct =
        item.detectedFormat ||
        detectFormatByText([item.title, item.options, item.sku, item.article, item.sourceUrl].filter(Boolean).join(" "));
      var fromMap = resolveFormatFromMap(map, item.title, item.sourceUrl || sourceUrl);
      var format = direct || fromMap || sourceFormat || "";
      return Object.assign({}, item, { detectedFormat: format || "" });
    });
  }

  function parseNumber(raw) {
    if (raw === null || raw === undefined || raw === "") return NaN;
    var normalized = String(raw)
      .replace(/\u00a0/g, " ")
      .replace(/[^\d,.\- ]/g, "")
      .replace(/\s+/g, "")
      .replace(",", ".");
    return Number(normalized);
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

  function getProductsFromTcart() {
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

  function getProductsFromDom() {
    var cards = document.querySelectorAll(
      ".js-product, .t-store__card, .t-store__prod-popup, [data-product-gen-uid], [data-product-id]"
    );
    var list = [];

    cards.forEach(function (card) {
      var titleNode = card.querySelector(
        ".js-store-prod-name, .t-store__card__title, .t-name, [data-product-title]"
      );
      if (!titleNode) return;

      var title = normalizeText(titleNode.textContent);
      if (!title) return;

      var qtyNode = card.querySelector("input[name='quantity'], input[name='amount']");
      var qtyTextNode = card.querySelector("[data-product-amount]");
      var priceNode = card.querySelector(
        ".t-store__card__price, .js-product-price, [data-product-price], [data-price], .t-store__prod-popup__price"
      );
      var imageNode = card.querySelector("img[src], [data-original], [data-img-zoom-url]");
      var qty = 1;
      if (qtyNode && qtyNode.value) qty = parseNumber(qtyNode.value);
      if ((!qty || !Number.isFinite(qty)) && qtyTextNode) qty = parseNumber(qtyTextNode.textContent);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;

      var fullCardText = normalizeText(card.textContent);

      list.push(
        normalizeProduct({
          title: title,
          quantity: qty,
          options: fullCardText,
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

  function getProductsFromLocalStorage() {
    if (!window.localStorage) return [];
    var result = [];
    for (var i = 0; i < localStorage.length; i += 1) {
      var key = localStorage.key(i);
      if (!key) continue;
      // Читаем только родные Tilda-ключи корзины. Наши собственные ключи
      // (nc_*, snapshot) и кеш тарифов исключаем, иначе получаем дубли и
      // подмешивание строк тарифной таблицы (Анапа/при заказе...) в корзину.
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

  function getProductsFromCartDom() {
    var nodes = document.querySelectorAll("#tcart .t706__product, #tcart [data-cart-product-id], #tcart .t706__order-prod");
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

  function parseStoredSnapshot() {
    if (!window.localStorage) return null;
    try {
      var raw = localStorage.getItem(CONFIG.snapshotStorageKey);
      if (!raw) return null;
      var payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.products)) return null;
      return payload;
    } catch (err) {
      return null;
    }
  }

  function collectProducts(reason) {
    var fromTcart = getProductsFromTcart();
    if (fromTcart.length) return fromTcart;

    var fromCartDom = getProductsFromCartDom();
    if (fromCartDom.length) return fromCartDom;

    var fromStorage = getProductsFromLocalStorage();
    if (fromStorage.length) return fromStorage;

    // На клике "оформить" не подменяем корзину списком каталога.
    if (reason === "checkout_button_click" || reason === "checkout_text_cta_click") {
      return [];
    }

    return getProductsFromDom();
  }

  function parseCartSubtotal() {
    var totalNode = document.querySelector(
      "#tcart .t706__cartwin-totalamount-info_value, #tcart .t706__cartwin-totalamount-value, #tcart .t706__sidebar-prodamount, #tcart .t706__cartwin-prodamount, #tcart .t706__cartpage-prodamount, [data-cart-total]"
    );
    if (!totalNode) return null;
    var amount = parseNumber(totalNode.textContent);
    return Number.isFinite(amount) ? amount : null;
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

  function storeSnapshot(reason) {
    var products = dedupeProducts(collectProducts(reason)).map(function (item) {
      return Object.assign({}, item, { sourceUrl: item.sourceUrl || window.location.href });
    });
    var previous = parseStoredSnapshot();
    if (!products.length && previous && previous.products && previous.products.length) {
      products = previous.products.map(normalizeProduct);
    }
    products = applyFormatHints(products, window.location.href);
    products.forEach(function (item) {
      if (item && item.detectedFormat && item.title) {
        saveProductFormatHint(item.title, item.detectedFormat, item.sourceUrl || window.location.href);
      }
    });

    var payload = {
      version: 1,
      reason: reason || "manual",
      capturedAt: Date.now(),
      sourceUrl: window.location.href,
      subtotal:
        parseCartSubtotal() ||
        calculateProductsSubtotal(products) ||
        (previous && Number.isFinite(parseNumber(previous.subtotal)) ? parseNumber(previous.subtotal) : null),
      products: products,
    };
    localStorage.setItem(CONFIG.snapshotStorageKey, JSON.stringify(payload));
    log("snapshot saved", payload);
    return payload;
  }

  function resolveCheckoutUrl() {
    if (CONFIG.checkoutUrl) return CONFIG.checkoutUrl;
    if (/^https?:\/\//i.test(CONFIG.checkoutPath)) return CONFIG.checkoutPath;
    return window.location.origin + CONFIG.checkoutPath;
  }

  function normalizePath(path) {
    var normalized = String(path || "/").split("?")[0].split("#")[0];
    if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized;
  }

  function isOnCheckoutPage() {
    try {
      var checkoutPath = normalizePath(new URL(resolveCheckoutUrl(), window.location.origin).pathname);
      return normalizePath(window.location.pathname) === checkoutPath;
    } catch (err) {
      return false;
    }
  }

  function matchTarget(target, selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      if (target.closest(selectors[i])) return true;
    }
    return false;
  }

  function getContextTextForCard(card, target) {
    if (!card) return "";
    var chunks = [];

    chunks.push(card.textContent || "");

    var cardLink = card.querySelector("a[href]");
    if (cardLink) chunks.push(cardLink.getAttribute("href") || "");

    var nearestRec = card.closest(".t-rec");
    if (nearestRec) {
      var heading = nearestRec.querySelector(".t-title, .t-name, h1, h2, h3, [data-elem-type='text']");
      if (heading) chunks.push(heading.textContent || "");
      if (nearestRec.previousElementSibling) {
        chunks.push(nearestRec.previousElementSibling.textContent || "");
      }
    }

    if (target && target.closest) {
      var popup = target.closest(".t-store__prod-popup");
      if (popup) chunks.push(popup.textContent || "");
    }

    var attrs = [];
    Array.prototype.slice.call(card.attributes || []).forEach(function (attr) {
      if (!attr || !attr.name) return;
      if (!/^data-|href$/i.test(attr.name)) return;
      attrs.push(attr.value || "");
    });
    if (attrs.length) chunks.push(attrs.join(" "));

    chunks.push(document.title || "");
    chunks.push(window.location.href || "");

    return normalizeText(chunks.filter(Boolean).join(" "));
  }

  function captureFormatHintFromTarget(target) {
    if (!target || !target.closest) return;
    var card = target.closest(".js-product, .t-store__card, .t-store__prod-popup, [data-product-gen-uid], [data-product-id]");
    if (!card) return;
    var titleNode = card.querySelector(
      ".js-store-prod-name, .t-store__card__title, .t-name, [data-product-title], .t-store__prod-popup__title"
    );
    var title = normalizeText(titleNode ? titleNode.textContent : "");
    if (!title) return;

    var contextText = getContextTextForCard(card, target);
    var detected = detectFormatByText(contextText) || detectFormatByUrl(window.location.href);
    if (!detected) return;
    saveProductFormatHint(title, detected, window.location.href);
  }

  function redirectToCheckout(reason) {
    storeSnapshot(reason);
    var targetUrl = resolveCheckoutUrl();
    if (!targetUrl) return;
    if (isOnCheckoutPage()) {
      log("already on checkout page, skip redirect");
      return;
    }
    log("redirecting to checkout", targetUrl);
    window.location.href = targetUrl;
  }

  function matchesCheckoutText(target) {
    var node = target.closest("button, a, .t-btn, .t-btnflex, [role='button']");
    if (!node) return false;
    var text = normalizeText(node.textContent).toLowerCase();
    if (!text) return false;
    for (var i = 0; i < CONFIG.checkoutCtaTextIncludes.length; i += 1) {
      var phrase = normalizeText(CONFIG.checkoutCtaTextIncludes[i]).toLowerCase();
      if (phrase && text.indexOf(phrase) !== -1) return true;
    }
    return false;
  }

  function deferRedirect(reason) {
    // На мобильной Tilda корзина рендерится асинхронно. Даём 80 мс, чтобы
    // window.tcart успел обновиться, затем делаем снапшот и редирект.
    window.setTimeout(function () {
      storeSnapshot(reason);
      window.setTimeout(function () {
        redirectToCheckout(reason);
      }, 20);
    }, 80);
  }

  function bindClickRouting() {
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (!target || !target.closest) return;

        if (matchTarget(target, CONFIG.addToCartSelectors)) {
          captureFormatHintFromTarget(target);
          window.setTimeout(function () {
            storeSnapshot("add_to_cart_click");
          }, 250);
          return;
        }

        // На клик по иконке корзины делаем превентивный снапшот, даже если не редиректим.
        if (matchTarget(target, CONFIG.cartIconSelectors)) {
          window.setTimeout(function () {
            storeSnapshot("cart_icon_open");
          }, 150);
          if (CONFIG.cartIconRedirect) {
            event.preventDefault();
            event.stopPropagation();
            deferRedirect("cart_icon_click");
          }
          return;
        }

        if (CONFIG.checkoutButtonRedirect && matchTarget(target, CONFIG.checkoutButtonSelectors)) {
          event.preventDefault();
          event.stopPropagation();
          deferRedirect("checkout_button_click");
          return;
        }

        if (CONFIG.checkoutButtonRedirect && matchesCheckoutText(target)) {
          event.preventDefault();
          event.stopPropagation();
          deferRedirect("checkout_text_cta_click");
        }
      },
      true
    );
  }

  function bindUnloadSnapshot() {
    // iOS Safari не запускает beforeunload надёжно — для него нужен pagehide.
    // Регистрируем оба, чтобы гарантированно зафиксировать снапшот перед уходом.
    var handler = function (reason) {
      return function () {
        try {
          storeSnapshot(reason);
        } catch (err) {
          // ignore storage errors on unload
        }
      };
    };
    window.addEventListener("pagehide", handler("pagehide"));
    window.addEventListener("beforeunload", handler("beforeunload"));
    window.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") handler("visibilitychange_hidden")();
    });
  }

  function init() {
    bindClickRouting();
    bindUnloadSnapshot();
    storeSnapshot("init");
    log("bridge initialized", { version: BUILD_VERSION });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
