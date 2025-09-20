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
const returnedRegex = /(Return|Returned|Refund|Refunded|Replacement)/i;

const SELECTOR_ORDER_CONTAINER = "section.your-orders-content-container";
const SELECTOR_ORDER_GROUP = `${SELECTOR_ORDER_CONTAINER} .a-box-group`;
const SELECTOR_ORDER_DATE =
  ".order-header .a-fixed-right-grid-col.a-col-left .a-row .a-column.a-span3 .a-row span.aok-break-word";
const SELECTOR_ORDER_PRICE =
  ".order-header .a-fixed-right-grid-col.a-col-left .a-row .a-column.a-span2 .a-row span.aok-break-word";

const SELECTOR_ORDER_SHIPMENTS = ".a-box.shipment";
const SELECTOR_SHIPMENT_STATUS =
  ".a-box-inner .a-row.shipment-top-row.js-shipment-info-container";

const SELECTOR_ARTICLE_SHIPMENT =
  ".a-box-inner .a-fixed-right-grid.a-spacing-top-medium .a-fixed-right-grid-inner.a-grid-vertical-align.a-grid-top .a-fixed-right-grid-col.a-col-left .a-row .a-fixed-left-grid .a-fixed-left-grid-inner";
const SELECTOR_ARTICLE_NAME =
  ".a-fixed-left-grid-col.a-col-right div:nth-of-type(1).a-row";
const SELECTOR_ARTICLE_PRICE =
  ".a-fixed-left-grid-col.a-col-right div.a-row .a-size-small.a-color-price";

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

const textOrEmpty = async (el, selector) => {
  try {
    const child = await el.$(selector);
    if (!child) return "";
    const txt = await child.evaluate((n) => n.textContent.trim());
    return txt || "";
  } catch {
    return "";
  }
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

const waitForEnter = () =>
  new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });

const ensureSignedInAndOnOrders = async (page, saveCookiesFn) => {
  // Go to Orders once; Amazon will redirect to /ap/signin if needed.
  await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded" });

  console.log("\nIf prompted, complete sign-in/MFA in the browser tab.");
  console.log("I will continue automatically when the Orders list loads…");

  // PASSIVE wait: do NOT navigate while the user is typing OTP/password.
  await waitUntil(
    async () => {
      // If Orders has rendered, we’re done.
      const hasOrders = await page.$(SELECTOR_ORDER_CONTAINER);
      if (hasOrders) return true;

      // If we’re on any Amazon sign-in/MFA/captcha route, keep waiting.
      const url = page.url();
      if (
        url.includes("/ap/signin") ||
        url.includes("/ap/mfa") ||
        url.includes("/ap/cvf") || // some challenge flows
        url.includes("/ap/challenge")
      ) {
        return false; // keep waiting; user is interacting
      }

      // If we’re somewhere else (home, account), just wait — user might still be navigating.
      return false;
    },
    { timeoutMs: 10 * 60 * 1000, intervalMs: 1000 },
  );

  // Save cookies after successful login.
  try {
    await saveCookiesFn();
  } catch {}
};

/* =========================
   Main (top-level await OK in ESM)
   ========================= */
const years = getYearsFromArg();
const cookiesPath = path.resolve(__dirname, "cookies_us.json");
const csvPath = path.resolve(__dirname, "amazon-orders-us.csv");

const browser = await puppeteer.launch({
  headless: false, // headful to log in once
  defaultViewport: null,
  args: ["--start-maximized"],
});
const page = await browser.newPage();

await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
const hadCookies = await loadCookies(page, cookiesPath);
if (hadCookies) {
  await page.reload({ waitUntil: "domcontentloaded" });
}

await ensureSignedInAndOnOrders(page, async () => {
  await saveCookies(page, cookiesPath);
});

// write CSV header
await fsp.writeFile(
  csvPath,
  '"Date";"Shipment Status";"Article Count";"Article Name";"Single Price";"Total Price";"Tags"\n',
  "utf8",
);

let runningTotal = 0;

