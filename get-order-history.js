// get-order-history.js

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   Tunables / Selectors (US)
   ========================= */
const BASE_URL = "https://www.amazon.com";
const ORDERS_URL = "https://www.amazon.com/gp/your-account/order-history";

const SELECTORS = {
  ORDER_CONTAINER: "#ordersContainer, .your-orders-content-container",
  ORDER_GROUP:
    "#ordersContainer .a-box-group.order, .your-orders-content-container .a-box-group",

  ORDER_DETAILS_ROWS: "#od-subtotals .a-row, #od-subtotalsV2 .a-row",
  ORDER_DETAILS_PURCHASES: "[data-component-name^='purchasedItems']",
  ORDER_DETAILS_ITEM_NAME:
    "[data-component-name^='purchasedItems'] [data-component-name^='itemTitle'] a",
  ORDER_DETAILS_ITEM_PRICE: "[data-component-name^='purchasedItems'] .a-price",
  ORDER_DETAILS_DATE: "[data-component-name^='orderDate']",
};

/* =========================
   Currency helpers (USD)
   ========================= */
const usdToCents = (value) => {
  if (!value) return 0;
  const s = String(value).replace(/\s+/g, " ").trim();
  // $1,234.56 or 1,234.56
  const m = s.match(/\$?\s*(\d{1,3}(,\d{3})*|\d+)\.\d{2}/);
  if (!m) return 0;
  const normalized = m[0].replace(/[^\d.]/g, "");
  const [dollars, cents = "00"] = normalized.split(".");
  return (parseInt(dollars, 10) || 0) * 100 + (parseInt(cents, 10) || 0);
};

const centsToUSD = (cents) => (cents / 100).toFixed(2); // CSV-friendly numeric

/* =========================
   Small helpers
   ========================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitUntil = async (
  checkFn,
  { timeoutMs = 5 * 60 * 1000, intervalMs = 1000 } = {},
) => {
  const start = Date.now();
  for (;;) {
    try {
      if (await checkFn()) return true;
    } catch {
      /* ignore transient errors */
    }
    if (Date.now() - start > timeoutMs)
      throw new Error("Timed out waiting for condition");
    await sleep(intervalMs);
  }
};

const getYearsFromArg = () => {
  if (process.argv[2]) return [process.argv[2]];
  const current = new Date().getFullYear();
  const years = [];
  for (let y = current; y >= 2000; y--) years.push(String(y));
  return years;
};

const loadCookies = async (page, p) => {
  try {
    if (!fs.existsSync(p)) return false;
    const cookies = JSON.parse(await fsp.readFile(p, "utf8"));
    for (const c of cookies) await page.setCookie(c);
    return true;
  } catch {
    return false;
  }
};

const saveCookies = async (page, p) => {
  const cookies = await page.cookies();
  await fsp.writeFile(p, JSON.stringify(cookies, null, 2), "utf8");
};

const ensureSignedInAndOnOrders = async (page, saveCookiesFn) => {
  // Go to Orders once; Amazon will redirect to /ap/signin if needed.
  await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded" });

  console.log("\nIf prompted, complete sign-in/MFA in the browser tab.");
  console.log("I will continue automatically when the Orders list loads…");

  // PASSIVE wait: do NOT navigate while the user is typing OTP/password.
  await waitUntil(
    async () => {
      // If Orders has rendered, we're done.
      const hasOrders = await page.$(SELECTORS.ORDER_CONTAINER);
      if (hasOrders) return true;

      // If we're on any Amazon sign-in/MFA/captcha route, keep waiting.
      const url = page.url();
      if (
        url.includes("/ap/signin") ||
        url.includes("/ap/mfa") ||
        url.includes("/ap/cvf") || // some challenge flows
        url.includes("/ap/challenge")
      ) {
        return false; // keep waiting; user is interacting
      }

      // If we're somewhere else (home, account), just wait — user might still be navigating.
      return false;
    },
    { timeoutMs: 10 * 60 * 1000, intervalMs: 1000 },
  );

  // Save cookies after successful login.
  try {
    await saveCookiesFn();
  } catch {}
};

