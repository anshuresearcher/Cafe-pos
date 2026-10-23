const { app, BrowserWindow, Menu, net, protocol, shell, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const printerBridge = require("./printer-bridge");

protocol.registerSchemesAsPrivileged([{
    scheme: "cafe-pos",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

const DEFAULT_API_SERVER = "https://cafe-pos-six-gamma.vercel.app";
const USER_SETTINGS_FILE = "desktop-settings.json";
let apiServerUrl = DEFAULT_API_SERVER;
let mainWindow = null;
let settingsWindow = null;
let activeBluetoothSelection = null;

function normalizeApiServer(value) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    let parsed;
    try { parsed = new URL(raw); }
    catch { throw new Error("Enter a valid server URL, such as https://your-pos.example.com"); }
    const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !isLocalHttp) {
        throw new Error("Use HTTPS for a hosted server. HTTP is allowed only for localhost.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("The server URL cannot include credentials, a query string, or a fragment.");
    }
    const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
    return `${parsed.origin}${pathname}`;
}

function appRoot() {
    return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}

function contentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ({
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon"
    })[ext] || "application/octet-stream";
}

async function registerAppProtocol() {
    await protocol.handle("cafe-pos", async request => {
        const url = new URL(request.url);
        if (url.hostname !== "app") return new Response("Not found", { status: 404 });

        // Keep the renderer on its secure app origin and forward API requests
        // through Electron's network stack. This avoids browser CORS failures
        // when the desktop UI talks to a hosted POS server.
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
            const targetUrl = `${apiServerUrl}${url.pathname}${url.search}`;
            const headers = new Headers(request.headers);
            for (const header of ["origin", "host", "content-length", "connection", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) {
                headers.delete(header);
            }
            const options = { method: request.method, headers, redirect: "follow" };
            if (request.method !== "GET" && request.method !== "HEAD") {
                options.body = Buffer.from(await request.arrayBuffer());
            }
            try {
                return await net.fetch(targetUrl, options);
            } catch (error) {
                console.error("POS server request failed:", error);
                return Response.json({ error: "Could not reach the POS server. Check the server connection and try again." }, { status: 502 });
            }
        }

        let relativePath;
        try { relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html"; }
        catch { return new Response("Bad request", { status: 400 }); }
        if (relativePath.includes("\0")) return new Response("Bad request", { status: 400 });

        const fromDesktop = relativePath.startsWith("desktop/");
        const baseDirectory = fromDesktop
            ? path.join(app.getAppPath(), "desktop")
            : path.resolve(appRoot(), "public");
        const filePath = path.resolve(baseDirectory, fromDesktop ? relativePath.slice("desktop/".length) : relativePath);
        if (!filePath.startsWith(baseDirectory + path.sep)) return new Response("Not found", { status: 404 });

        try {
            const data = await fs.readFile(filePath);
            return new Response(data, { headers: { "Content-Type": contentType(filePath), "Cache-Control": "no-store" } });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    });
}

async function readUserSettings() {
    try {
        const value = JSON.parse(await fs.readFile(path.join(app.getPath("userData"), USER_SETTINGS_FILE), "utf8"));
        if (value.apiServerUrl) apiServerUrl = normalizeApiServer(value.apiServerUrl);
    } catch (error) {
        if (error.code !== "ENOENT") console.warn("Could not read Slash POS desktop settings:", error.message);
    }
}

async function saveApiServer(value) {
    const normalized = normalizeApiServer(value);
    const filePath = path.join(app.getPath("userData"), USER_SETTINGS_FILE);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ apiServerUrl: normalized }, null, 2), "utf8");
    apiServerUrl = normalized;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
        finishBluetoothSelection(mainWindow.webContents, "");
        mainWindow.loadURL("cafe-pos://app/index.html");
    }
    return { success: true, apiServerUrl: normalized };
}

