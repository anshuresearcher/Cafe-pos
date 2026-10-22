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

function makeInvoicePdfHtml(bill = {}, settings = {}) {
    const clean = bill.viewMode === "clean";
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
    const itemRows = items.map(item => {
        const quantity = Number(item?.quantity || 0);
        const price = Number(item?.price || 0);
        const options = optionText(item?.options);
        return `<tr><td>${escapeHtml(item?.name || "-")}${options ? `<small>${escapeHtml(options)}</small>` : ""}</td><td>${Number.isFinite(quantity) ? quantity : 0}</td><td>${amount(price)}</td><td>${amount((Number.isFinite(quantity) ? quantity : 0) * (Number.isFinite(price) ? price : 0))}</td></tr>`;
    }).join("");
    const detailRows = [
        ["Order No", bill.orderNumber],
        bill.invoiceNumber ? ["Invoice", bill.invoiceNumber] : null,
        ["Date", bill.date || new Date().toLocaleString()],
        ["Order Type", bill.orderType],
        bill.tableNumber ? ["Table", `${bill.tableNumber}${Number(bill.pax) > 0 ? ` · ${Number(bill.pax)} PAX` : ""}`] : null
    ].filter(row => row && row[1]).map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
    const discount = Number(bill.discount || 0);
    const charge = Number(bill.serviceCharge || 0);
    const gst = Number(bill.gst || 0);
    const rounding = Number(bill.roundingAdjustment || 0);
    const summaries = [
        `<div><span>${clean ? "Sub Total" : "Subtotal"}</span><strong>${amount(bill.subtotal)}</strong></div>`,
        discount > 0 ? `<div><span>${escapeHtml(bill.discountName ? `Discount · ${bill.discountName}` : "Discount")}</span><strong>−${amount(discount)}</strong></div>` : "",
        charge > 0 ? `<div><span>${escapeHtml(bill.chargeName ? `Charges · ${bill.chargeName}` : "Charges")}</span><strong>${amount(charge)}</strong></div>` : "",
        gst > 0 || !clean ? `<div><span>GST</span><strong>${amount(gst)}</strong></div>` : "",
        Math.abs(rounding) >= 0.005 ? `<div><span>Rounding</span><strong>${amount(rounding)}</strong></div>` : "",
        `<div class="total"><span>${clean ? "Bill Total" : "TOTAL"}</span><strong>${amount(bill.total)}</strong></div>`
    ].filter(Boolean).join("");
    const customer = [bill.customerName, bill.customerPhone, bill.customerEmail, bill.customerGstin ? `GSTIN: ${bill.customerGstin}` : "", bill.customerAddress, bill.customerCity, bill.customerState].filter(Boolean).join(" · ");
    const collected = bill.amountCollected === undefined
        ? (Array.isArray(bill.paymentAllocations) ? bill.paymentAllocations.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) : 0)
        : Number(bill.amountCollected || 0);
    const due = bill.amountDue === undefined ? Math.max(0, Number(bill.total || 0) - collected) : Number(bill.amountDue || 0);
    const itemCount = `${items.length} ${items.length === 1 ? "item" : "items"}`;
    const brand = clean ? "Order" : (settings.restaurantName || "SLASH POS");
    const logoUrl = !clean ? String(settings.businessLogoUrl || "") : "";
    const logo = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoUrl)
        ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="Business logo">`
        : "";
    const businessDetails = clean ? "" : [settings.address, settings.phone ? `Phone: ${settings.phone}` : "", settings.gstin ? `GSTIN: ${settings.gstin}` : ""].filter(Boolean).map(value => `<p>${escapeHtml(value)}</p>`).join("");
    const details = clean ? "" : `<section class="details">${bill.isOpenOrder ? `<div class="open-order">OPEN ORDER / PROFORMA</div>` : ""}${detailRows}${customer ? `<div><span>Customer</span><strong>${escapeHtml(customer)}</strong></div>` : ""}</section>`;
    const payment = clean ? "" : `<section class="payment"><div><span>Payment</span><strong>${escapeHtml(bill.paymentMethod || "-")}</strong></div>${(Array.isArray(bill.paymentAllocations) ? bill.paymentAllocations : []).map(entry => `<div><span>${escapeHtml(entry?.method || "Payment")}</span><strong>${amount(entry?.amount)}</strong></div>`).join("")}<div><span>Amount Collected</span><strong>${amount(collected)}</strong></div><div><span>Amount Due</span><strong>${amount(due)}</strong></div></section>`;

    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(bill.invoiceNumber || bill.orderNumber || "Slash POS Bill")}</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#222;font:13px Arial,Helvetica,sans-serif}.bill{width:100%;max-width:548px;margin:0 auto;border:1px solid #e5e7eb;background:#fff}.toolbar{display:flex;align-items:center;min-height:58px;padding:10px 24px;border-bottom:1px solid #e0e2e5;color:#17191c;font-size:20px;font-weight:700}.header{padding:27px 24px 21px;border-bottom:1px solid #dedfe1;text-align:center}.logo{display:block;max-width:150px;max-height:76px;object-fit:contain;margin:0 auto 12px}.header h1{margin:0;color:#222;font-size:20px;font-weight:400}.header p{margin:4px 0 0;color:#62666c;font-size:12px}.details{display:grid;gap:7px;padding:17px 24px;border-bottom:1px solid #dedfe1}.details>div{display:flex;justify-content:space-between;gap:12px;font-size:12px}.details span{color:#666}.details strong{text-align:right;font-weight:500}.details .open-order{justify-content:center;color:#8a4c00;font-weight:700}.quick{display:flex;justify-content:space-between;margin:0 24px;padding:12px 0;border-bottom:1px solid #dedfe1;color:#30343a;font-size:13px}.items{padding:0 24px}.items table{width:100%;border-collapse:collapse;font-size:13px}.items th,.items td{padding:9px 4px;color:#222;vertical-align:top}.items th{border-bottom:1px solid #e1e2e4;font-size:12px;font-weight:700;text-align:left}.items td:nth-child(2),.items th:nth-child(2){text-align:center}.items td:nth-child(n+3),.items th:nth-child(n+3){text-align:right;white-space:nowrap}.items small{display:block;margin-top:3px;color:#62666c;font-size:11px}.summary{margin:0 24px;padding:10px 0 18px;border-top:1px solid #dedfe1}.summary>div,.payment>div{display:flex;justify-content:space-between;gap:14px;padding:6px 0;color:#50545a;font-size:13px}.summary strong,.payment strong{color:#222;font-weight:500}.summary .total{padding-top:10px;border-top:1px solid #e5e7eb;color:#17191c;font-size:21px}.summary .total strong{font-size:21px;font-weight:500}.payment{margin:0 24px;padding:10px 0;border-top:1px solid #dedfe1}.footer{margin:0 24px;padding:13px 0 20px;border-top:1px solid #dedfe1;color:#555;text-align:center;font-size:12px}@media print{.bill{break-inside:avoid;border-radius:0}}
</style></head><body><main class="bill"><div class="toolbar">Bill</div><header class="header">${logo}<h1>${escapeHtml(brand)}</h1>${businessDetails}</header>${details}<div class="quick"><span>Order</span><span>${itemCount}</span></div><section class="items"><table><thead><tr><th>${clean ? "Name" : "Item"}</th><th>Qty</th><th>${clean ? "Rate" : "Price"}</th><th>${clean ? "Amount" : "Total"}</th></tr></thead><tbody>${itemRows}</tbody></table></section><section class="summary">${summaries}</section>${payment}</main></body></html>`;
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
        const html = kind === "test"
            ? `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileName)}</title><style>@page{size:A4;margin:14mm}body{font:13px Arial,Helvetica,sans-serif;color:#222}main{max-width:548px;margin:0 auto;border:1px solid #e5e7eb;padding:24px}h1{font-size:20px;font-weight:400}pre{font:13px/1.5 Consolas,"Courier New",monospace;white-space:pre-wrap}</style></head><body><main><h1>Slash POS Printer Test</h1><pre>${escapeHtml(receipt)}</pre></main></body></html>`
            : makeInvoicePdfHtml(bill, payload.settings || {});
        await pdfWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        const pdf = await pdfWindow.webContents.printToPDF({ pageSize: "A4", printBackground: true, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
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