const writeCSVRow = async (csvPath, rowData) => {
  const row =
    rowData.map((s) => `"${String(s).replace(/"/g, '""')}"`).join(";") + "\n";
  await fsp.appendFile(csvPath, row, "utf8");
};

const getOrderDetails = async (detailsPage, detailsHref) => {
  if (!detailsHref) return null;

  try {
    await detailsPage.goto(detailsHref, { waitUntil: "domcontentloaded" });
    await detailsPage.waitForSelector(
      "#orderDetails, .yohtmlc-order-details, #od-subtotals",
      { timeout: 15000 },
    );

    // DEBUG: Log page structure
    // console.debug('      🔍 Debugging page structure...');

    // Check if orderDate component exists
    const dateComponents = await detailsPage.$$(
      '[data-component-name*="date"], [data-component-name*="Date"]',
    );
    // console.debug(`      Found ${dateComponents.length} date components`);

    // Check if purchasedItems exists
    const purchaseComponents = await detailsPage.$$(
      '[data-component-name*="purchased"], [data-component-name*="item"]',
    );
    // console.debug(`      Found ${purchaseComponents.length} purchase/item components`);

    // Get order date - try multiple approaches
    let orderDate = "";

    // Try the component selector first
    let orderDateEl = await detailsPage.$(SELECTORS.ORDER_DETAILS_DATE);
    if (orderDateEl) {
      orderDate = await orderDateEl.evaluate((el) => el.textContent.trim());
      // console.debug(`      Date from component: "${orderDate}"`);
    }

    // Fallback: look for "Order placed" text
    if (!orderDate) {
      const rows = await detailsPage.$$(".a-row");
      // console.debug(`      Searching ${rows.length} rows for order placed text...`);
      for (const row of rows) {
        const text = await row.evaluate((el) => el.textContent.toLowerCase());
        if (text.includes("order placed")) {
          // console.debug(`      Found "order placed" in row: "${text.substring(0, 100)}..."`);

          // Extract date from the row text using regex (more reliable)
          const fullText = await row.evaluate((el) => el.textContent);
          const dateMatch = fullText.match(/(\w+\s+\d+,\s+\d{4})/);
          if (dateMatch) {
            orderDate = dateMatch[1];
            // console.debug(`      Extracted date from text: "${orderDate}"`);
            break;
          } else {
            // console.debug(`      No date pattern found in: "${fullText.trim()}"`);
          }
        }
      }
    }

    // Get financial summary data by finding rows with specific label text
    const financial = {};
    const summaryRows = await detailsPage.$$(SELECTORS.ORDER_DETAILS_ROWS);

    for (const row of summaryRows) {
      const rowText = await row.evaluate((el) => el.textContent.toLowerCase());
      const valueEl = await row.$(".a-span-last, .a-text-right.a-span-last");

      if (valueEl) {
        const value = await valueEl.evaluate((el) => el.textContent.trim());

        if (rowText.includes("subtotal")) {
          financial.subtotal = value;
        } else if (rowText.includes("estimated tax")) {
          financial.tax = value;
        } else if (
          rowText.includes("shipping") &&
          rowText.includes("handling")
        ) {
          financial.shipping = value;
        } else if (
          rowText.includes("grand total") ||
          rowText.includes("order total")
        ) {
          financial.grandTotal = value;
        }
      }
    }

    // Get items by processing each shipment
    const items = [];

    // Find all shipment containers
    const shipmentContainers = await detailsPage.$$(
      '[data-component="shipments"] .a-box',
    );

    for (const shipment of shipmentContainers) {
      // Get shipment status
      const statusEl = await shipment.$(".od-status-message .a-text-bold");
      let shipmentStatus = "Delivered";
      if (statusEl) {
        const statusText = await statusEl.evaluate((el) =>
          el.textContent.trim(),
        );
        if (statusText) {
          shipmentStatus = statusText;
        }
      }

      // Find all items in this shipment
      const itemContainers = await shipment.$$(
        '[data-component="purchasedItems"]',
      );

      for (const itemContainer of itemContainers) {
        // Get item name
        const nameEl = await itemContainer.$('[data-component="itemTitle"] a');
        const name = nameEl
          ? await nameEl.evaluate((el) => el.textContent.trim())
          : "";

        if (!name) continue;

        // Get item price
        const priceEl = await itemContainer.$(
          '[data-component="unitPrice"] .a-price .a-offscreen',
        );
        const priceText = priceEl
          ? await priceEl.evaluate((el) => el.textContent.trim())
          : "";

        // Get quantity (default to 1 if not found)
        let qty = 1;
        const qtyEl = await itemContainer.$(".od-item-view-qty");
        if (qtyEl) {
          const qtyText = await qtyEl.evaluate((el) => el.textContent.trim());
          const qtyNum = parseInt(qtyText, 10);
          if (qtyNum > 0) qty = qtyNum;
        }

        items.push({ name, qty, priceText, status: shipmentStatus });
      }
    }

    return {
      orderDate,
      subtotal: financial.subtotal || "",
      tax: financial.tax || "",
      shipping: financial.shipping || "",
      grandTotal: financial.grandTotal || "",
      items,
    };
  } catch (error) {
    console.warn(`Failed to get order details: ${error.message}`);
    return null;
  }
};