function secureWindow(window) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("cafe-pos://app/")) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1024,
        minHeight: 700,
        show: false,
        title: "Slash POS",
        icon: path.join(__dirname, "assets", "cafe-pilot-icon.ico"),
        backgroundColor: "#f6f7f9",
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        }
    });
    secureWindow(mainWindow);
    mainWindow.webContents.on("select-bluetooth-device", (event, devices, callback) => {
        handleBluetoothDeviceSelection(mainWindow, event, devices, callback);
    });
    mainWindow.once("ready-to-show", () => {
        if (!mainWindow) return;
        mainWindow.maximize();
        mainWindow.show();
        sendMainWindowState();
    });
    mainWindow.on("maximize", sendMainWindowState);
    mainWindow.on("unmaximize", sendMainWindowState);
    mainWindow.on("closed", () => {
        if (mainWindow) finishBluetoothSelection(mainWindow.webContents, "");
        mainWindow = null;
    });
    mainWindow.loadURL("cafe-pos://app/index.html");
    return mainWindow;
}

function sendMainWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("desktop:window-state", { maximized: mainWindow.isMaximized() });
}

function requireMainWindow(event) {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
        throw new Error("This desktop action is unavailable in this window.");
    }
    return mainWindow;
}

function finishBluetoothSelection(webContents, deviceId = "") {
    const selection = activeBluetoothSelection;
    if (!selection || selection.webContents !== webContents) return false;
    const normalizedId = String(deviceId || "");
    if (normalizedId && !selection.devices.has(normalizedId)) return false;
    activeBluetoothSelection = null;
    try { selection.callback(normalizedId); }
    catch (error) { console.warn("Could not complete Bluetooth device selection:", error.message); }
    if (!webContents.isDestroyed()) webContents.send("desktop:bluetooth-selection-finished");
    return true;
}