for (const year of years) {
  console.log(`\nSTARTING ${year}`);
  let articleOffset = 0;

  while (true) {
    const listUrl = `${BASE_URL}/gp/your-account/order-history?orderFilter=year-${year}&startIndex=${articleOffset}`;
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });

    // ⬇️ NEW: re-ensure login if session expired mid-run
    const hasOrders = await page.$(SELECTOR_ORDER_CONTAINER);
    if (!hasOrders) {
      console.warn("⚠️ Session might have expired, re-checking login...");
      await ensureSignedInAndOnOrders(page, async () => {
        await saveCookies(page, cookiesPath);
      });
      // after re-login, reload the same page
      await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    }

    // Wait for orders container to render
    await page
      .waitForSelector("section.your-orders-content-container", {
        timeout: 15000,
      })
      .catch(() => {});

    const orderEls = await page.$$(SELECTOR_ORDER_GROUP);
    const countInPage = orderEls.length;
    if (countInPage === 0) break;

    for (const orderEl of orderEls) {
      let orderArticlePricesTotal = 0;
      let orderTotalPaidAfterReturns = 0;

      const orderDate =
        (await textOrEmpty(orderEl, SELECTOR_ORDER_DATE)) ||
        "order_date_selector error";
      const orderPriceText = await textOrEmpty(orderEl, SELECTOR_ORDER_PRICE);
      const orderPriceCents = usdToCents(orderPriceText);
      console.log(`${orderDate}, ${centsToUSD(orderPriceCents)}`);

      const shipmentEls = await orderEl.$$(SELECTOR_ORDER_SHIPMENTS);
      for (const shipEl of shipmentEls) {
        const rawStatus =
          (await textOrEmpty(shipEl, SELECTOR_SHIPMENT_STATUS)) || "";
        const shipmentStatus = rawStatus.split("\n")[0].trim();
        const shipmentIsReturn = returnedRegex.test(shipmentStatus);
        console.log("  " + (shipmentStatus || "no shipment status shown"));

        const itemEls = await shipEl.$$(SELECTOR_ARTICLE_SHIPMENT);
        for (const itemEl of itemEls) {
          let articleName = await textOrEmpty(itemEl, SELECTOR_ARTICLE_NAME);
          articleName = articleName
            ? articleName.slice(0, 80).replace(/;/g, ",")
            : "article_name_selector error";

          // Simple quantity detection: "2 of ..." or "2 x ..."
          let articleCount = 1;
          const mCount = articleName.match(/^(\d+)\s+(of|x)\s+/i);
          if (mCount) {
            articleCount = parseInt(mCount[1], 10) || 1;
            articleName = articleName.replace(/^(\d+)\s+(of|x)\s+/i, "");
          }

          const priceText = await textOrEmpty(itemEl, SELECTOR_ARTICLE_PRICE);
          const singleCents = usdToCents(priceText);
          const lineCents = singleCents * articleCount;

          orderArticlePricesTotal += lineCents;
          if (!shipmentIsReturn) orderTotalPaidAfterReturns += lineCents;

          console.log(`    ${articleName}`);
          console.log(`    (${articleCount}) ${centsToUSD(lineCents)}`);

          const row =
            [
              orderDate,
              shipmentStatus,
              String(articleCount),
              articleName,
              centsToUSD(singleCents),
              centsToUSD(shipmentIsReturn ? 0 : lineCents),
              "",
            ]
              .map((s) => `"${String(s).replace(/"/g, '""')}"`)
              .join(";") + "\n";

          await fsp.appendFile(csvPath, row, "utf8");
        }
      }

      console.log(
        "order total paid after returns: " +
          centsToUSD(orderTotalPaidAfterReturns),
      );
      let shipmentCostCents = orderPriceCents - orderArticlePricesTotal;
      if (shipmentCostCents < 0) shipmentCostCents = 0; // gift cards/credits can make it negative

      console.log(
        "order total shipment costs: " + centsToUSD(shipmentCostCents),
      );

      if (shipmentCostCents > 0) {
        const shipRow =
          [
            orderDate,
            "",
            "1",
            "shipment",
            centsToUSD(shipmentCostCents),
            centsToUSD(shipmentCostCents),
            "",
          ]
            .map((s) => `"${String(s).replace(/"/g, '""')}"`)
            .join(";") + "\n";
        await fsp.appendFile(csvPath, shipRow, "utf8");
      }

      runningTotal += orderTotalPaidAfterReturns + shipmentCostCents;
    }

    if (countInPage < 10) break; // last page for the year
    articleOffset += 10;
  }

  console.log(`\nTOTAL SUM NOW: ${centsToUSD(runningTotal)}`);
}

try {
  await saveCookies(page, cookiesPath);
} catch {}
await browser.close();

console.log(`\nDone. CSV saved to: ${csvPath}`);