const processOrder = async (
  orderEl,
  page,
  detailsPage,
  detailsHref,
  csvPath,
) => {
  if (!detailsHref) {
    console.warn("      ⚠️ No details link found, skipping order");
    return 0;
  }

  // Get ALL data from details page only
  const details = await getOrderDetails(detailsPage, detailsHref);
  if (!details) {
    console.warn("      ⚠️ Failed to get details data, skipping order");
    return 0;
  }

  const orderDate = details.orderDate || "ERROR: order date not found";
  const subtotalCents = usdToCents(details.subtotal);
  const shippingCents = usdToCents(details.shipping);
  const taxCents = usdToCents(details.tax);

  console.log(
    `      Order: date ${details.orderDate} | subtotal ${details.subtotal} | tax ${details.tax} | shipping ${details.shipping} | items: ${details.items.length}`,
  );

  // Calculate order total from details components
  const orderTotalCents = subtotalCents + shippingCents + taxCents;
  process.stdout.write(
    `\n    📦 ${orderDate}, $${centsToUSD(orderTotalCents)}\n`,
  );

  let itemsTotal = 0;

  // Process items from details page
  for (const item of details.items) {
    const singleCents = usdToCents(item.priceText);
    const totalCents = singleCents * item.qty;

    // Only count toward total if delivered
    if (item.status === "Delivered") {
      itemsTotal += totalCents;
    }

    const itemName = item.name.slice(0, 80).replace(/;/g, ",");

    process.stdout.write(`      📄 ${itemName}\n`);
    process.stdout.write(
      `         (${item.qty}) ${centsToUSD(totalCents)} - ${item.status}\n`,
    );

    const rowData = [
      orderDate,
      item.status,
      String(item.qty),
      itemName,
      centsToUSD(singleCents),
      centsToUSD(item.status === "Delivered" ? totalCents : 0),
      "",
    ];

    await writeCSVRow(csvPath, rowData);
  }

  console.log("      ______________________________");
  console.log("      Subtotal: $" + centsToUSD(itemsTotal));
  console.log("      Tax: $" + centsToUSD(taxCents));

  // Add shipping row if present
  if (shippingCents > 0) {
    console.log("      Shipping: $" + centsToUSD(shippingCents));
    await writeCSVRow(csvPath, [
      orderDate,
      "",
      "1",
      "shipment",
      centsToUSD(shippingCents),
      centsToUSD(shippingCents),
      "",
    ]);
  }

  console.log("      ------------------------------");
  const grandTotal = itemsTotal + shippingCents + taxCents;
  console.log("      GrandTotal: $" + centsToUSD(grandTotal));

  return subtotalCents + shippingCents;
};