function handleBluetoothDeviceSelection(window, event, deviceList, callback) {
    event.preventDefault();
    const webContents = window.webContents;
    if (window !== mainWindow || window.isDestroyed() || !webContents.getURL().startsWith("cafe-pos://app/")) {
        try { callback(""); } catch (_) {}
        return;
    }

    if (!activeBluetoothSelection || activeBluetoothSelection.webContents !== webContents) {
        activeBluetoothSelection = { webContents, callback, devices: new Map() };
    } else {
        activeBluetoothSelection.callback = callback;
    }
    for (const device of Array.isArray(deviceList) ? deviceList : []) {
        if (!device?.deviceId) continue;
        activeBluetoothSelection.devices.set(String(device.deviceId), {
            deviceId: String(device.deviceId),
            deviceName: String(device.deviceName || "")
        });
    }
    webContents.send("desktop:bluetooth-devices", {
        devices: Array.from(activeBluetoothSelection.devices.values())
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
}

function makeInvoicePdfHtml(bill = {}, settings = {}, pageHeightMm = 220) {
    const currency = String(settings.currency || "₹").slice(0, 8);
    const amount = value => {
        const number = Number(value || 0);
        return escapeHtml(currency) + (Number.isFinite(number) ? number : 0).toFixed(2);
    };
    const items = Array.isArray(bill.items) ? bill.items.slice(0, 500) : [];
    const optionText = options => Array.isArray(options) ? options.flatMap(set => {
        const setName = String(set?.setName || "").trim();
        return (Array.isArray(set?.options) ? set.options : []).map(option => {
            const name = String(option?.name || "").trim();
            return name ? (setName ? `${setName}: ${name}` : name) : "";
        });
    }).filter(Boolean).join(", ") : "";
    const itemRows = items.map((item, index) => {
        const quantity = Math.max(0, Number(item?.quantity || 0));
        const price = Number(item?.price || 0);
        const lineTotal = Number(item?.lineTotal) > 0 || price === 0 ? Number(item?.lineTotal || 0) : quantity * price;
        const options = optionText(item?.options);
        return `<article class="item"><strong>${index + 1}. ${escapeHtml(item?.name || "-")}</strong><div class="item-sub"><span>${quantity} @ ${amount(price)}/${escapeHtml(item?.unit || "ea")}</span><b>${amount(lineTotal)}</b></div>${options ? `<small>${escapeHtml(options)}</small>` : ""}</article>`;
    }).join("");
    const taxBreakdown = Array.isArray(bill.taxBreakdown) ? bill.taxBreakdown : [];
    const rows = [
        `<div><span>Sub Total</span><b>${amount(bill.subtotal)}</b></div>`,
        Number(bill.discount || 0) > 0 ? `<div><span>${escapeHtml(bill.discountName ? `Discount · ${bill.discountName}` : "Discount")}</span><b>−${amount(bill.discount)}</b></div>` : "",
        Number(bill.serviceCharge || 0) > 0 ? `<div><span>${escapeHtml(bill.chargeName ? `Charges · ${bill.chargeName}` : "Charges")}</span><b>${amount(bill.serviceCharge)}</b></div>` : "",
        ...(taxBreakdown.length ? taxBreakdown.map(tax => `<div><span>${escapeHtml(tax.component || "Tax")} ${escapeHtml(tax.rate || 0)}% on ${amount(tax.taxableBase || 0)}</span><b>${amount(tax.taxAmount || 0)}</b></div>`) : (Number(bill.gst || 0) > 0 ? [`<div><span>GST</span><b>${amount(bill.gst)}</b></div>`] : [])),
        `<div class="bill-total"><span>Bill Total</span><b>${amount(Number(bill.total || 0) - Number(bill.roundingAdjustment || 0))}</b></div>`,
        `<div class="rounded-total"><span>Bill Total (rounded)</span><b>${amount(bill.total)}</b></div>`
    ].filter(Boolean).join("");
    const allocations = Array.isArray(bill.paymentAllocations) ? bill.paymentAllocations : [];
    const collected = bill.amountCollected === undefined ? allocations.reduce((sum, entry) => sum + Number(entry.amount || 0), 0) : Number(bill.amountCollected || 0);
    const due = bill.amountDue === undefined ? Math.max(0, Number(bill.total || 0) - collected) : Number(bill.amountDue || 0);
    const payments = bill.isOpenOrder ? "" : `<section class="payments"><h2>Payment Summary</h2>${allocations.length ? allocations.map(entry => `<div><span>${escapeHtml(entry?.method || "Payment")}</span><b>${amount(entry?.amount)}</b></div>`).join("") : `<div><span>${escapeHtml(bill.paymentMethod || "Payment")}</span><b>${amount(collected)}</b></div>`}<div><span>Balance</span><b>${amount(due)}</b></div></section>`;
    const totalQty = items.reduce((sum, item) => sum + Math.max(0, Number(item?.quantity || 0)), 0);
    const invoiceLabel = bill.isOpenOrder ? bill.orderNumber : (bill.invoiceNumber || bill.orderNumber);
    const customerCode = bill.customerCode || (bill.customerId ? `#${bill.customerId}` : "");
    const context = [bill.orderType, bill.tableNumber ? `Table ${bill.tableNumber}` : "", Number(bill.pax) > 0 ? `${Number(bill.pax)} PAX` : ""].filter(Boolean).join(" · ");
    const customHeader = String(settings.header || "").trim();
    const footerText = String(settings.footer || settings.customerMessage || "Visit Again!\nThank you.").replace("Thank You!\nVisit Again 😊", "Visit Again!\nThank you.").trim();
    const details = [settings.address, settings.gstin ? `GST#: ${settings.gstin}` : "", settings.fssai ? `FSSAI#: ${settings.fssai}` : ""].filter(Boolean).map(value => `<div>${escapeHtml(value)}</div>`).join("");
    const printDate = bill.date || new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoiceLabel || "Slash POS Invoice")}</title><style>
@page{size:80mm ${Math.max(150, Number(pageHeightMm) || 220)}mm;margin:4mm}*{box-sizing:border-box}html,body{width:72mm;margin:0;background:#fff;color:#202124;font:10px/1.42 Arial,Helvetica,sans-serif}.receipt{width:72mm;margin:0 auto;padding:0}.business{text-align:center;padding:0 0 8px;border-bottom:1px solid #d8dadd}.business h1{margin:0;font-size:15px;font-weight:500}.legal{margin-top:1px;font-size:12px}.business div{margin-top:2px}.title{margin:7px 0;text-align:center;font-size:16px;font-weight:500}.token{text-align:left;margin:6px 0 14px}.guest{margin:8px 0}.guest strong,.guest small{display:block}.guest strong{font-size:12px;font-weight:400}.guest small{margin-top:2px;color:#666}.meta{display:flex;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid #d8dadd;border-bottom:1px solid #d8dadd}.meta strong{font-weight:400}.meta span:last-child{text-align:right}.context{margin:4px 0;color:#50545a}.items{padding:3px 0 0}.item{padding:5px 0 6px;border-bottom:1px solid #dedfe1;break-inside:avoid}.item>strong{display:block;font-size:11px;font-weight:400}.item-sub{display:flex;justify-content:space-between;gap:8px;padding:3px 0 0;color:#777}.item-sub b{color:#202124;font-weight:400;white-space:nowrap}.item small{display:block;color:#666}.summary{padding:6px 0 0}.summary>div,.payments>div{display:flex;justify-content:space-between;gap:8px;padding:2px 0}.summary b,.payments b{font-weight:400;text-align:right;white-space:nowrap}.summary .bill-total{margin-top:3px}.summary .rounded-total{padding:5px 0;font-size:16px}.summary .rounded-total b{font-size:16px}.payments{margin-top:7px}.payments h2{margin:7px 0 2px;font-size:12px;font-weight:400}.payments>div{padding:1px 0}.footer{margin-top:13px;padding-top:2px;color:#82858a;text-align:center;white-space:pre-line}.rcm{text-align:center;color:#82858a;margin-top:13px}
</style></head><body><main class="receipt"><header class="business"><h1>${escapeHtml(settings.restaurantName || "SLASH POS")}</h1>${settings.businessLegalName ? `<div class="legal">${escapeHtml(settings.businessLegalName)}</div>` : ""}${details}</header>${customHeader && customHeader !== "Cafe Management System" ? `<div class="footer">${escapeHtml(customHeader)}</div>` : ""}<div class="title">${bill.isOpenOrder ? "Order" : "Invoice"}</div>${bill.tokenNumber ? `<div class="token">Token No: ${escapeHtml(bill.tokenNumber)}</div>` : ""}<div class="guest"><strong>${escapeHtml(bill.customerName || "Guest")}</strong>${customerCode ? `<small>${escapeHtml(customerCode)}</small>` : ""}</div><div class="meta"><strong>${escapeHtml(`${bill.isOpenOrder ? "Order" : "Invoice"} ${invoiceLabel || "-"}`)}</strong><span>${items.length} ${items.length === 1 ? "item" : "items"} (${totalQty} Qty)</span></div><div class="meta"><span>${escapeHtml(printDate)}</span><span>${escapeHtml(bill.cashierName || "")}</span></div>${context ? `<div class="context">${escapeHtml(context)}</div>` : ""}<section class="items">${itemRows}</section><section class="summary">${rows}</section>${payments}<div class="rcm">RCM applicable: NO</div><footer class="footer">${escapeHtml(footerText)}</footer></main></body></html>`;
}

async function saveReceiptPdf(event, payload = {}) {
    requireMainWindow(event);
    const kind = payload.kind === "test" ? "test" : "invoice";
    const bill = payload.bill && typeof payload.bill === "object" ? payload.bill : {};
    const receipt = typeof payload.receipt === "string" ? payload.receipt : "";
    if (kind === "test" && !receipt.trim()) throw new Error("The test print has no content.");
    if (kind === "invoice" && (!Array.isArray(bill.items) || bill.items.length === 0)) throw new Error("The invoice has no items to print.");
    if (receipt.length > 50000 || JSON.stringify(bill).length > 100000) throw new Error("The invoice is too large to save as a PDF.");

    const reference = String(bill.invoiceNumber || bill.orderNumber || "")
        .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uniqueSuffix = Math.random().toString(36).slice(2, 8);
    const fileName = kind === "test"
        ? `Cafe-POS-Printer-Test-${timestamp}-${uniqueSuffix}.pdf`
        : `${bill.isOpenOrder ? "Proforma" : "Invoice"}${reference ? `-${reference}` : ""}-${timestamp}-${uniqueSuffix}.pdf`;
    const outputDirectory = path.join(app.getPath("documents"), "Slash POS Receipts");
    const outputFile = path.join(outputDirectory, fileName);
    await fs.mkdir(outputDirectory, { recursive: true });

    const pdfWindow = new BrowserWindow({
        width: 800,
        height: 1100,
        show: false,
        backgroundColor: "#ffffff",
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
    });
    pdfWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
        const items = Array.isArray(bill.items) ? bill.items : [];
        const approximateHeight = Math.min(1000, Math.max(170, 132 + items.reduce((sum, item) => sum + 15 + Math.ceil(String(item?.name || "").length / 34) * 4, 0) + (Array.isArray(bill.taxBreakdown) ? bill.taxBreakdown.length * 5 : 0)));
        const html = kind === "test"
            ? `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileName)}</title><style>@page{size:A4;margin:14mm}body{font:13px Arial,Helvetica,sans-serif;color:#222}main{max-width:548px;margin:0 auto;border:1px solid #e5e7eb;padding:24px}h1{font-size:20px;font-weight:400}pre{font:13px/1.5 Consolas,"Courier New",monospace;white-space:pre-wrap}</style></head><body><main><h1>Slash POS Printer Test</h1><pre>${escapeHtml(receipt)}</pre></main></body></html>`
            : makeInvoicePdfHtml(bill, payload.settings || {}, approximateHeight);
        await pdfWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        const pdf = await pdfWindow.webContents.printToPDF(kind === "test"
            ? { pageSize: "A4", printBackground: true, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } }
            : { pageSize: { width: 80000, height: Math.round(approximateHeight * 1000) }, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        if (!pdf || pdf.length < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
            throw new Error("The PDF could not be generated.");
        }
        await fs.writeFile(outputFile, pdf, { flag: "wx" });
        const savedFile = await fs.stat(outputFile);
        if (savedFile.size < 5) throw new Error("The PDF file was created but is empty.");
        return { success: true, outputFile };
    } finally {
        if (!pdfWindow.isDestroyed()) pdfWindow.close();
    }
}

function openServerSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 520,
        height: 400,
        resizable: false,
        title: "Slash POS Server Connection",
        parent: mainWindow || undefined,
        modal: Boolean(mainWindow),
        autoHideMenuBar: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        }
    });
    secureWindow(settingsWindow);
    settingsWindow.on("closed", () => { settingsWindow = null; });
    settingsWindow.loadURL("cafe-pos://app/desktop/server-config.html");
}

function installMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: "Slash POS",
            submenu: [
                { label: "Connect to POS server…", click: openServerSettings },
                { type: "separator" },
                { role: "quit" }
            ]
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                ...(process.env.NODE_ENV === "development" ? [{ role: "toggleDevTools" }] : [])
            ]
        }
    ]));
}

ipcMain.handle("desktop:get-api-base", () => apiServerUrl);
ipcMain.handle("desktop:set-api-base", async (_event, value) => {
    try { return await saveApiServer(value); }
    catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle("desktop:window-state", event => {
    const window = requireMainWindow(event);
    return { maximized: window.isMaximized() };
});
ipcMain.handle("desktop:window-minimize", event => requireMainWindow(event).minimize());
ipcMain.handle("desktop:window-toggle-maximize", event => {
    const window = requireMainWindow(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
});
ipcMain.handle("desktop:window-close", event => requireMainWindow(event).close());
ipcMain.handle("desktop:open-server-settings", event => {
    requireMainWindow(event);
    openServerSettings();
});
ipcMain.handle("desktop:save-receipt-pdf", async (event, payload) => {
    try { return await saveReceiptPdf(event, payload); }
    catch (error) {
        console.error("Could not save Slash POS invoice PDF:", error.message);
        return { success: false, error: error.message || "Could not save the invoice PDF." };
    }
});
ipcMain.on("desktop:bluetooth-select-device", (event, deviceId) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    finishBluetoothSelection(event.sender, String(deviceId || ""));
});
ipcMain.on("desktop:bluetooth-cancel-selection", event => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    finishBluetoothSelection(event.sender, "");
});

app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("com.cafepilot.pos");
    await readUserSettings();
    await registerAppProtocol();
    installMenu();
    try { await printerBridge.start(); }
    catch (error) { console.warn("The built-in printer bridge did not start:", error.message); }
    createMainWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on("before-quit", () => {
    if (mainWindow) finishBluetoothSelection(mainWindow.webContents, "");
    printerBridge.stop();
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