const processYear = async (page, detailsPage, year, csvPath, cookiesPath) => {
  console.log(`\nSTARTING ${year}`);
  let articleOffset = 0;
  let yearTotal = 0;
  let pageNumber = 1;

  while (true) {
    const listUrl = `${BASE_URL}/gp/your-account/order-history?orderFilter=year-${year}&startIndex=${articleOffset}`;

    process.stdout.write(`📄 Loading page ${pageNumber} for ${year}...`);

    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    process.stdout.write(` ✅ loaded!`);
    console.log(`\n🔍 Checking for orders...`);

    // re-ensure login if session expired mid-run
    const hasOrders = await page.$(SELECTORS.ORDER_CONTAINER);
    if (!hasOrders) {
      console.warn("⚠️ Session might have expired, re-checking login...");
      await ensureSignedInAndOnOrders(page, async () => {
        await saveCookies(page, cookiesPath);
      });
      // after re-login, reload the same page
      await page.goto(listUrl, { waitUntil: "domcontentloaded" });
      console.log("   ✅ Re-authenticated and page reloaded");
    }

    // Wait for orders container to render
    console.log("   ⏳ Waiting for orders container...");
    try {
      await page.waitForSelector(SELECTORS.ORDER_GROUP, {
        timeout: 5000,
      });
      console.log("   ✅ Orders container found");
    } catch (e) {
      console.log("   ⚠️ Orders container not found, continuing anyway");
    }

    const orderEls = await page.$$(SELECTORS.ORDER_GROUP);
    const countInPage = orderEls.length;

    if (countInPage === 0) {
      console.log(" ❌ No orders found");
      break;
    }

    process.stdout.write(` ✅ Found ${countInPage} orders!\n`);

    // collect a stable list of details links, 1:1 with orderEls
    const detailsHrefs = await Promise.all(
      orderEls.map((el) =>
        el
          .$eval('a.a-link-normal[href*="/order-details/"]', (a) => a.href)
          .catch(() => null),
      ),
    );

    // iterate orders
    for (let i = 0; i < orderEls.length; i++) {
      console.log(`\n  ⏳ Processing order ${i + 1}/${orderEls.length}:`);
      const orderTotal = await processOrder(
        orderEls[i],
        page,
        detailsPage,
        detailsHrefs[i],
        csvPath,
      );
      yearTotal += orderTotal;
    }

    if (countInPage < 10) break; // last page for the year
    articleOffset += 10;
    pageNumber++;
    await sleep(300); // small, human-ish pause
  }

  return yearTotal;
};

const main = async () => {
  const years = getYearsFromArg();
  const cookiesPath = path.resolve(__dirname, "cache/cookies/cookies_us.json");
  const csvPath = path.resolve(__dirname, "output/csv/amazon-orders-us.csv");

  // Ensure directories exist
  await fsp.mkdir(path.dirname(cookiesPath), { recursive: true });
  await fsp.mkdir(path.dirname(csvPath), { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled", // mild stealth
    ],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  const hadCookies = await loadCookies(page, cookiesPath);
  if (hadCookies) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  await ensureSignedInAndOnOrders(page, async () => {
    await saveCookies(page, cookiesPath);
  });

  const detailsPage = await browser.newPage();
  await detailsPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // write CSV header
  await fsp.writeFile(
    csvPath,
    '"Date";"Shipment Status";"Article Count";"Article Name";"Single Price";"Total Price";"Tags"\n',
    "utf8",
  );

  let runningTotal = 0;

  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    console.log(`\n🗓️  Processing year ${year} (${i + 1}/${years.length})`);
    const yearTotal = await processYear(
      page,
      detailsPage,
      year,
      csvPath,
      cookiesPath,
    );
    runningTotal += yearTotal;
    console.log(
      `✅ Year ${year} complete. Year total: $${centsToUSD(yearTotal)}`,
    );
    console.log(`💰 RUNNING TOTAL: $${centsToUSD(runningTotal)}`);
  }

  try {
    await saveCookies(page, cookiesPath);
  } catch {}
  await browser.close();

  console.log(`\nDone. CSV saved to: ${csvPath}`);
};

/* =========================
   Main (top-level await OK in ESM)
   ========================= */
await main();
