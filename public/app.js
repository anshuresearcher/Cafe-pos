// ==========================================
// SLASH POS SYSTEM
// Table • Reservation • Orders • KOT • Payment
// Billing • Menu • Customers • Reports
// ==========================================

const API = "/api";
const POS_TIME_ZONE = "Asia/Kolkata";
function parsePOSDate(value) {
    if (value instanceof Date) return value;
    if (value === null || value === undefined || value === "") return new Date(NaN);
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00.000Z`);
    const utcWallClock = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw);
    return new Date(utcWallClock ? `${raw.replace(" ", "T")}Z` : raw);
}
function formatPOSDateTime(value = new Date()) {
    if (value === null || value === undefined || value === "") return "";
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
        return `${day}/${month}/${year}`;
    }
    const date = parsePOSDate(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-IN", { timeZone: POS_TIME_ZONE });
}
function formatPOSTime(value) {
    const date = parsePOSDate(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-IN", { timeZone: POS_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
}
function getPOSDateKey(value = new Date()) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const date = parsePOSDate(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: POS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
}
let authToken = "";
sessionStorage.removeItem("cafeAuthToken");
let currentUser = null;
let currentLicense = null;
let currentDevice = null;
let pendingBusinessLogoUrl = null;
let businessLogoChanged = false;
const LOGIN_BUSINESS_NAME_KEY = 'cafeLoginBusinessName';
function settingsLocalStorageKey(){return currentUser&&currentUser.business_id?"cafeAppSettings:"+Number(currentUser.business_id):"cafeAppSettings";}

let sessionExpiryTimer = null;
let sessionHeartbeatTimer = null;
let sessionHeartbeatListenerAttached = false;

function clearSessionExpiryTimer() {
    if (sessionExpiryTimer) {
        clearTimeout(sessionExpiryTimer);
        sessionExpiryTimer = null;
    }
}

function scheduleSessionExpiry(expiresAt) {
    clearSessionExpiryTimer();

    const expiry = Number(expiresAt);

    if (!Number.isFinite(expiry)) {
        return;
    }

    const remaining = expiry - Date.now();

    if (remaining <= 0) {
        handleAutomaticLogout();
        return;
    }

    sessionExpiryTimer = setTimeout(() => {
        handleAutomaticLogout();
    }, remaining + 250);
}

function handleAutomaticLogout(message = "Your session has expired. Please login again.") {
    clearSessionExpiryTimer();
    stopSessionHeartbeat();
    stopReservationAutoRefresh();
    stopPOSQrOrderAlerts?.();

    if (typeof stopKOTAlertPolling === "function") {
        stopKOTAlertPolling();
    }

    kotAlertInitialized = false;
    knownPendingKOTIds = new Set();

    authToken = "";
    currentUser = null;
    currentLicense = null;

    sessionStorage.removeItem("cafeAuthToken");

    const loginScreen = document.getElementById("loginScreen");

    if (loginScreen) {
        loginScreen.style.setProperty("display", "flex");
    }

    const password = document.getElementById("loginPassword");

    if (password) {
        password.value = "";
    }

    if (message) {
        alert(message);
    }
}

let cart = [];
let cartItemCancellationReasons = [];
let orderType = "Takeaway";
// Empty until settings are loaded. This lets the saved POS preference choose the
// first channel for a fresh billing session instead of silently keeping Takeaway.
let selectedPOSChannelKey = "";

let restaurantTables = [];
let currentOrders = [];
let currentMenu = [];
let currentCustomers = [];
let currentReservations = [];
let reservationAutoRefreshTimer = null;
let billingAdjustments = [];
let currentPayments = [];
let accessUsers = [];
let accessProfiles = [];
let accessCanManageProfiles = false;
let accessCanCreateProfiles = false;
let editingMenuItemId = null;
let menuOptionSets = [];
let menuOptionSetsLoaded = false;
let menuOptionSetsLoadPromise = null;
let currentMenuImageData = null;
let editingAccessUserId = null;
let editingAccessProfileId = null;

const STARTER_PAYMENT_MODES = [
    { name: "Cash", isCash: true },
    { name: "UPI", isCash: false },
    { name: "Card", isCash: false }
];

const DEFAULT_NON_CHARGEABLE_REASONS = ["Complimentary", "Staff meal", "Customer recovery", "Promotion"];
function normalizeNonChargeableReasons(value) { return [...new Set((Array.isArray(value) ? value : []).map(reason => String(reason || "").trim().slice(0, 100)).filter(Boolean))].slice(0, 30); }
const DEFAULT_CANCELLATION_REASONS = ["Customer request", "Duplicate order", "Item unavailable", "Other"];
function normalizeCancellationReasons(value) { return [...new Set((Array.isArray(value) ? value : []).map(reason => String(reason || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 30); }

let appSettings = {
    restaurantName: "SLASH POS", businessLegalName: "", address: "", phone: "", gstin: "", fssai: "",
    header: "Cafe Management System", footer: "Visit Again!\nThank you.",
    showInvoice: true, showCustomer: true, showCustomerPhone: true,
    showOrder: true, showOrderType: true, showTable: true, showTimestamp: true,
    showGST: true, showPayment: true, showQR: true, uppercaseItems: false, wrapItems: true,
    gstCalculationEnabled: true,
    paperWidth: "80", autoPrint: false, autoClose: true, currency: "₹", gstRate: 5,
    defaultPayment: STARTER_PAYMENT_MODES[0].name, paymentModes: STARTER_PAYMENT_MODES.map(mode => ({ ...mode })), orderPrefix: "ORD-", invoicePrefix: "INV-",
    nonChargeableReasons: DEFAULT_NON_CHARGEABLE_REASONS.slice(),
    cancellationReasons: DEFAULT_CANCELLATION_REASONS.slice(),
    allowZeroAmount: false, roundTotals: false, totalRoundingMode: "none", logoUrl: "", upiId: "", receiptFont: "Arial",
    printKitchenOnOrder: false, kotPrintMode: "never", billCopies: 1, enableReceiptSound: false, openingTime: "09:00", closingTime: "23:00",
    defaultOrderType: "Takeaway", allowOrderNotes: true, showItemNotes: true, lowStockThreshold: 5,
    customerMessage: "Thank you for visiting!", enableNotifications: true, enableKOTSound: true, kotAlertInterval: 5,
    qrCleanTableNotification: true, qrCleanTableSound: true, qrCleanTableBuzzer: false,
    qrCallWaiterNotification: true, qrCallWaiterSound: true, qrCallWaiterBuzzer: false,
    sessionTimeout: 12, auditLog: false,
    uiDensity: "comfortable", accentLabel: "", largeBilling: false, kotEnabled: true, kotDisabledBehavior: "hide",
    customerInfoRequirements: {},
    posSalesChannels: [
        { key: "dine_in", label: "Dine", orderType: "Dine-in", qrMenu: false },
        { key: "takeaway", label: "Takeaway", orderType: "Takeaway", qrMenu: false },
        { key: "delivery", label: "Delivery", orderType: "Takeaway", qrMenu: false },
        { key: "online", label: "Slash", orderType: "Takeaway", qrMenu: true }
    ]
};
const DEFAULT_APP_SETTINGS = { ...appSettings };

let editingTableId = null;
let editingCustomerId = null;
let currentOrderForDetails = null;
let currentOpenOrderId = null;
let currentOpenOrderData = null;
window.currentOrdersTab = "open";
window.selectedOrderId = null;
let lastOrderDetailsRefreshAt = 0;


// ==========================================
// COMMON HELPERS
// ==========================================

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatItemOptionNames(options) {
    if (!Array.isArray(options)) return "";
    return options.flatMap(set => {
        const setName = String(set?.setName || "").trim();
        return (Array.isArray(set?.options) ? set.options : []).map(option => {
            const optionName = String(option?.name || "").trim();
            return optionName ? (setName ? `${setName}: ${optionName}` : optionName) : "";
        });
    }).filter(Boolean).join(", ");
}

function normalizeOrderBillItems(items, order = {}) {
    const source = Array.isArray(items) ? items : [];
    const isQrOrder = String(order?.order_number || "").toUpperCase().startsWith("QR-");
    const normalized = source.map(item => {
        const quantity = Math.max(1, Number(item?.quantity ?? item?.qty ?? 1));
        const lineTotal = Number(item?.line_total ?? item?.total ?? 0);
        const sourcePrice = Number(item?.price ?? item?.unit_price ?? 0);
        const price = sourcePrice > 0 ? sourcePrice : (lineTotal > 0 ? lineTotal / quantity : sourcePrice);
        return {
            name: item?.name || item?.item_name || item?.product_name || "Item",
            price,
            quantity,
            unit: item?.unit || item?.measuring_unit || "ea",
            options: Array.isArray(item?.options) ? item.options : [],
            lineTotal,
            taxRate: Math.max(0, Number(item?.taxRate ?? item?.tax_rate ?? 0)),
            taxMode: String(item?.taxMode ?? item?.tax_mode ?? "exclusive").toLowerCase() === "inclusive" ? "inclusive" : "exclusive"
        };
    });
    if (isQrOrder && normalized.length === 1 && normalized[0].price === 0 && normalized[0].lineTotal === 0 && Number(order.total || 0) > 0) {
        normalized[0].price = (Number(order.subtotal || 0) + Number(order.gst || 0)) / normalized[0].quantity;
    }
    return normalized;
}

function formatBillTaxRate(value) {
    return Number(Number(value || 0).toFixed(2)).toString();
}

function buildTaxComponentsFromGroups(groups, totalTaxValue) {
    if (Number(totalTaxValue || 0) <= 0) return [];
    const groupRows = (Array.isArray(groups) ? groups : [])
        .map(group => ({ rate: Number(group?.rate || 0), base: Math.max(0, Number(group?.base || 0)) }))
        .filter(group => Number.isFinite(group.rate) && group.rate > 0 && Number.isFinite(group.base) && group.base > 0);
    if (!groupRows.length) return [];

    groupRows.forEach(group => {
        group.rawTaxCents = group.base * group.rate;
        group.taxCents = Math.round(group.rawTaxCents);
    });

    // Keep displayed components aligned with the order's GST total, including cent rounding.
    const targetTaxCents = Math.max(0, Math.round(Number(totalTaxValue || 0) * 100));
    let taxCentsDifference = targetTaxCents - groupRows.reduce((sum, group) => sum + group.taxCents, 0);
    if (taxCentsDifference) {
        const ranked = [...groupRows].sort((a, b) => (b.rawTaxCents - b.taxCents) - (a.rawTaxCents - a.taxCents));
        const direction = Math.sign(taxCentsDifference);
        for (let index = 0; taxCentsDifference !== 0 && ranked.length; index = (index + 1) % ranked.length) {
            const group = ranked[index];
            if (direction < 0 && group.taxCents <= 0) continue;
            group.taxCents += direction;
            taxCentsDifference -= direction;
        }
    }

    return groupRows.flatMap(group => {
        const cgstCents = Math.round(group.taxCents / 2);
        const sgstCents = group.taxCents - cgstCents;
        return [
            { component: "CGST", rate: group.rate / 2, taxableBase: group.base, taxAmount: cgstCents / 100 },
            { component: "SGST", rate: group.rate / 2, taxableBase: group.base, taxAmount: sgstCents / 100 }
        ];
    });
}

function buildBillTaxBreakdown(items, discountValue, totalTaxValue) {
    if (Number(totalTaxValue || 0) <= 0) return [];
    const groups = new Map();
    let orderSubtotal = 0;
    for (const item of Array.isArray(items) ? items : []) {
        const rate = Math.max(0, Number(item?.taxRate ?? item?.tax_rate ?? 0));
        const quantity = Math.max(0, Number(item?.quantity ?? item?.qty ?? 0));
        const price = Math.max(0, Number(item?.price ?? item?.unit_price ?? 0));
        if (!Number.isFinite(rate) || !Number.isFinite(quantity) || !Number.isFinite(price)) continue;
        const gross = price * quantity;
        const inclusive = String(item?.taxMode ?? item?.tax_mode ?? "exclusive").toLowerCase() === "inclusive";
        const taxableBase = inclusive ? gross / (1 + rate / 100) : gross;
        orderSubtotal += taxableBase;
        if (rate <= 0) continue;
        const key = rate.toFixed(4);
        groups.set(key, (groups.get(key) || 0) + taxableBase);
    }

    const groupRows = [...groups.entries()].map(([key, base]) => ({ rate: Number(key), base }));
    if (!groupRows.length || orderSubtotal <= 0) return [];

    const discount = Math.min(orderSubtotal, Math.max(0, Number(discountValue || 0)));
    const remainingFraction = Math.max(0, orderSubtotal - discount) / orderSubtotal;
    groupRows.forEach(group => {
        group.base *= remainingFraction;
    });
    return buildTaxComponentsFromGroups(groupRows, totalTaxValue);
}

function renderLiveTaxBreakdown(elementId, rows) {
    const container = document.getElementById(elementId);
    if (!container) return;
    const details = Array.isArray(rows) ? rows : [];
    container.innerHTML = details.map(row =>
        `<div><span>${esc(row.component)} ${esc(formatBillTaxRate(row.rate))}% on ${esc(money(row.taxableBase))}</span><strong>${esc(money(row.taxAmount))}</strong></div>`
    ).join("");
    container.style.display = details.length ? "grid" : "none";
}

function normalizePaymentModes(modes) {
    const source = Array.isArray(modes) ? modes : STARTER_PAYMENT_MODES;
    const seen = new Set();
    const normalized = source.map(mode => {
        const value = typeof mode === "string" ? { name: mode, isCash: mode.trim().toLowerCase() === "cash" } : mode;
        const name = String(value?.name || "").trim().slice(0, 40);
        const key = name.toLocaleLowerCase();
        if (!name || seen.has(key)) return null;
        seen.add(key);
        return { name, isCash: value?.isCash === true };
    }).filter(Boolean);
    return normalized.length ? normalized : STARTER_PAYMENT_MODES.map(mode => ({ ...mode }));
}

function isCashPaymentMethod(method) {
    return normalizePaymentModes(appSettings.paymentModes).some(mode => mode.name === method && mode.isCash);
}

function preferredPaymentMethod() {
    const modes = normalizePaymentModes(appSettings.paymentModes);
    return modes.find(mode => mode.name === appSettings.defaultPayment)?.name || modes[0].name;
}

function renderPaymentModeOptions() {
    appSettings.paymentModes = normalizePaymentModes(appSettings.paymentModes);
    const defaultSelect = document.getElementById("settingDefaultPayment");
    const expenseSelect = document.getElementById("expensePayment");
    const currentDefault = defaultSelect?.value || appSettings.defaultPayment;
    const currentExpense = expenseSelect?.value;
    const defaultMode = appSettings.paymentModes.find(mode => mode.name === currentDefault)?.name || appSettings.paymentModes[0].name;
    const expenseMode = appSettings.paymentModes.find(mode => mode.name === currentExpense)?.name || appSettings.paymentModes[0].name;
    const options = appSettings.paymentModes.map(mode => `<option value="${esc(mode.name)}">${esc(mode.name)}</option>`).join("");
    if (defaultSelect) {
        defaultSelect.innerHTML = options;
        defaultSelect.value = defaultMode;
    }
    if (expenseSelect) {
        expenseSelect.innerHTML = options;
        expenseSelect.value = expenseMode;
    }
    appSettings.defaultPayment = defaultMode;
}

function renderPaymentModeManager() {
    const list = document.getElementById("paymentModesList");
    if (!list) return;
    appSettings.paymentModes = normalizePaymentModes(appSettings.paymentModes);
    list.innerHTML = appSettings.paymentModes.map((mode, index) => `
        <div class="payment-mode-row">
            <strong>${esc(mode.name)}</strong>
            <label><input type="checkbox" ${mode.isCash ? "checked" : ""} onchange="setPaymentModeCash(${index}, this.checked)"> Cash handling</label>
            <button type="button" class="table-action-btn" onclick="removePaymentMode(${index})" ${appSettings.paymentModes.length <= 1 ? "disabled" : ""}>Remove</button>
        </div>`).join("");
    renderPaymentModeOptions();
}

function addPaymentMode() {
    const input = document.getElementById("newPaymentModeName");
    const name = String(input?.value || "").trim().slice(0, 40);
    if (!name) return alert("Enter a payment mode name.");
    if (normalizePaymentModes(appSettings.paymentModes).some(mode => mode.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return alert("That payment mode already exists.");
    }
    const isCash = document.getElementById("newPaymentModeCash")?.checked === true;
    appSettings.paymentModes = [...normalizePaymentModes(appSettings.paymentModes).map(mode => ({ ...mode, isCash: isCash ? false : mode.isCash })), { name, isCash }];
    if (input) input.value = "";
    const cashCheckbox = document.getElementById("newPaymentModeCash");
    if (cashCheckbox) cashCheckbox.checked = false;
    renderPaymentModeManager();
    renderPaymentMethods();
}

function removePaymentMode(index) {
    const modes = normalizePaymentModes(appSettings.paymentModes);
    if (modes.length <= 1) return alert("Keep at least one payment mode available.");
    modes.splice(index, 1);
    appSettings.paymentModes = modes;
    renderPaymentModeManager();
    renderPaymentMethods();
}

function setPaymentModeCash(index, checked) {
    appSettings.paymentModes = normalizePaymentModes(appSettings.paymentModes).map((mode, modeIndex) => ({
        ...mode,
        isCash: modeIndex === index ? checked : checked ? false : mode.isCash
    }));
    renderPaymentModeManager();
    renderPaymentMethods();
}

function renderPaymentMethods() {
    const container = document.getElementById("paymentMethods");
    if (!container) return;
    const modes = normalizePaymentModes(appSettings.paymentModes);
    container.innerHTML = modes.map(mode => `<button type="button" data-payment-method="${esc(mode.name)}" aria-pressed="${mode.name === selectedPaymentMethod ? "true" : "false"}" class="${mode.name === selectedPaymentMethod ? "selected" : ""}"><span class="payment-method-icon">${mode.isCash ? "💵" : "💳"}</span><span>${esc(mode.name)}</span></button>`).join("");
    container.querySelectorAll("[data-payment-method]").forEach(button => {
        button.addEventListener("click", () => selectPaymentMethod(button.dataset.paymentMethod));
    });
}


async function api(url, options = {}) {

    const response = await fetch(API + url, {

        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        },

        credentials: "include",
        ...options

    });

    let data = {};

    try {
        data = await response.json();
    } catch (_) {
        // Response is not JSON
    }

    if (!response.ok) {
        if (response.status === 401 && currentUser) {
            handleAutomaticLogout(
                data.error || "Your session has expired or is no longer valid. Please login again."
            );
        }
        throw new Error(data.error || "Request failed");
    }

    return data;
}


function money(value) {
    const currency = appSettings?.currency || "₹";
    return currency + Number(value || 0).toFixed(2);
}


function setText(id, value) {

    const element = document.getElementById(id);

    if (element) {

        element.textContent = value;

    }

}


function getNumberValue(value, possibleKeys = []) {

    // Already a number
    if (typeof value === "number") {

        return value;

    }


    // Numeric string
    if (typeof value === "string") {

        const number = Number(value);

        if (Number.isFinite(number)) {

            return number;

        }

    }


    // PostgreSQL result object
    if (value && typeof value === "object") {

        for (const key of possibleKeys) {

            if (value[key] !== undefined) {

                const number = Number(value[key]);

                if (Number.isFinite(number)) {

                    return number;

                }

            }

        }

    }

    return 0;

}



// ==========================================
// LOGIN / SESSION / PERMISSIONS
// ==========================================
function hasLicenseAddon(addon){return String(currentLicense?.add_on||"").split(/[;,]/).map(value=>value.trim().toLowerCase()).includes(String(addon||"").toLowerCase());}
function hasPermission(moduleKey, action="view") {
    if (!currentUser) return false;
    if (currentUser.is_owner === true && currentUser.permissions_override === null) return true;
    return currentUser.permissions?.[`${moduleKey}.${action}`] === true;
}
window.loginDeviceRegistered = false;
window.setLoginDeviceRegistrationState = function (registered) {
    window.loginDeviceRegistered = registered === true;
    const loading = document.getElementById("loginFlowLoading");
    if (loading) loading.style.display = "none";

    if (window.loginDeviceRegistered) {
        window.showLoginViewFromDeviceRegistration?.();
    } else {
        window.showDeviceRegistrationView?.();
    }
};

function showRegisterBusiness() {
    document.getElementById("loginCard")?.classList.add("registration-mode");
    document.getElementById("loginView")?.style.setProperty("display", "none");
    document.getElementById("deviceRegistrationView")?.style.setProperty("display", "none");
    document.getElementById("registerView")?.style.setProperty("display", "block");
    document.getElementById("registerError")?.replaceChildren();
    const backButton = document.getElementById("registerBusinessBackButton");
    if (backButton) backButton.textContent = window.loginDeviceRegistered === true ? "← Back to login" : "← Back to device registration";
}

function showLoginView() {
    if (window.loginDeviceRegistered !== true) {
        window.showDeviceRegistrationView?.();
        return;
    }
    document.getElementById("loginCard")?.classList.remove("registration-mode");
    document.getElementById("registerView")?.style.setProperty("display", "none");
    document.getElementById("loginView")?.style.setProperty("display", "block");
}

async function registerBusiness(event) {
    event?.preventDefault();
    const payload = {
        businessName: document.getElementById("registerBusinessName")?.value.trim() || "",
        businessType: document.getElementById("registerBusinessType")?.value.trim() || "Cafe",
        ownerName: document.getElementById("registerOwnerName")?.value.trim() || "",
        phone: document.getElementById("registerPhone")?.value.trim() || "",
        email: document.getElementById("registerEmail")?.value.trim() || "",
        address: document.getElementById("registerAddress")?.value.trim() || "",
        city: document.getElementById("registerCity")?.value.trim() || "",
        state: document.getElementById("registerState")?.value.trim() || "",
        gstin: document.getElementById("registerGstin")?.value.trim() || "",
        currency: document.getElementById("registerCurrency")?.value.trim() || "₹",
        username: document.getElementById("registerUsername")?.value.trim() || "",
        password: document.getElementById("registerPassword")?.value || ""
    };
    const box=document.getElementById("registerError"); if(box) box.textContent="";
    try {
        const r=await fetch(API+"/public/register-business",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
        const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||"Registration failed");
        const usernameInput=document.getElementById("loginUsername");
        if(usernameInput)usernameInput.value=payload.username;
        const registrationKey=String(data.initialRegistrationKey||"").trim();
        if(registrationKey){
            window.loginDeviceRegistered=false;
            document.getElementById("loginCard")?.classList.remove("registration-mode");
            window.showDeviceRegistrationView?.();
            const keyInput=document.getElementById("deviceRegistrationKey");
            if(keyInput)keyInput.value=registrationKey;
            const message=document.getElementById("deviceRegistrationMessage");
            if(message){message.textContent=`${payload.businessName} is registered. Confirm this device to continue to sign in.`;message.className="device-registration-message success";}
        }else{
            alert("Business profile created successfully. Please register this device before signing in.");
            showLoginView();
        }
    } catch(e) { if(box) box.textContent=e.message; }
}

function renderLoginBusinessWelcome(name) {
    const wrapper = document.getElementById("loginBusinessWelcome");
    const nameElement = document.getElementById("loginBusinessName");
    const cleanName = String(name || "").trim();
    if (nameElement) nameElement.textContent = cleanName;
    if (wrapper) wrapper.hidden = !cleanName;
}
function cacheLoginBusinessName(name) {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    localStorage.setItem(LOGIN_BUSINESS_NAME_KEY, cleanName);
    renderLoginBusinessWelcome(cleanName);
}
async function loadLoginBusinessWelcome() {
    const cachedBusinessName = localStorage.getItem(LOGIN_BUSINESS_NAME_KEY) || "";
    try {
        const response = await fetch(API + "/public/device-business", { credentials: "same-origin" });
        if (!response.ok) throw new Error("Could not check device registration");
        const data = await response.json();
        const businessName = String(data.businessName || "").trim();
        if (businessName) {
            cacheLoginBusinessName(businessName);
        } else {
            localStorage.removeItem(LOGIN_BUSINESS_NAME_KEY);
            renderLoginBusinessWelcome("");
        }
        window.setLoginDeviceRegistrationState?.(Boolean(businessName));
        return Boolean(businessName);
    } catch (_) {
        renderLoginBusinessWelcome(cachedBusinessName);
        window.setLoginDeviceRegistrationState?.(Boolean(cachedBusinessName));
        return Boolean(cachedBusinessName);
    }
}
async function loginUser(event) {
    event?.preventDefault();
    // Prime audio while the login submit is still a trusted user gesture;
    // waiting for the network response can make browsers block later alerts.
    primeKOTAlertAudio();
    const username=document.getElementById("loginUsername")?.value.trim()||"";
    const password=document.getElementById("loginPassword")?.value||"";
    const box=document.getElementById("loginError"); if(box) box.textContent="";
    try{
        const r=await fetch(API+"/auth/login",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
        const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||"Login failed");
        authToken=""; currentUser=data.user; currentDevice=data.device||null; currentLicense=data.license||null; cacheLoginBusinessName(currentUser.business_name); sessionStorage.removeItem("cafeAuthToken");
        const fallbackSessionHours = Math.max(1, Number(appSettings.sessionTimeout || 12));
        scheduleSessionExpiry(data.expiresAt || (Date.now() + fallbackSessionHours * 60 * 60 * 1000));
        await startAuthenticatedApp(); if(currentUser?.business_name) showProfileToast("Welcome to " + currentUser.business_name + "!");
    }catch(e){if(box) box.textContent=e.message;}
}
async function logoutUser(){clearSessionExpiryTimer();stopSessionHeartbeat();stopReservationAutoRefresh();closeProfilePanel();stopKOTAlertPolling();stopPOSQrOrderAlerts();stopQrTableServiceAlerts();kotAlertInitialized=false;knownPendingKOTIds=new Set();pendingKOTAlertSounds=0;pendingQrAlertSounds=0;try{await api("/auth/logout",{method:"POST"});}catch(_){} authToken="";currentUser=null;currentDevice=null;currentLicense=null;sessionStorage.removeItem("cafeAuthToken");const lp=document.getElementById("loginPassword"); if(lp) lp.value="";document.getElementById("loginScreen")?.style.setProperty("display","flex");loadLoginBusinessWelcome();}
async function checkSession(){try {
    const r = await api("/auth/me");

    currentUser = r.user;
    currentDevice = r.device || null;
    currentLicense = r.license || null;
    cacheLoginBusinessName(currentUser?.business_name);

    const fallbackSessionHours = Math.max(1, Number(appSettings.sessionTimeout || 12));
    scheduleSessionExpiry(r.expiresAt || (Date.now() + fallbackSessionHours * 60 * 60 * 1000));

    await startAuthenticatedApp();

    return true;

} catch (_) {
    clearSessionExpiryTimer();

    authToken = "";
    currentUser = null;
    currentLicense = null;

    sessionStorage.removeItem("cafeAuthToken");

    document.getElementById("loginScreen")
        ?.style.setProperty("display", "flex");

    return false;
}
}


function applyPermissionsToUI(){
    document.querySelectorAll(".nav-btn").forEach(function(btn){
        const text = btn.getAttribute("onclick") || "";
        const m = text.match(/showPage\('([^']+)'\)/);

        if(!m) return;

        const page = m[1];

        const mod =
            page === "new-order"
                ? "new_order"
                : (page === "kot-groups"
                    ? "kot_groups"
                    : (page === "table-qr-menu" ? "menu" : page));

        let visible = page === "kot-groups"
            ? (hasPermission("kot_groups", "view") || hasPermission("printer", "view"))
            : hasPermission(mod, "view");
        if (page === "table-qr-menu") visible = visible && hasLicenseAddon("Table QR");
        if (page === "marketing") visible = visible && hasLicenseAddon("Marketing");

        if (page === "kitchen" && appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide") visible = false;
        if (page === "kot-groups") {
            const kotGroupsCard = document.getElementById("kotGroupsModuleCard");
            const printerCard = document.getElementById("printerModuleCard");
            const kotGroupsHidden = appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide";
            if (kotGroupsCard) kotGroupsCard.hidden = !hasPermission("kot_groups", "view") || kotGroupsHidden;
            if (printerCard) printerCard.hidden = !hasPermission("printer", "view");
            if (visible && kotGroupsHidden && !hasPermission("printer", "view")) visible = false;
        }

        btn.style.display = visible ? "" : "none";
    });

    document.querySelectorAll(".billing-flow-link[data-pos-flow-page]").forEach(button=>{
        const module=button.dataset.posFlowPage==="new-order"?"new_order":button.dataset.posFlowPage==="table-view"?"tables":"orders";
        button.hidden=!hasPermission(module,"view");
    });

    const loyaltySection = document.getElementById("loyalty");
    const loyaltyCard = document.getElementById("marketingLoyaltyFeatureCard");
    const canViewLoyalty = hasPermission("loyalty", "view");
    if (loyaltySection && !canViewLoyalty) loyaltySection.hidden = true;
    if (loyaltyCard) loyaltyCard.hidden = !canViewLoyalty;

    document.querySelectorAll("[data-export-module]").forEach(function(button){
        button.hidden = !hasPermission(button.dataset.exportModule, "export");
    });

    const label = document.getElementById("sessionUserLabel");

    if(label && currentUser){
        const businessName = currentUser.business_name || "Slash POS";
        const userName = currentUser.display_name || "User";
        const role = currentUser.profile_name || "No Profile";

        label.textContent = `${businessName} · ${userName} · ${role}`;

        const headerTitle = document.querySelector(".header h1");

        if(headerTitle){
            headerTitle.textContent = businessName;
        }

        document.title = `${businessName} · Slash POS`;
    }

    updateProfilePanelInfo();
}

// ==========================================
// PROFILE AVATAR / SLIDE-OUT PANEL
// ==========================================

function updateProfilePanelInfo(){
    if(!currentUser) return;

    const initial=
        (currentUser.display_name||"U")
        .trim()
        .charAt(0)
        .toUpperCase()||"U";

    const nameEl=document.getElementById("profilePanelName");
    const roleEl=document.getElementById("profilePanelRole");
    const avatarInitial=document.getElementById("profileAvatarInitial");
    const panelInitial=document.getElementById("profilePanelInitial");

    if(nameEl){
        nameEl.textContent=
            currentUser.display_name||"User";
    }

    if(roleEl){
        roleEl.textContent=
            `${currentUser.business_name||"Cafe"} · ${currentUser.profile_name||"No Profile"}`;
    }

    if(avatarInitial){
        avatarInitial.textContent=initial;
    }

    if(panelInitial){
        panelInitial.textContent=initial;
    }
}

function toggleProfilePanel(){
    const panel=document.getElementById("profilePanel");
    const btn=document.getElementById("profileAvatarBtn");
    if(!panel) return;
    const isOpen=panel.classList.contains("open");
    if(isOpen){ closeProfilePanel(); } else {
        panel.classList.add("open");
        btn?.setAttribute("aria-expanded","true");
        document.addEventListener("click",handleProfilePanelOutsideClick,true);
        document.addEventListener("keydown",handleProfilePanelEscape);
    }
}

function closeProfilePanel(){
    const panel=document.getElementById("profilePanel");
    const btn=document.getElementById("profileAvatarBtn");
    panel?.classList.remove("open");
    btn?.setAttribute("aria-expanded","false");
    document.removeEventListener("click",handleProfilePanelOutsideClick,true);
    document.removeEventListener("keydown",handleProfilePanelEscape);
}

function handleProfilePanelOutsideClick(e){
    const widget=document.querySelector(".profile-widget");
    if(widget && !widget.contains(e.target)) closeProfilePanel();
}

function handleProfilePanelEscape(e){
    if(e.key==="Escape") closeProfilePanel();
}

function handleModuleDrawerOutsideClick(event){
    if(!document.body.classList.contains("billing-nav-open")) return;
    const drawer=document.querySelector(".app-module-nav");
    const toggle=document.querySelector(".billing-menu-toggle");
    if(drawer?.contains(event.target) || toggle?.contains(event.target)) return;
    document.body.classList.remove("billing-nav-open");
}
document.addEventListener("click",handleModuleDrawerOutsideClick);

function profileAction(action){
    closeProfilePanel();
    switch(action){
        case "notification": showProfileToast("🔔 Test notification sent."); break;
        case "sync": syncPOSData(); break;
        case "whats-new": showProfileToast("✨ You're on the latest version of Slash."); break;
        case "change-business": showBusinessProfileDialog(); break;
        case "about": openBusinessAboutDialog(); break;
    }
}
let posSyncInProgress=false;
async function syncPOSData(){
    if(posSyncInProgress)return;
    posSyncInProgress=true;
    const startedAt=Date.now();
    const activePage=document.querySelector(".page.active-page");
    const scrollPosition={x:window.scrollX,y:window.scrollY,pageTop:activePage?.scrollTop||0};
    let overlay=document.getElementById("posSyncOverlay");
    if(!overlay){
        overlay=document.createElement("div");
        overlay.id="posSyncOverlay";
        overlay.className="pos-sync-overlay";
        overlay.setAttribute("role","status");
        overlay.setAttribute("aria-live","polite");
        document.body.appendChild(overlay);
    }
    overlay.innerHTML='<div class="pos-sync-card"><span class="pos-sync-spinner" aria-hidden="true"></span><strong>Refreshing your POS</strong><span id="posSyncStatus">Getting the latest data…</span><div class="pos-sync-progress"><i id="posSyncProgressBar"></i></div></div>';
    overlay.classList.add("active");
    document.body.classList.add("pos-syncing");

    const jobs=[{label:"Settings",run:loadSettings}];
    if(hasPermission("new_order","view")||hasPermission("menu","view"))jobs.push({label:"Menu",run:loadMenu});
    if(hasPermission("customers","view"))jobs.push({label:"Customers",run:loadCustomers});
    if(hasPermission("tables","view")||hasPermission("new_order","view"))jobs.push({label:"Tables",run:loadTables});
    if(hasPermission("orders","view"))jobs.push({label:"Orders",run:()=>updateOrdersTable(true,true)});
    if(hasPermission("kitchen","view"))jobs.push({label:"Kitchen",run:()=>loadKOT(false)});
    if(hasPermission("reservations","view"))jobs.push({label:"Reservations",run:loadReservations});
    if(hasPermission("new_order","view")){
        jobs.push({label:"Discounts and charges",run:loadBillingAdjustments});
        jobs.push({label:"Marketing deals",run:loadMarketingDeals});
    }
    if(hasPermission("dashboard","view")||hasPermission("dashboard"))jobs.push({label:"Dashboard",run:updateDashboard});
    const pageId=activePage?.id||"";
    if(pageId==="menu"&&hasPermission("menu","view"))jobs.push({label:"Menu setup",run:loadMenuManagement});
    if(pageId==="kot-groups"&&hasPermission("kot_groups","view"))jobs.push({label:"KOT groups",run:loadKOTGroups});
    if(pageId==="payments"&&hasPermission("payments","view"))jobs.push({label:"Payments",run:loadPayments});
    if(pageId==="reports")jobs.push({label:"Reports",run:async()=>{await loadReports();await loadSalesAuditReport();await loadOrderCategoryReports();}});
    if(pageId==="advanced-reports"&&hasPermission("advanced_reports","view"))jobs.push({label:"Advanced reports",run:loadAdvancedReports});
    if(pageId==="kot-groups"&&hasPermission("printer","view"))jobs.push({label:"Printers",run:loadPrinters});
    if(pageId==="expenses"&&hasPermission("expenses","view"))jobs.push({label:"Expenses",run:loadExpenses});

    let completed=0,failed=0;
    const status=document.getElementById("posSyncStatus");
    const progress=document.getElementById("posSyncProgressBar");
    const updateProgress=()=>{
        const percent=Math.round(completed/jobs.length*100);
        if(progress)progress.style.width=percent+"%";
        if(status)status.textContent=completed<jobs.length?`Refreshing ${jobs[Math.min(completed,jobs.length-1)]?.label||"POS data"}… ${completed}/${jobs.length}`:"Finishing refresh…";
    };
    updateProgress();
    try{
        let settingsOk=true;
        try{await jobs[0].run();}catch(error){settingsOk=false;console.warn("POS sync failed for Settings:",error.message);}
        completed=1;
        updateProgress();
        const outcomes=[settingsOk,...await Promise.all(jobs.slice(1).map(async job=>{
            try{await job.run();return true;}
            catch(error){console.warn(`POS sync failed for ${job.label}:`,error.message);return false;}
            finally{completed++;updateProgress();}
        }))];
        failed=outcomes.filter(ok=>!ok).length;
        await new Promise(resolve=>setTimeout(resolve,Math.max(0,420-(Date.now()-startedAt))));
        if(activePage&&activePage.isConnected)activePage.scrollTop=scrollPosition.pageTop;
        window.scrollTo(scrollPosition.x,scrollPosition.y);
        overlay.classList.remove("active");
        document.body.classList.remove("pos-syncing");
        showProfileToast(failed?`POS refreshed with ${failed} section${failed===1?"":"s"} unavailable.`:"✓ POS data refreshed.",true);
    }finally{
        posSyncInProgress=false;
        overlay.classList.remove("active");
        document.body.classList.remove("pos-syncing");
    }
}
function showProfileToast(message, centered=false){
    let toast=document.getElementById("profileToast");
    if(!toast){
        toast=document.createElement("div");
        toast.id="profileToast";
        toast.className="profile-toast";
        document.body.appendChild(toast);
    }
    toast.textContent=message;
    toast.classList.toggle("centered",centered===true);
    toast.classList.add("show");
    clearTimeout(toast._hideTimer);
    const duration=Math.min(6500,Math.max(2600,1800+String(message??"").length*28));
    toast._hideTimer=setTimeout(function(){ toast.classList.remove("show"); },duration);
}

// Keep all legacy module alerts in the same bottom-center toast as save confirmations.
const nativeBrowserAlert = window.alert.bind(window);
window.alert = function(message){
    if(!document.body){nativeBrowserAlert(message);return;}
    showProfileToast(String(message??""),true);
};

function setAboutText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value || "—");
}
function openBusinessAboutDialog() {
    if (!currentUser) return showProfileToast("Sign in to view business information.");
    const branch = [currentUser.business_code, currentUser.city].filter(Boolean).join(" · ") || currentUser.business_name;
    setAboutText("aboutBranch", branch);
    setAboutText("aboutBusinessType", currentUser.business_type || "Cafe");
    setAboutText("aboutDevice", currentDevice ? [currentDevice.device_name, currentDevice.device_type].filter(Boolean).join(" · ") : "—");
    const modal = document.getElementById("businessAboutModal");
    if (modal) modal.style.display = "flex";
}
function closeBusinessAbout() {
    const modal = document.getElementById("businessAboutModal");
    if (modal) modal.style.display = "none";
}
function showBusinessProfileDialog() {
    if (!currentUser?.business_name) { showProfileToast("No business profile found."); return; }
    const lines = [
        `Business: ${currentUser.business_name}`,
        `Type: ${currentUser.business_type || "Cafe"}`,
        `Owner: ${currentUser.owner_name || currentUser.display_name || ""}`,
        `Phone: ${currentUser.business_phone || "-"}`,
        `Email: ${currentUser.business_email || "-"}`,
        `Location: ${[currentUser.city,currentUser.state].filter(Boolean).join(", ") || "-"}`
    ];
    alert(lines.join("\\n"));
}

function stopSessionHeartbeat(){
    if(sessionHeartbeatTimer){clearInterval(sessionHeartbeatTimer);sessionHeartbeatTimer=null;}
}
function verifySessionHeartbeat(){
    if(!currentUser||document.visibilityState!=="visible")return;
    api("/auth/heartbeat").catch(error=>{if(currentUser)console.warn("Session check failed:",error.message);});
}
function startSessionHeartbeat(){
    stopSessionHeartbeat();
    verifySessionHeartbeat();
    sessionHeartbeatTimer=setInterval(verifySessionHeartbeat,20000);
    if(!sessionHeartbeatListenerAttached){
        document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")verifySessionHeartbeat();});
        sessionHeartbeatListenerAttached=true;
    }
}
async function startAuthenticatedApp(){
    document.getElementById("loginScreen")?.style.setProperty("display","none");
    applyPermissionsToUI();
    await loadSettings();
    startSessionHeartbeat();
    startReservationAutoRefresh();
    startPOSQrOrderAlerts();
    startQrTableServiceAlerts();
    stopKOTAlertPolling();
    kotAlertInitialized=false;
    knownPendingKOTIds=new Set();
    if (hasPermission("dashboard")) updateDashboard().catch(error=>console.warn("Dashboard refresh failed:",error.message));
    updateCart();
    setOrderType("Takeaway");
    startKOTAlertPolling();
}

// ==========================================
// NAVIGATION
// ==========================================

function showPage(pageName) {
    if (pageName === "loyalty") pageName = "marketing";

    if (pageName === "kitchen" && appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide") return;
    if (pageName === "kot-groups" && appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide" && !hasPermission("printer", "view")) return;

    if (pageName === "table-qr-menu" && !hasLicenseAddon("Table QR")) { alert("Table QR is a paid add-on. Contact support to activate it."); return; }
    if (pageName === "marketing" && !hasLicenseAddon("Marketing")) { alert("Marketing is a paid add-on. Contact support to activate it."); return; }

    const permissionModule = pageName === "new-order" ? "new_order" : (pageName === "table-view" ? "tables" : ((pageName === "table-qr-menu" || pageName === "menu") ? "menu" : (pageName === "kot-groups" ? "kot_groups" : (pageName === "advanced-reports" ? "advanced_reports" : pageName))));
    const canOpenModule = pageName === "kot-groups"
        ? (hasPermission("kot_groups", "view") || hasPermission("printer", "view"))
        : hasPermission(permissionModule, "view");
    if (!currentUser || !canOpenModule) {
        if (currentUser) alert("You do not have permission to open this module.");
        return;
    }

    const activePage = document.querySelector(".page.active-page");
    if (pageName === "table-view") {
        selectedPOSChannelKey = getPOSChannelPreferences().tableView.defaultChannel;
        setOrderType("Dine-in", true);
    }
    if (pageName === "new-order" && activePage?.id !== "new-order" && !currentOpenOrderId) {
        if (document.getElementById("tableNumber")?.value) {
            selectedPOSChannelKey = getPOSChannelPreferences().tableView.defaultChannel;
            setOrderType("Dine-in", true);
        } else {
            setOrderType("Takeaway");
        }
    }
    if (activePage?.id === "new-order" && pageName !== "new-order") {
        closePayment();
        if (completingOrder) clearNewOrderDraftAfterPayment = true;
        else clearNewOrderDraft();
    }

    if (pageName !== "new-order") {
        closeBillingCustomerPanel();
        const billModal = document.getElementById("billModal");
        if (billModal?.classList.contains("bill-preview-sidecar") ||
            billModal?.classList.contains("bill-preview-clean")) closeBillModal();
    }

    // Hide all pages
    document
        .querySelectorAll(".page")
        .forEach(function(page) {

            page.classList.remove("active-page");

        });


    // Show selected page
    const selectedPage =
        document.getElementById(pageName);

    if (selectedPage) {

        selectedPage.classList.add(
            "active-page"
        );

    }

    if (pageName === "new-order" && isBillingCustomerInfoRequired()) openBillingCustomerPanel();

    document.querySelectorAll(".billing-flow-link[data-pos-flow-page]").forEach(button => {
        const isActive = button.dataset.posFlowPage === pageName;
        button.classList.toggle("active", isActive);
        if (isActive) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
    });

    if (pageName === "menu") showMenuModuleView("overview");
    if (pageName === "settings") showSettingsFeature("");
    if (pageName === "kot-groups") showKOTGroupsView("overview");
    if (pageName === "advanced-reports") showAdvancedReportsView("overview");

    // Keep the shared business summary and order shortcut on the dashboard.
    const isDashboardPage = pageName === "dashboard";
    const headerBusinessInfo = document.querySelector(".header .header-business-info");
    if (headerBusinessInfo) headerBusinessInfo.style.display = isDashboardPage ? "" : "none";

    const newOrderHeaderBtn = document.querySelector(".header .new-order-btn");
    if (newOrderHeaderBtn) {
        newOrderHeaderBtn.style.display = isDashboardPage ? "" : "none";
    }


    // Remove active from navigation buttons
    document
        .querySelectorAll(".nav-btn")
        .forEach(function(button) {

            button.classList.remove("active");

        });


    // Find matching navigation button
    const activeButton =
        [...document.querySelectorAll(".nav-btn")]
            .find(function(button) {

                const onclick =
                    button.getAttribute("onclick") || "";

                return onclick.includes(
                    `'${pageName}'`
                );

            });


    if (activeButton) {

        activeButton.classList.add("active");

    }


    // Load page data
    if (pageName === "dashboard") {

        updateDashboard();

    }


    if (pageName === "new-order") {

        loadTables();
        loadMenu();

    }


    if (pageName === "orders") {

        updateOrdersTable();

    }


    if (pageName === "reservations") {

        loadTables();
        loadReservations();
    }


    if (pageName === "kitchen") {

        loadKOT();

    }

    if (pageName === "kot-groups") {
        if (hasPermission("kot_groups", "view") && !(appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide")) loadKOTGroups();
        if (hasPermission("printer", "view")) loadPrinters();
    }


    if (pageName === "menu") {

        loadMenuManagement();

    }

    if (pageName === "table-qr-menu") {

        loadTableQrMenuModule();

    }


    if (pageName === "customers") {

        loadCustomers();

    }


    if (pageName === "payments") {

        loadPayments();

    }


    if (pageName === "tables" || pageName === "table-view") {
        loadTables();
    }


    if (pageName === "reports") {

        loadReports();
        loadSalesAuditReport();

    }

    if (pageName === "settings") {

        loadSettings();
        loadBillingAdjustmentMaster();

    }

    if (pageName === "access") {

        loadAccess();

    }

}

// Module cards keep large feature areas focused while reusing the existing forms and data.
const SETTINGS_FEATURES = [
    { key: "payment-modes", title: "Payment Modes", icon: "💳", description: "Create and manage the ways customers can pay." },
    { key: "restaurant-profile", title: "Restaurant Profile", icon: "🏪", description: "Set your business name, address, phone and GSTIN." },
    { key: "bill-template", title: "Bill Template", icon: "🧾", description: "Choose the information and message printed on bills." },
    { key: "thermal-printer", title: "Thermal Printer", icon: "🖨️", description: "Configure paper width and automatic printing." },
    { key: "gst", title: "GST", icon: "％", description: "Enable or disable GST calculation on orders." },
    { key: "general-currency", title: "General / Currency", icon: "💱", description: "Set currency and the default GST rate." },
    { key: "pos-preferences", title: "POS Preferences", icon: "🧭", description: "Choose sales channels and defaults for each POS module." },
    { key: "customer-details", title: "Customer Details", icon: "👤", description: "Choose which sale channels require customer name and mobile number." },
    { key: "sales-channels", title: "Sales Channels", icon: "🛍️", description: "Create and manage where menu items can be sold." },
    { key: "billing-rules", title: "Billing Rules", icon: "🧮", description: "Set payment, invoice numbering and bill rounding rules." },
    { key: "non-chargeable", title: "Non-chargeable Reasons", icon: "📝", description: "Choose the reasons staff can use for no-charge bills." },
    { key: "cancellation-reasons", title: "Cancellation Reasons", icon: "↩️", description: "Manage the reasons staff select when cancelling orders." },
    { key: "printer-receipt", title: "Printer & Receipt", icon: "🖨️", description: "Set receipt branding, UPI details and print behavior." },
    { key: "operations", title: "Operations", icon: "🕒", description: "Set opening hours, order type and order note behavior." },
    { key: "alerts-customer-experience", title: "Alert & Customer Experience", icon: "🔔", description: "Set customer messages, KOT alerts and QR table-service notifications and sounds." },
    { key: "kitchen-kot", title: "Kitchen / KOT", icon: "👨‍🍳", description: "Control the kitchen ticket workflow." },
    { key: "data-admin", title: "Data & Admin", icon: "🛡️", description: "Configure session timeout and audit logging." },
    { key: "appearance", title: "Appearance", icon: "🎨", description: "Adjust interface density, theme label and billing buttons." },
    { key: "discount-charges", title: "Discount & Charges", icon: "％", description: "Create reusable discounts and service charge rules." }
];

function initializeSettingsModuleCards() {
    const overview = document.getElementById("settingsModuleOverview");
    if (!overview || overview.dataset.ready === "true") return;
    overview.innerHTML = SETTINGS_FEATURES.map(feature => `
        <button type="button" class="module-navigation-card" onclick="showSettingsFeature('${feature.key}')">
            <span class="module-card-icon">${feature.icon}</span>
            <span class="module-card-copy"><strong>${esc(feature.title)}</strong><span>${esc(feature.description)}</span></span>
            <span class="module-card-arrow" aria-hidden="true">›</span>
        </button>`).join("");
    overview.dataset.ready = "true";
}

function showSettingsFeature(featureKey = "") {
    initializeSettingsModuleCards();
    const overview = document.getElementById("settingsModuleOverview");
    const detailHeader = document.getElementById("settingsFeatureHeader");
    const title = document.getElementById("settingsFeatureTitle");
    const description = document.getElementById("settingsFeatureDescription");
    const feature = SETTINGS_FEATURES.find(item => item.key === featureKey);
    const cards = [...document.querySelectorAll("#settings [data-settings-feature]")];
    const activeCard = feature ? cards.find(card => card.dataset.settingsFeature === feature.key) : null;
    if (feature && !activeCard) return;
    if (overview) overview.hidden = Boolean(feature);
    if (detailHeader) detailHeader.hidden = !feature;
    if (title) title.textContent = feature?.title || "Settings";
    if (description) description.textContent = feature?.description || "Manage restaurant, billing and POS preferences.";
    cards.forEach(card => { card.hidden = card !== activeCard; card.classList.toggle("settings-feature-active", card === activeCard); });
    document.querySelectorAll("#settings .settings-grid").forEach(grid => {
        const hasActiveCard = Boolean(activeCard && grid.contains(activeCard));
        grid.style.display = hasActiveCard ? "grid" : "none";
    });
    const footerActions = document.getElementById("settingsFooterActions");
    if (footerActions) footerActions.hidden = !feature;
}

function showMenuModuleView(view = "overview") {
    const overview = document.getElementById("menuModuleOverview");
    const header = document.getElementById("menuDetailHeader");
    const items = document.getElementById("menuItemsPanel");
    const categories = document.getElementById("menuCategoriesPanel");
    const options = document.getElementById("menuOptionsPanel");
    const title = document.getElementById("menuDetailTitle");
    const description = document.getElementById("menuDetailDescription");
    const isOverview = view === "overview";
    if (overview) overview.hidden = !isOverview;
    if (header) header.hidden = isOverview;
    if (items) items.hidden = view !== "items";
    if (categories) categories.hidden = view !== "categories";
    if (options) options.hidden = view !== "options";
    if (title) title.textContent = view === "categories" ? "Categories" : view === "options" ? "Item option" : "Menu Items";
    if (description) description.textContent = view === "categories"
        ? "Create and organize the categories used throughout your menu."
        : view === "options"
            ? "Set up the choices customers can select for each menu item."
            : "Manage your catalog, pricing, availability, variants and KOT routing.";
    if (view === "options") renderMenuOptionSetsOverview();
}

function showKOTGroupsView(view = "overview") {
    const overview = document.getElementById("kotGroupsOverview");
    const detail = document.getElementById("kotGroupsDetail");
    const editor = document.getElementById("kotGroupEditorPanel");
    const printer = document.getElementById("printerDetail");
    const kotGroupsCard = document.getElementById("kotGroupsModuleCard");
    const printerCard = document.getElementById("printerModuleCard");
    const kotGroupsHidden = appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide";
    if (kotGroupsCard) kotGroupsCard.hidden = !hasPermission("kot_groups", "view") || kotGroupsHidden;
    if (printerCard) printerCard.hidden = !hasPermission("printer", "view");
    if ((view === "groups" || view === "editor") && (!hasPermission("kot_groups", "view") || kotGroupsHidden)) return;
    if (view === "printer" && !hasPermission("printer", "view")) return;
    if (overview) overview.hidden = view !== "overview";
    if (detail) detail.hidden = view !== "groups";
    if (editor) editor.hidden = view !== "editor";
    if (printer) printer.hidden = view !== "printer";
    if (view === "groups") loadKOTGroups();
    if (view === "printer") loadPrinters();
}

function showAdvancedReportsView(reportKey = "overview") {
    const overview = document.getElementById("advancedReportsOverview");
    const details = document.getElementById("advancedReportDetails");
    const title = document.getElementById("advancedReportDetailTitle");
    const description = document.getElementById("advancedReportDetailDescription");
    const reports = {
        "hourly-sales": { title: "Hourly Sales", description: "Compare orders and sales across each hour." },
        "weekday-sales": { title: "Sales by Weekday", description: "Find the busiest and highest earning days." },
        "daypart-sales": { title: "Sales by Daypart", description: "Compare sales across breakfast, lunch, afternoon, evening and late night." },
        "top-customers": { title: "Top Customers", description: "See your highest value customers for this period." },
        "cancelled-orders": { title: "Cancelled Orders", description: "Review the cancellation reason, staff name, time and order value." },
        "discount-orders": { title: "Discounted Orders", description: "Review completed orders that used a discount." },
        "non-chargeable-orders": { title: "Non-chargeable Orders", description: "Review completed orders with no payment collected." }
    };
    const selected = reports[reportKey];
    if (overview) overview.hidden = Boolean(selected);
    if (details) details.hidden = !selected;
    if (title) title.textContent = selected?.title || "Advanced Reports";
    if (description) description.textContent = selected?.description || "Choose a report to view its details.";
    document.querySelectorAll("[data-advanced-report-panel]").forEach(panel => { panel.hidden = panel.dataset.advancedReportPanel !== reportKey; });
}

function showSalesReportView(reportKey = "overview") {
    const reports = {
        "sales-summary": { title: "Sales Summary", description: "Gross sales, discounts, charges, tax and payment totals.", body: "reportSalesSummaryBody" },
        payments: { title: "Payment Breakdown", description: "Collections by payment method.", body: "reportPaymentBody" },
        "best-items": { title: "Best Selling Items", description: "Most popular menu items and revenue.", body: "reportBestItemsBody" },
        category: { title: "Sales by Category", description: "Compare item quantities and revenue by menu category.", body: "reportCategoryBody" },
        "order-type": { title: "Sales by Order Type", description: "Compare dine-in, takeaway and other order channels.", body: "reportOrderTypeBody" },
        daily: { title: "Daily Sales", description: "Track sales and order counts across the selected dates.", body: "reportDailyBody" },
        gst: { title: "GST / Tax Report", description: "Taxable sales and GST collected.", body: "reportGstBody" },
        "sale-items-transaction": { title: "Sale Items by Transaction", description: "Review every sold item under its completed transaction and export the details.", body: "saleItemsTransactionBody" },
        audit: { title: "Sale Transaction Audit", description: "Review completed sales by order with invoice, payment, tax and balance details.", body: "salesAuditBody" },
        "qr-analytics": { title: "QR Menu Analytics", description: "Review QR menu views, guest activity, popular items and abandoned carts over the last 30 days.", body: "qrPopularItemsBody" },
        "order-activity": { title: "Order Activity Audit", description: "Review edits, cancellations, discounts, payments and staff actions recorded against orders.", body: "orderActivityAuditBody" },
        discounts: { title: "Discounted Orders", description: "Completed orders that used a discount.", body: "reportDiscountOrdersBody" },
        "non-chargeable": { title: "Non-chargeable Orders", description: "Completed orders recorded without payment.", body: "reportNonChargeableOrdersBody" }
    };
    const selected = reports[reportKey];
    const overview = document.getElementById("salesReportsOverview");
    const header = document.getElementById("salesReportDetailsHeader");
    if (overview) overview.hidden = Boolean(selected);
    if (header) header.hidden = !selected;
    setText("salesReportDetailTitle", selected?.title || "Sales Reports");
    setText("salesReportDetailDescription", selected?.description || "Choose a report to view its details.");
    Object.entries(reports).forEach(([key, report]) => {
        const panel = document.getElementById(report.body)?.closest(".dashboard-box");
        if (!panel) return;
        panel.dataset.salesReportPanel = key;
        panel.hidden = !selected || key !== reportKey;
    });
    if (reportKey === "sale-items-transaction") loadSaleItemsByTransactionReport();
    if (reportKey === "qr-analytics") loadQrMenuAnalyticsReport();
    if (reportKey === "order-activity") loadOrderActivityAuditReport();
}

async function loadQrMenuAnalyticsReport() {
    const status = document.getElementById("qrAnalyticsStatus");
    const body = document.getElementById("qrPopularItemsBody");
    if (status) status.textContent = "Loading the last 30 days of QR menu activity…";
    if (body) body.innerHTML = '<tr><td colspan="4">Loading popular items…</td></tr>';
    try {
        const result = await api("/reports/qr-menu-analytics");
        const summary = result.summary || {};
        setText("qrAnalyticsViews", Number(summary.menuViews || 0).toLocaleString());
        setText("qrAnalyticsVisitors", Number(summary.uniqueVisitors || 0).toLocaleString());
        setText("qrAnalyticsCarts", Number(summary.cartsStarted || 0).toLocaleString());
        setText("qrAnalyticsCheckouts", Number(summary.checkoutStarts || 0).toLocaleString());
        setText("qrAnalyticsOrders", Number(summary.qrOrders || 0).toLocaleString());
        setText("qrAnalyticsAbandoned", Number(summary.abandonedCarts || 0).toLocaleString());
        setText("qrAnalyticsConversion", `${Number(summary.conversionRate || 0).toFixed(1)}%`);
        const items = Array.isArray(result.popularItems) ? result.popularItems : [];
        if (body) body.innerHTML = items.length ? items.map(item => `<tr><td><strong>${esc(item.item_name || "Item")}</strong></td><td>${esc(item.category || "—")}</td><td>${Number(item.quantity_sold || 0).toLocaleString()}</td><td>${money(item.sales)}</td></tr>`).join("") : '<tr><td colspan="4">No QR orders found in the last 30 days.</td></tr>';
        if (status) status.textContent = `Updated just now · ${Number(result.periodDays || 30)} day view. Cart abandonment counts carts with items and no later order after 30 minutes.`;
    } catch (error) {
        if (body) body.innerHTML = `<tr><td colspan="4">Unable to load QR analytics: ${esc(error.message || "Please try again.")}</td></tr>`;
        if (status) status.textContent = "QR menu analytics could not be loaded.";
    }
}

async function loadOrderActivityAuditReport() {
    const status = document.getElementById("orderActivityAuditStatus");
    const body = document.getElementById("orderActivityAuditBody");
    const exportButton = document.querySelector(".order-activity-audit-box [data-export-module='reports']");
    const range = document.getElementById("reportDateFilter")?.value || "today";
    const from = document.getElementById("reportFromDate")?.value || "";
    const to = document.getElementById("reportToDate")?.value || "";
    if (range === "custom" && (!from || !to || from > to)) {
        if (status) status.textContent = "Choose a valid From and To date before loading order activity.";
        return;
    }
    const params = new URLSearchParams({ range });
    if (range === "custom") { params.set("from", from); params.set("to", to); }
    if (status) status.textContent = "Loading order activity…";
    if (body) body.innerHTML = '<tr><td colspan="7">Loading activity…</td></tr>';
    if (exportButton) exportButton.hidden = !hasPermission("reports", "export");
    try {
        const result = await api(`/reports/order-activity?${params.toString()}`);
        const activities = Array.isArray(result.activities) ? result.activities : [];
        if (body) body.innerHTML = activities.length ? activities.map(entry => `
            <tr>
                <td>${esc(entry.created_at ? formatPOSDateTime(entry.created_at) : "—")}</td>
                <td><strong>${esc(entry.order_number || `#${entry.order_id}`)}</strong><small class="audit-order-status">${esc(entry.order_status || "")}</small></td>
                <td>${esc(entry.order_type || "—")}${entry.table_number ? ` · ${esc(entry.table_number)}` : ""}</td>
                <td>${esc(entry.event_type || "Activity")}</td>
                <td>${esc(entry.description || "—")}</td>
                <td>${esc(entry.customer_name || "—")}</td>
                <td>${esc(entry.actor || "Staff")}${entry.actor_user_id ? ` · #${esc(entry.actor_user_id)}` : ""}</td>
            </tr>`).join("") : '<tr><td colspan="7">No order activity found for this date range.</td></tr>';
        if (status) status.textContent = `${activities.length.toLocaleString()} activity entr${activities.length === 1 ? "y" : "ies"} loaded${activities.length >= 2000 ? " · showing the newest 2,000" : ""}.`;
    } catch (error) {
        if (body) body.innerHTML = `<tr><td colspan="7">Unable to load order activity: ${esc(error.message || "Please try again.")}</td></tr>`;
        if (status) status.textContent = "Order activity could not be loaded.";
    }
}


// ==========================================
// ORDER TYPE
// ==========================================

function setOrderType(type, preserveSaleChannel = false) {
    orderType = type;
    const label = document.getElementById("orderType");
    if (label) label.textContent = type;
    const menuTitle = document.getElementById("billingMenuTitle");
    if (menuTitle) menuTitle.textContent = type === "Dine-in" ? "Dine-in menu" : "Takeaway menu";
    const takeawayHint = document.getElementById("takeawayMenuHint");
    if (takeawayHint) takeawayHint.style.display = type === "Takeaway" ? "" : "none";
    const paxField = document.getElementById("billingPaxField");
    if (paxField) paxField.hidden = type !== "Dine-in";
    if (type !== "Dine-in") setBillingPaxForTable(null, 1);
    if (!preserveSaleChannel) {
        const preferences = getPOSChannelPreferences();
        const modulePrefs = type === "Dine-in" ? preferences.tableView : preferences.newOrder;
        const fallback = POS_CHANNELS.find(channel => channel.orderType === type)?.key;
        let nextChannel = modulePrefs.defaultChannel || fallback;
        if (!modulePrefs.channels.includes(nextChannel)) nextChannel = modulePrefs.channels[0] || fallback;
        selectedPOSChannelKey = nextChannel;
    }
    if (type !== "Dine-in") {
        const tableInput = document.getElementById("tableNumber");
        if (tableInput) tableInput.value = "";
    }
    repriceCartForCurrentChannel();
    renderBillingSaleChannelOptions();
    if (type === "Dine-in") loadTables();
    updateBillingTableSelection();
    renderBillingAdjustmentSelectors();
}

function setBillingPaxForTable(tableNumber, value = null) {
    const input = document.getElementById("billingPax");
    if (!input) return;
    const table = tableNumber && Array.isArray(restaurantTables)
        ? restaurantTables.find(entry => String(entry.table_number) === String(tableNumber))
        : null;
    const capacity = Number(table?.capacity) || 0;
    if (capacity > 0) input.max = String(capacity);
    else input.removeAttribute("max");
    const current = Number(value ?? input.value) || 1;
    input.value = String(Math.max(1, Math.min(current, capacity || current)));
}

function addToCart(id,name,price,menuItem=null,variant=null,options=[],basePrice=price){
    const optionKey=(options||[]).flatMap(set=>set.options||[]).map(option=>String(option.id)).sort().join(',');
    const cartKey=`${variant?`${id}:${variant.id}`:String(id)}:${optionKey}`; const existing=cart.find(x=>String(x.cartKey)===cartKey);
    if(existing) existing.quantity++; else cart.push({id,variantId:variant?.id||null,cartKey,name,price:Number(price),basePrice:Number(basePrice),options:options||[],quantity:1,unit:variant?.unit||menuItem?.unit||'ea',taxRate:Number(menuItem?.tax_rate??5),taxMode:menuItem?.tax_mode==='inclusive'?'inclusive':'exclusive'});
    updateCart();
}

function changeQuantity(index, amount) {

    return changeCartQuantity(index, amount);

}

async function changeCartQuantity(index, amount) {
    const item = cart[index];
    if (!item) return;

    if (amount > 0 && Number(item.orderItemId) > 0 && Number(item.quantity) < Number(item.savedQuantity || 0)) {
        const reasonIndex = cartItemCancellationReasons.map(entry => Number(entry.orderItemId)).lastIndexOf(Number(item.orderItemId));
        if (reasonIndex >= 0) cartItemCancellationReasons.splice(reasonIndex, 1);
    }

    if (amount < 0 && Number(item.orderItemId) > 0 && Number(item.quantity) <= Number(item.savedQuantity || 0)) {
        const reason = await requestItemCancellationReason(item);
        if (!reason) return;
        cartItemCancellationReasons.push({ orderItemId: Number(item.orderItemId), reason, quantity: 1 });
    }

    item.quantity += amount;
    if (item.quantity <= 0) cart.splice(index, 1);
    updateCart();
}


function calculateSubtotal() {
    return cart.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
}


function getSelectedBillingAdjustment(id) {
    if (!id) return null;
    const selectedId = String(id);
    if (selectedId.startsWith("marketing:")) {
        const deal = marketingDeals.find(x => String(x.id) === selectedId.slice("marketing:".length));
        if (!isMarketingDealAvailableForCheckout(deal)) return null;
        return {
            ...deal,
            source: "marketing",
            calculation: ["percentage", "percent"].includes(String(deal.valueType || "").toLowerCase()) ? "percent" : "fixed"
        };
    }
    const rule = billingAdjustments.find(x => Number(x.id) === Number(id) && x.active !== false);
    if (!rule) return null;
    const applies = String(rule.applies_to || "all").toLowerCase();
    const channel = currentSaleChannelKey();
    if (applies !== "all" && applies !== channel) return null;
    return rule;
}

function isMarketingDealAvailableForCheckout(deal) {
    return !marketingDealUnavailableReason(deal);
}

function marketingDealLocalParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
        weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const dayKey = ({ Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" })[values.weekday];
    const dayIndex = MARKETING_WEEKDAYS.findIndex(day => day.key === dayKey);
    return {
        date: values.year + "-" + values.month + "-" + values.day,
        dayKey,
        previousDayKey: MARKETING_WEEKDAYS[(dayIndex + 6) % 7]?.key,
        minute: Number(values.hour) * 60 + Number(values.minute)
    };
}

function marketingDealScheduleUnavailableReason(deal, now = new Date()) {
    const local = marketingDealLocalParts(now);
    if (deal?.startDate && String(deal.startDate) > local.date) return "Starts " + deal.startDate;
    if (deal?.endDate && String(deal.endDate) < local.date) return "Ended " + deal.endDate;

    const allDays = MARKETING_WEEKDAYS.map(day => day.key);
    const days = Array.isArray(deal?.days) && deal.days.length
        ? deal.days.map(day => String(day).toLowerCase()).filter(day => allDays.includes(day))
        : allDays;
    const dayIsSelected = days.includes(local.dayKey);
    const startTime = String(deal?.startTime || "").trim();
    const endTime = String(deal?.endTime || "").trim();
    if (Boolean(startTime) !== Boolean(endTime)) return "Set both deal hours to use this schedule";
    if (!startTime) return dayIsSelected ? "" : "Not available today";

    const parseTime = value => {
        const match = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.exec(value);
        return match ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : null;
    };
    const start = parseTime(startTime);
    const end = parseTime(endTime);
    if (start === null || end === null || start === end) return "Deal hours are invalid";
    const inWindow = start < end
        ? dayIsSelected && local.minute >= start && local.minute < end
        : (dayIsSelected && local.minute >= start) ||
          (days.includes(local.previousDayKey) && local.minute < end);
    return inWindow ? "" : "Outside deal days or hours";
}

function marketingDealUnavailableReason(deal) {
    if (!deal || deal.active === false) return "Inactive";
    const type = String(deal.type || "").trim().toLowerCase();
    if (["voucher", "payment deals"].includes(type)) return `${deal.type} needs a voucher or payment rule before it can be used at checkout`;
    if (type === "slab-based discount") return "Add slab thresholds before using this deal at checkout";
    if (!["discount", "buy x", "buy x get x", "buy x get y", "meal deals"].includes(type)) return `${deal.type || "Deal"} is not supported at checkout`;
    if (deal.forNewCustomers) return "Select and verify an eligible new customer first";
    if (deal.useMembership) return "Membership eligibility is not linked to this POS customer yet";
    if (deal.requireAuthentication) return "Customer verification is not configured for this checkout";
    if (Number(deal.maxOccurrences) > 0) return "Usage limits are not tracked for checkout yet";
    const scheduleUnavailable = marketingDealScheduleUnavailableReason(deal);
    if (scheduleUnavailable) return scheduleUnavailable;
    const channels = Array.isArray(deal.channels) ? deal.channels : [];
    const normalizeChannel = value => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (channels.length && !channels.map(normalizeChannel).includes(normalizeChannel(currentSaleChannelKey()))) return "Unavailable on this channel";
    return "";
}

function marketingDealAppliesToLine(deal, line) {
    const menuItem = currentMenu.find(item => String(item.id) === String(line.item.id));
    const selectedIds=Array.isArray(deal.itemIds)?deal.itemIds.map(String):[];
    if(selectedIds.length)return selectedIds.includes(String(line.item.id));
    if (deal.itemId && String(deal.itemId) !== String(line.item.id)) return false;
    if (deal.category) {
        const category = menuItem?.category || line.item.category || "";
        if (String(category).trim().toLowerCase() !== String(deal.category).trim().toLowerCase()) return false;
    }
    return true;
}

function marketingDealCartEligibility(deal, lines = cart.map(item => ({ item }))) {
    if (!deal) return { eligible: false, messages: ["Select a marketing deal."] };
    const type = String(deal.type || "").trim().toLowerCase();
    const eligibleIndexes = lines.map((line, index) => marketingDealAppliesToLine(deal, line) ? index : -1).filter(index => index >= 0);
    const eligibleQuantity = eligibleIndexes.reduce((sum, index) => sum + Math.max(0, Number(lines[index].item.quantity || 0)), 0);
    const buyQuantity = Math.max(1, Number(deal.buyQuantity || 1));
    const getQuantity = Math.max(1, Math.floor(Number(deal.getQuantity || 1)));
    const minimumQuantity = Math.max(buyQuantity, Number(deal.minGroupSize || 0));
    const selectedIds = Array.isArray(deal.itemIds) ? deal.itemIds.map(String) : [];
    const names = selectedIds.length
        ? (Array.isArray(deal.itemNames) && deal.itemNames.length ? deal.itemNames : currentMenu.filter(item => selectedIds.includes(String(item.id))).map(item => item.name))
        : [];
    const scope = names.length ? ` for ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more items` : ""}`
        : deal.category ? ` in ${deal.category}` : " from any category";
    const messages = [];
    const isBundle = ["buy x get x", "buy x get y", "meal deals"].includes(type);

    if (isBundle) {
        const rewardId = type === "buy x get x"
            ? (selectedIds.length ? null : deal.itemId)
            : (deal.rewardItemId || (type === "meal deals" ? deal.itemId : null));
        const rewardIndexes = lines.map((line, index) => {
            const itemId = line.item?.id ?? line.item?.menuId ?? line.item?.menu_id;
            return rewardId ? (String(itemId) === String(rewardId) ? index : -1) : (marketingDealAppliesToLine(deal, line) ? index : -1);
        }).filter(index => index >= 0);
        const rewardQuantity = rewardIndexes.reduce((sum, index) => sum + Math.max(0, Number(lines[index].item.quantity || 0)), 0);
        const rewardIsAlsoEligible = !rewardId || rewardIndexes.some(index => eligibleIndexes.includes(index));

        if (rewardIsAlsoEligible) {
            const neededForFirstReward = Math.max(minimumQuantity, buyQuantity + getQuantity);
            if (eligibleQuantity < neededForFirstReward) {
                messages.push(`Add ${neededForFirstReward - eligibleQuantity} more eligible item(s)${scope} to reach ${neededForFirstReward} total for Buy ${buyQuantity}, Get ${getQuantity}. Current order: ${eligibleQuantity}/${neededForFirstReward}.`);
            } else {
                const possibleFreeQuantity = Math.floor(eligibleQuantity / (buyQuantity + getQuantity)) * getQuantity;
                if (rewardQuantity < possibleFreeQuantity) {
                    const rewardName = rewardIndexes.length ? lines[rewardIndexes[0]].item.name : "reward";
                    messages.push(`Add ${possibleFreeQuantity - rewardQuantity} more ${rewardName} reward item(s) to receive the full deal.`);
                }
            }
        } else {
            if (eligibleQuantity < minimumQuantity) {
                messages.push(`Add ${minimumQuantity - eligibleQuantity} more qualifying item(s)${scope} (current order: ${eligibleQuantity}/${minimumQuantity} for Buy ${buyQuantity}).`);
            }
            const possibleFreeQuantity = Math.floor(eligibleQuantity / buyQuantity) * getQuantity;
            const requiredRewardQuantity = Math.max(getQuantity, possibleFreeQuantity);
            if (rewardQuantity < requiredRewardQuantity) {
                const rewardName = rewardId
                    ? (currentMenu.find(item => String(item.id) === String(rewardId))?.name || "selected")
                    : "eligible";
                messages.push(`Add ${requiredRewardQuantity - rewardQuantity} more ${rewardName} reward item(s) (current order: ${rewardQuantity}/${requiredRewardQuantity}).`);
            }
        }
    } else if (eligibleQuantity < minimumQuantity) {
        messages.push(`Add ${minimumQuantity - eligibleQuantity} more eligible item(s)${scope} (current order: ${eligibleQuantity}/${minimumQuantity} required).`);
    }

    return { eligible: messages.length === 0, eligibleQuantity, minimumQuantity, messages };
}

function marketingDiscountPlan(rule, lines) {
    const discounts = lines.map(() => 0);
    const isMarketingDeal = rule?.source === "marketing";
    const eligibleIndexes = lines.map((line, index) => (!isMarketingDeal || marketingDealAppliesToLine(rule, line)) ? index : -1).filter(index => index >= 0);
    const eligibleLines = eligibleIndexes.map(index => lines[index]);
    const discountBase = eligibleLines.reduce((sum, line) => sum + line.net, 0);
    if (!rule || !discountBase) return { discount: 0, discountBase, discounts };

    const type = String(rule.type || "").trim().toLowerCase();
    const buyQuantity = Math.max(1, Number(rule.buyQuantity || 1));
    const eligibleQuantity = eligibleLines.reduce((sum, line) => sum + Math.max(0, Number(line.item.quantity || 0)), 0);
    const minimumQuantity = Math.max(buyQuantity, Number(rule.minGroupSize || 0));
    if (isMarketingDeal && eligibleQuantity < minimumQuantity) return { discount: 0, discountBase, discounts };

    if (isMarketingDeal && ["buy x get x", "buy x get y", "meal deals"].includes(type)) {
        const rewardId = type === "buy x get x" ? (Array.isArray(rule.itemIds)&&rule.itemIds.length?null:rule.itemId) : (rule.rewardItemId || (type === "meal deals" ? rule.itemId : null));
        const rewardIndexes = lines.map((line, index) => {
            const itemId = line.item?.id ?? line.item?.menuId ?? line.item?.menu_id;
            return rewardId ? (String(itemId) === String(rewardId) ? index : -1) : (marketingDealAppliesToLine(rule, line) ? index : -1);
        }).filter(index => index >= 0);
        const getQuantity = Math.max(1, Math.floor(Number(rule.getQuantity || 1)));
        const rewardQuantity = rewardIndexes.reduce((sum, index) => sum + Math.max(0, Number(lines[index].item.quantity || 0)), 0);
        const rewardIsAlsoEligible = rewardIndexes.some(index => eligibleIndexes.includes(index));
        let freeUnits = rewardIsAlsoEligible
            ? Math.floor(eligibleQuantity / (buyQuantity + getQuantity)) * getQuantity
            : Math.floor(eligibleQuantity / buyQuantity) * getQuantity;
        freeUnits = Math.min(freeUnits, rewardQuantity);
        const cheapestFirst = rewardIndexes.sort((a, b) => (lines[a].net / Math.max(Number(lines[a].item.quantity || 1), 1)) - (lines[b].net / Math.max(Number(lines[b].item.quantity || 1), 1)));
        for (const index of cheapestFirst) {
            if (freeUnits <= 0) break;
            const line = lines[index];
            const quantity = Math.max(0, Number(line.item.quantity || 0));
            const unitNet = quantity ? line.net / quantity : 0;
            const freeOnLine = Math.min(quantity, freeUnits);
            discounts[index] = Math.min(line.net, unitNet * freeOnLine);
            freeUnits -= freeOnLine;
        }
        return { discount: discounts.reduce((sum, amount) => sum + amount, 0), discountBase: rewardIndexes.reduce((sum, index) => sum + lines[index].net, 0), discounts };
    }

    let discount = 0;
    if (isMarketingDeal && String(rule.valueType || "").toLowerCase() === "price") {
        discount = eligibleLines.reduce((sum, line) => sum + Math.max(0, line.net - Math.min(line.net, Number(rule.value || 0) * Number(line.item.quantity || 0))), 0);
    } else {
        discount = rule.calculation === "percent"
            ? discountBase * Math.max(0, Number(rule.value || 0)) / 100
            : Math.max(0, Number(rule.value || 0));
    }
    discount = Math.min(discountBase, Math.max(0, discount));
    let left = discount;
    eligibleIndexes.forEach((index, position) => {
        const line = lines[index];
        const amount = position === eligibleIndexes.length - 1 ? left : discount * (line.net / discountBase);
        discounts[index] = Math.min(line.net, amount);
        left = Math.max(0, left - discounts[index]);
    });
    return { discount: discounts.reduce((sum, amount) => sum + amount, 0), discountBase, discounts };
}

function getBillingBreakdown() {
    const discountId = document.getElementById("billingDiscountSelect")?.value || "";
    const chargeId = document.getElementById("billingChargeSelect")?.value || "";
    const discountRule = getSelectedBillingAdjustment(discountId);
    const chargeRule = getSelectedBillingAdjustment(chargeId);

    const gstCalculationEnabled = appSettings.gstCalculationEnabled !== false;
    const lines = cart.map(item => {
        const gross = Number(item.price || 0) * Number(item.quantity || 0);
        const rate = gstCalculationEnabled ? Math.max(0, Number(item.taxRate ?? appSettings.gstRate ?? 0)) : 0;
        const inclusive = gstCalculationEnabled && item.taxMode === "inclusive";
        const net = inclusive && rate ? gross / (1 + rate / 100) : gross;
        return { item, gross, rate, inclusive, net };
    });

    const subtotal = lines.reduce((sum, x) => sum + x.net, 0);

    const discountPlan = marketingDiscountPlan(discountRule, lines);
    const discount = discountPlan.discount;
    const marketingEligibility = discountRule?.source === "marketing"
        ? marketingDealCartEligibility(discountRule, lines)
        : null;
    const marketingDealApplied = Boolean(marketingEligibility?.eligible && discount > 0);
    let gst = 0;
    let inclusiveTax = 0;
    let exclusiveTax = 0;
    let totalBeforeCharge = 0;
    const taxesByRate = {};
    const taxableBasesByRate = {};

    for (const [index, line] of lines.entries()) {
        const adjustedNet = Math.max(0, line.net - Number(discountPlan.discounts[index] || 0));
        const lineTax = adjustedNet * line.rate / 100;
        gst += lineTax;
        if (line.inclusive) inclusiveTax += lineTax;
        else exclusiveTax += lineTax;
        taxesByRate[String(line.rate)] = (taxesByRate[String(line.rate)] || 0) + lineTax;
        if (line.rate > 0) taxableBasesByRate[String(line.rate)] = (taxableBasesByRate[String(line.rate)] || 0) + adjustedNet;
        totalBeforeCharge += adjustedNet + lineTax;
    }
    const taxBreakdown = buildTaxComponentsFromGroups(
        Object.entries(taxableBasesByRate).map(([rate, base]) => ({ rate: Number(rate), base })),
        gst
    );

    const taxable = Math.max(0, subtotal - discount);
    let serviceCharge = 0;
    if (chargeRule) {
        serviceCharge = chargeRule.calculation === "percent"
            ? taxable * Math.max(0, Number(chargeRule.value || 0)) / 100
            : Math.max(0, Number(chargeRule.value || 0));
    }

    const unroundedTotal = Math.max(0, totalBeforeCharge + serviceCharge);
    const roundingMode = ["none", "nearest", "up", "down"].includes(appSettings.totalRoundingMode)
        ? appSettings.totalRoundingMode
        : appSettings.roundTotals ? "nearest" : "none";
    let total = unroundedTotal;
    if (roundingMode === "nearest") total = Math.round(unroundedTotal);
    else if (roundingMode === "up") total = Math.ceil(unroundedTotal);
    else if (roundingMode === "down") total = Math.floor(unroundedTotal);
    total = Math.max(0, total);

    return {
        subtotal, discount, serviceCharge, gst, inclusiveTax, exclusiveTax,
        total, unroundedTotal, roundingAdjustment: total - unroundedTotal, roundingMode, taxable, gstRate: null, taxesByRate, taxBreakdown,
        discountId: discountRule?.source === "marketing" ? null : discountRule?.id || null,
        chargeId: chargeRule?.id || null,
        discountName: discountRule?.source === "marketing" ? (marketingDealApplied ? String(discountRule.name || "") : "") : (discountRule?.name || ""),
        chargeName: chargeRule?.name || "",
        marketingDealId: marketingDealApplied ? String(discountRule.id) : null,
        marketingDealName: marketingDealApplied ? String(discountRule.name || "") : ""
    };
}

function updateBill() {
    const b = getBillingBreakdown();
    const subtotal = b.subtotal, gst = b.gst, total = b.total;


    const subtotalElement =
        document.getElementById("subtotal");

    if (subtotalElement) {

        subtotalElement.textContent =
            money(subtotal);

    }


    const gstElement =
        document.getElementById("gst");

    if (gstElement) {

        gstElement.textContent =
            money(gst);

    }
    renderLiveTaxBreakdown("billingTaxBreakdown", b.taxBreakdown);


    setText("discountAmount", money(b.discount));
    setText("serviceChargeAmount", money(b.serviceCharge));
    const roundingRow = document.getElementById("billingRoundingRow");
    if (roundingRow) roundingRow.style.display = Math.abs(Number(b.roundingAdjustment || 0)) < 0.005 ? "none" : "flex";
    setText("billingRoundingAmount", money(b.roundingAdjustment || 0));
    const discountLabel = document.getElementById("billingDiscountLabel");
    if (discountLabel) discountLabel.textContent = b.discountName ? `Discount · ${b.discountName}` : "Discount";
    const chargeLabel = document.getElementById("billingChargeLabel");
    if (chargeLabel) chargeLabel.textContent = b.chargeName ? `Charge · ${b.chargeName}` : "Service Charge";
    const totalElement =
        document.getElementById("total");

    if (totalElement) {

        totalElement.textContent =
            money(total);

    }

    updateBillingAdjustmentSummary();

}


function previewCurrentBill() {
    const breakdown = getBillingBreakdown();
    const order = currentOpenOrderData?.order || {};
    openBillPreview({
        viewMode: "clean",
        orderNumber: order.order_number || "New Order",
        invoiceNumber: currentOpenOrderData?.invoice?.invoice_number || null,
        orderType,
        tableNumber: document.getElementById("tableNumber")?.value || null,
        pax: orderType === "Dine-in" ? Number(document.getElementById("billingPax")?.value || 1) : null,
        subtotal: breakdown.subtotal,
        discount: breakdown.discount,
        discountName: breakdown.discountName,
        serviceCharge: breakdown.serviceCharge,
        chargeName: breakdown.chargeName,
        gst: breakdown.gst,
        taxBreakdown: breakdown.taxBreakdown,
        total: breakdown.total,
        roundingAdjustment: breakdown.roundingAdjustment,
        paymentMethod: order.payment_method || "Pending",
        paymentAllocations: currentOpenOrderData?.paymentSummary?.allocations || [],
        amountCollected: Number(currentOpenOrderData?.paymentSummary?.amountCollected || 0),
        amountDue: Math.max(0, breakdown.total - Number(currentOpenOrderData?.paymentSummary?.amountCollected || 0)),
        customerName: document.getElementById("billingCustomerNameQuick")?.value.trim() || "",
        customerPhone: document.getElementById("billingCustomerPhoneQuick")?.value.trim() || "",
        customerEmail: document.getElementById("billingCustomerEmailQuick")?.value.trim() || "",
        customerGstin: document.getElementById("billingCustomerGstinQuick")?.value.trim() || "",
        customerBirthDate: document.getElementById("billingCustomerBirthDateQuick")?.value || "",
        customerAddress: document.getElementById("billingCustomerAddressQuick")?.value.trim() || "",
        customerCity: document.getElementById("billingCustomerCityQuick")?.value.trim() || "",
        customerState: document.getElementById("billingCustomerStateQuick")?.value.trim() || "",
        items: cart.map(item => ({
            name: item.name,
            price: Number(item.price),
            quantity: Number(item.quantity),
            options: item.options || [],
            taxRate: Number(item.taxRate ?? appSettings.gstRate ?? 0),
            taxMode: item.taxMode || "exclusive"
        }))
    });
}
function updateCart() {

    const box =
        document.getElementById("cartItems");


    if (!box) {

        return;

    }


    box.innerHTML = "";


    if (!cart.length) {

        box.innerHTML =
            '<p class="empty">No items added.</p>';

        updateBill();
        refreshSideBillPreview();

        return;

    }


    cart.forEach(function(item, index) {

        const row =
            document.createElement("div");

        row.className =
            "cart-item";


        row.innerHTML = `

            <div>

                <div class="cart-item-name">
                    ${esc(item.name)}
                </div>
                ${item.options?.length?`<small class="cart-item-options">${esc(formatItemOptionNames(item.options))}</small>`:''}

                <small>
                    ${money(item.price)} each
                </small>

            </div>


            <div class="quantity">

                <button
                    onclick="changeQuantity(${index}, -1)"
                >
                    −
                </button>

                <span>
                    ${item.quantity}
                </span>

                <button
                    onclick="changeQuantity(${index}, 1)"
                >
                    +
                </button>

            </div>


            <strong>
                ${money(
                    item.price *
                    item.quantity
                )}
            </strong>

        `;


        box.appendChild(row);

    });


    updateBill();
    refreshSideBillPreview();

}

function refreshSideBillPreview() {
    const modal = document.getElementById("billModal");
    if ((modal?.classList.contains("bill-preview-sidecar") || modal?.classList.contains("bill-preview-clean")) && modal.style.display !== "none") previewCurrentBill();
}


// ==========================================
// MENU
// ==========================================

const DEFAULT_POS_CHANNELS = [
    { key: "dine_in", label: "Dine in", orderType: "Dine-in" },
    { key: "takeaway", label: "Takeaway", orderType: "Takeaway" },
    { key: "delivery", label: "Delivery", orderType: "Takeaway" },
    { key: "online", label: "Slash", orderType: "Takeaway", qrMenu: true }
];
const BUILT_IN_POS_CHANNEL_KEYS = new Set(DEFAULT_POS_CHANNELS.map(channel => channel.key));
let POS_CHANNELS = DEFAULT_POS_CHANNELS.map(channel => ({ ...channel }));
function normalizePOSChannels(value) {
    const source = Array.isArray(value) ? value : [];
    const defaultsByKey = new Map(DEFAULT_POS_CHANNELS.map(channel => [channel.key, channel]));
    const entries = [...DEFAULT_POS_CHANNELS, ...source.filter(channel => !defaultsByKey.has(String(channel?.key || "").trim().toLowerCase()))].slice(0, 44);
    const seen = new Set();
    const channels = entries.map(channel => {
        const key = String(channel?.key || "").trim().toLowerCase();
        const fixed = defaultsByKey.get(key);
        return {
            key,
            label: String(fixed?.label || channel?.label || "").trim().slice(0, 60),
            orderType: fixed?.orderType || (channel?.orderType === "Dine-in" ? "Dine-in" : channel?.orderType === "Takeaway" ? "Takeaway" : ""),
            qrMenu: fixed ? fixed.qrMenu === true : channel?.qrMenu === true
        };
    }).filter(channel => {
        if (!/^[a-z][a-z0-9_]{1,19}$/.test(channel.key) || !channel.label || !channel.orderType || seen.has(channel.key)) return false;
        seen.add(channel.key);
        return true;
    });
    if (!channels.some(channel => channel.orderType === "Dine-in") || !channels.some(channel => channel.orderType === "Takeaway") || !channels.some(channel => channel.qrMenu)) return DEFAULT_POS_CHANNELS.map(channel => ({ ...channel }));
    return channels;
}
function syncPOSChannelsFromSettings() {
    POS_CHANNELS = normalizePOSChannels(appSettings.posSalesChannels);
    appSettings.posSalesChannels = POS_CHANNELS.map(channel => ({ ...channel }));
}
function getSaleChannel(key) { return POS_CHANNELS.find(channel => channel.key === String(key || "")) || null; }
function defaultPOSChannelPreferences() {
    const dineIn = POS_CHANNELS.filter(channel => channel.orderType === "Dine-in").map(channel => channel.key);
    const takeaway = POS_CHANNELS.filter(channel => channel.orderType === "Takeaway").map(channel => channel.key);
    return {
        newOrder: { channels: takeaway, defaultChannel: takeaway[0] || "takeaway" },
        tableView: { channels: dineIn, defaultChannel: dineIn[0] || "dine_in" }
    };
}
function normalizePOSChannelPreferences(value) {
    const defaults = defaultPOSChannelPreferences();
    const normalizeModule = function(moduleValue, fallback) {
        const moduleType = fallback === defaults.tableView ? "Dine-in" : "Takeaway";
        const valid = Array.isArray(moduleValue?.channels) ? moduleValue.channels.filter(key => POS_CHANNELS.some(channel => channel.key === key && channel.orderType === moduleType)) : [];
        const channels = valid.length ? [...new Set(valid)] : fallback.channels.slice();
        const defaultChannel = channels.includes(moduleValue?.defaultChannel) ? moduleValue.defaultChannel : channels[0];
        return { channels, defaultChannel };
    };
    const newOrder = normalizeModule(value?.newOrder, defaults.newOrder);
    const tableView = normalizeModule(value?.tableView, defaults.tableView);
    return {
        newOrder,
        tableView
    };
}
function getPOSChannelPreferences() {
    return normalizePOSChannelPreferences(appSettings.posChannelPreferences);
}
function updateBillingChannelLabels() {
    const channel = getSaleChannel(selectedPOSChannelKey);
    const label = channel?.label || (orderType === "Dine-in" ? "Dine" : "Takeaway");
    const orderLabel = document.getElementById("orderType");
    if (orderLabel) orderLabel.textContent = label;
    const menuTitle = document.getElementById("billingMenuTitle");
    if (menuTitle) menuTitle.textContent = label + " menu";
    const hint = document.getElementById("takeawayMenuHint");
    if (hint) hint.textContent = label + " billing is ready — choose items below.";
}
function renderBillingSaleChannelOptions() {
    const select = document.getElementById("billingSaleChannel");
    if (!select) return;
    const preferences = getPOSChannelPreferences();
    const modulePrefs = orderType === "Dine-in" ? preferences.tableView : preferences.newOrder;
    const channels = modulePrefs.channels.length ? modulePrefs.channels : POS_CHANNELS.filter(channel => channel.orderType === orderType).map(channel => channel.key);
    if (!channels.includes(selectedPOSChannelKey)) {
        selectedPOSChannelKey = channels.includes(modulePrefs.defaultChannel)
            ? modulePrefs.defaultChannel
            : channels[0];
    }
    select.innerHTML = channels.map(key => {
        const channel = getSaleChannel(key);
        return channel ? "<option value=\"" + esc(channel.key) + "\">" + esc(channel.label) + "</option>" : "";
    }).join("");
    if (channels.includes(selectedPOSChannelKey)) select.value = selectedPOSChannelKey;
    else {
        selectedPOSChannelKey = channels.includes(modulePrefs.defaultChannel)
            ? modulePrefs.defaultChannel
            : channels[0];
        select.value = selectedPOSChannelKey;
    }
    updateBillingChannelLabels();
    updateBillingCustomerRequirementUI();
}

function clearNewOrderDraft() {
    cart = [];
    cartItemCancellationReasons = [];
    currentOpenOrderId = null;
    currentOpenOrderData = null;
    const saveButton=document.getElementById("saveOrderBtn");if(saveButton)saveButton.textContent="💾 Save Order";
    const orderBadge=document.getElementById("billingOrderState");if(orderBadge)orderBadge.textContent="";

    const clearFields = [
        "tableNumber",
        "billingOrderNotes",
        "billingCustomerNameQuick",
        "billingCustomerPhoneQuick",
        "billingCustomerEmailQuick",
        "billingCustomerGstinQuick",
        "billingCustomerBirthDateQuick",
        "billingCustomerAddressQuick",
        "billingCustomerCityQuick",
        "billingCustomerStateQuick",
        "billingPax",
        "billingDiscountSelect",
        "billingChargeSelect"
    ];
    clearFields.forEach(id => {
        const field = document.getElementById(id);
        if (field) field.value = "";
    });
    setBillingPaxForTable(null, 1);

    const lookupResults = document.getElementById("billingCustomerLookupResults");
    if (lookupResults) {
        lookupResults.hidden = true;
        lookupResults.innerHTML = "";
    }
    closeBillingCustomerPanel();
    updateCart();
}
async function selectBillingSaleChannel(channelKey) {
    const preferences = getPOSChannelPreferences();
    const modulePrefs = orderType === "Dine-in" ? preferences.tableView : preferences.newOrder;
    if (!modulePrefs.channels.includes(channelKey)) return;
    const channel = getSaleChannel(channelKey);
    if (!channel) return;
    selectedPOSChannelKey = channelKey;
    if (channel.orderType !== orderType) setOrderType(channel.orderType, true);
    renderBillingSaleChannelOptions();
    renderBillingAdjustmentSelectors();
    await loadMenu();
    const unavailable = cart.filter(entry => {
        const item = currentMenu.find(candidate => Number(candidate.id) === Number(entry.id));
        return item && !isMenuItemAvailableOnSaleChannel(item, channelKey);
    });
    cart = cart.map(entry => {
        const item = currentMenu.find(candidate => Number(candidate.id) === Number(entry.id));
        if (item && !isMenuItemAvailableOnSaleChannel(item, channelKey)) return null;
        const variant = item?.variants?.find(candidate => Number(candidate.id) === Number(entry.variantId));
        const basePrice=item?resolveMenuPrice(item,variant||null):Number(entry.basePrice??entry.price);
        const optionPrice=(entry.options||[]).flatMap(set=>set.options||[]).reduce((sum,option)=>sum+Number(option.price||0),0);
        return item ? { ...entry, basePrice, price: basePrice+optionPrice } : entry;
    }).filter(Boolean);
    if (unavailable.length) showProfileToast(unavailable.length === 1 ? `${unavailable[0].name} is unavailable on ${channel.label} and was removed.` : `${unavailable.length} unavailable items were removed for ${channel.label}.`);
    updateCart();
    updateBillingCustomerRequirementUI();
    if (isBillingCustomerInfoRequired()) openBillingCustomerPanel();
}
function currentSaleChannelKey() {
    return selectedPOSChannelKey || POS_CHANNELS.find(channel=>channel.orderType===orderType)?.key || "";
}
function normalizeCustomerInfoRequirements(value = appSettings.customerInfoRequirements) {
    const saved = value && typeof value === "object" ? value : {};
    return Object.fromEntries(POS_CHANNELS.map(channel => [channel.key, saved[channel.key] === "required" ? "required" : "optional"]));
}
function isBillingCustomerInfoRequired(channelKey = currentSaleChannelKey()) {
    return normalizeCustomerInfoRequirements()[channelKey] === "required";
}
function updateBillingCustomerRequirementUI() {
    const required = isBillingCustomerInfoRequired();
    const badge = document.getElementById("billingCustomerRequirementLabel");
    if (badge) badge.textContent = required ? "Required · name + mobile" : "Optional";
    const name = document.getElementById("billingCustomerNameQuick");
    const phone = document.getElementById("billingCustomerPhoneQuick");
    [name, phone].forEach(field => {
        if (!field) return;
        field.required = required;
        field.setAttribute("aria-required", String(required));
    });
    const button = document.querySelector(".billing-customer-open-btn");
    if (button) {
        button.title = required ? "Customer name and mobile number are required for this channel" : "Customer information is optional";
        button.setAttribute("aria-label", required ? "Required customer information" : "Optional customer information");
    }
}
function validateBillingCustomerInfo() {
    if (!isBillingCustomerInfoRequired()) return true;
    const name = document.getElementById("billingCustomerNameQuick");
    const phone = document.getElementById("billingCustomerPhoneQuick");
    const missing = !name?.value.trim() ? name : !phone?.value.trim() ? phone : null;
    if (!missing) return true;
    alert(`Customer name and mobile number are required for ${getSaleChannel(currentSaleChannelKey())?.label || "this sale channel"}.`);
    if (document.querySelector("#new-order .billing-shell")?.classList.contains("customer-step")) missing.focus();
    else openBillingCustomerPanel().then(() => missing.focus());
    return false;
}
function continueFromBillingCustomerPanel() {
    if (!validateBillingCustomerInfo()) return;
    closeBillingCustomerPanel();
}
function normalizeMenuSaleChannelKeys(value) {
    if (value === undefined || value === null) return null;
    let source = value;
    if (typeof source === "string") {
        const raw = source.trim();
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            source = Array.isArray(parsed) ? parsed : [parsed];
        } catch (_) {
            source = [raw];
        }
    }
    if (!Array.isArray(source)) return [];
    return [...new Set(source.map(key => String(key || "").trim().toLowerCase().replace(/[\s-]+/g, "_")).filter(Boolean))];
}
function isMenuItemAvailableOnSaleChannel(item, channelKey = currentSaleChannelKey()) {
    const channels = normalizeMenuSaleChannelKeys(item?.sales_channels);
    return channels === null || channels.includes(String(channelKey).trim().toLowerCase().replace(/[\s-]+/g, "_"));
}
function resolveMenuPrice(item, variant=null) {
    const channel = currentSaleChannelKey();
    const candidates = [
        variant?.channel_prices?.[channel],
        variant?.price,
        item?.channel_prices?.[channel],
        item?.price
    ];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined || candidate === "") continue;
        const value = Number(candidate);
        if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
}
function repriceCartForCurrentChannel() {
    if (!cart.length || !currentMenu.length) return;
    cart = cart.map(entry => {
        const item = currentMenu.find(candidate => Number(candidate.id) === Number(entry.id));
        if (item && !isMenuItemAvailableOnSaleChannel(item)) return null;
        const variant = item?.variants?.find(candidate => Number(candidate.id) === Number(entry.variantId));
        const basePrice=item?resolveMenuPrice(item,variant||null):Number(entry.basePrice??entry.price);
        const optionPrice=(entry.options||[]).flatMap(set=>set.options||[]).reduce((sum,option)=>sum+Number(option.price||0),0);
        return item ? { ...entry, basePrice, price: basePrice+optionPrice } : entry;
    }).filter(Boolean);
    updateCart();
}
function menuTaxLabel(item){ return item?.tax_label || (Number(item?.tax_rate||0) ? `GST ${Number(item.tax_rate)}%` : 'Tax 0%'); }
function getAvailableMenuVariants(item) {
    return Array.isArray(item?.variants)
        ? item.variants.filter(variant => variant && variant.available !== false && variant.available !== 0 && !["false", "0"].includes(String(variant.available).toLowerCase()))
        : [];
}
async function loadMenuOptionSets(){
    if(menuOptionSetsLoaded)return menuOptionSets;
    if(!menuOptionSetsLoadPromise){
        menuOptionSetsLoadPromise=api("/menu-option-sets")
            .then(result=>{
                menuOptionSets=Array.isArray(result?.optionSets)?result.optionSets:[];
                menuOptionSetsLoaded=true;
                return menuOptionSets;
            })
            .finally(()=>{menuOptionSetsLoadPromise=null;});
    }
    return menuOptionSetsLoadPromise;
}
async function selectBillingMenuItem(item) {
    if (!isMenuItemAvailableOnSaleChannel(item)) {
        showProfileToast("This item is not available on the selected sale channel.");
        return;
    }
    try{
        await loadMenuOptionSets();
    }catch(error){
        console.error("Item options failed:",error);
        showProfileToast("Could not load item choices. Please try again.");
        return;
    }
    if (Array.isArray(item?.variants) && item.variants.length) {
        openVariantPicker(item);
        return;
    }
    openItemOptionPicker(item);
}
function openVariantPicker(item){
    const variants=getAvailableMenuVariants(item);
    if(!variants.length){alert("This menu item has no available variants right now.");return;}
    const modal=document.getElementById('variantPickerModal'), body=document.getElementById('variantPickerBody');
    if(!modal||!body)return;
    body.innerHTML=`<div class="variant-picker-parent"><strong>${esc(item.name)}</strong><span>${esc(menuTaxLabel(item))}</span></div><p class="variant-picker-hint">Choose a size or variant to add it to the bill.</p><div class="variant-choice-grid">${variants.map(v=>`<button class="variant-choice" type="button" data-variant-id="${esc(v.id)}"><span><strong>${esc(v.name)}</strong><small>${esc(v.unit||item.unit||'ea')}</small></span><b>${money(resolveMenuPrice(item,v))}</b></button>`).join('')}</div>`;
    body.querySelectorAll("[data-variant-id]").forEach(button => {
        button.addEventListener("click", () => chooseVariant(item.id, button.dataset.variantId));
    });
    modal.style.display='flex';
}
function closeVariantPicker(){document.getElementById('variantPickerModal')?.style.setProperty('display','none');}
function chooseVariant(menuId,variantId){const item=currentMenu.find(x=>Number(x.id)===Number(menuId));const v=getAvailableMenuVariants(item).find(x=>Number(x.id)===Number(variantId));if(!item||!v)return;closeVariantPicker();openItemOptionPicker(item,v);}
function itemOptionSets(item){const attached=new Set((Array.isArray(item?.option_set_ids)?item.option_set_ids:[]).map(String));return menuOptionSets.filter(set=>attached.has(String(set.id)));}
function openItemOptionPicker(item,variant=null){
    const sets=itemOptionSets(item),basePrice=resolveMenuPrice(item,variant||null),modal=document.getElementById('itemOptionsModal'),body=document.getElementById('itemOptionsBody');
    if(!sets.length){addToCart(item.id,variant?`${item.name} — ${variant.name}`:item.name,basePrice,item,variant,[],basePrice);return;}
    if(!modal||!body)return;
    modal.dataset.menuId=String(item.id);modal.dataset.variantId=String(variant?.id||'');
    const optionSetMarkup=sets.map(set=>{
        const min=Number(set.minSelections||0),max=Number(set.maxSelections||1);
        const guidance=min?`Required · choose ${min===max?min:`${min}–${max}`}`:`Optional · up to ${max} choice${max===1?'':'s'}`;
        return `<fieldset class="item-option-set"><legend><span>${esc(set.name)}</span><small class="${min?'required':'optional'}">${guidance}</small></legend><div class="item-option-list">${(set.options||[]).map(option=>`<label><input type="${max===1?'radio':'checkbox'}" name="item-option-${esc(set.id)}" data-set-id="${esc(set.id)}" data-option-id="${esc(option.id)}" value="${esc(option.id)}"><span>${esc(option.name)}</span><strong class="${Number(option.price||0)>0?'has-extra':'included'}">${Number(option.price||0)>0?`+ ${money(option.price)}`:'Included'}</strong></label>`).join('')}</div></fieldset>`;
    }).join('');
    body.innerHTML=`<div class="variant-picker-parent"><strong>${esc(item.name)}${variant?` — ${esc(variant.name)}`:''}</strong><span>${money(basePrice)}</span></div>${optionSetMarkup}`;
    modal.dataset.basePrice=String(basePrice);modal.dataset.itemName=variant?`${item.name} — ${variant.name}`:item.name;modal.style.display='flex';
}
function closeItemOptions(){document.getElementById('itemOptionsModal')?.style.setProperty('display','none');}
function confirmItemOptions(){
    const modal=document.getElementById('itemOptionsModal'),menuId=Number(modal?.dataset.menuId),item=currentMenu.find(candidate=>Number(candidate.id)===menuId),variant=item?.variants?.find(candidate=>String(candidate.id)===modal?.dataset.variantId),selected=[...document.querySelectorAll('#itemOptionsBody input:checked')],sets=itemOptionSets(item),selections=[];
    for(const set of sets){const chosen=selected.filter(input=>String(input.dataset.setId)===String(set.id)),min=Number(set.minSelections||0),max=Number(set.maxSelections||1);if(chosen.length<min||chosen.length>max)return alert(`Choose ${min===max?min:`${min} to ${max}`} option${max===1?'':'s'} for ${set.name}.`);if(chosen.length)selections.push({setId:String(set.id),setName:set.name,options:chosen.map(input=>{const option=(set.options||[]).find(value=>String(value.id)===input.dataset.optionId);return {id:String(option.id),name:option.name,price:Number(option.price||0)};})});}
    const basePrice=Number(modal.dataset.basePrice||0),extra=selections.flatMap(set=>set.options).reduce((sum,option)=>sum+Number(option.price||0),0);
    addToCart(menuId,modal.dataset.itemName,basePrice+extra,item,variant,selections,basePrice);closeItemOptions();
}

async function openBillingCustomerPanel() {
    document.querySelector("#new-order .billing-shell")?.classList.add("customer-step");
    document.querySelector(".billing-customer-open-btn")?.setAttribute("aria-expanded", "true");
    if (!Array.isArray(currentCustomers) || currentCustomers.length === 0) await loadCustomers();
    document.getElementById("billingCustomerPhoneQuick")?.focus();
}

function closeBillingCustomerPanel() {
    document.querySelector("#new-order .billing-shell")?.classList.remove("customer-step");
    document.querySelector(".billing-customer-open-btn")?.setAttribute("aria-expanded", "false");
}

function setBillingCustomerLookupMode(mode, selectedButton) {
    const input = document.getElementById("billingCustomerPhoneQuick");
    const label = document.querySelector(".billing-customer-phone-label");
    const countryCode = document.querySelector(".billing-country-code");
    document.querySelectorAll(".billing-customer-mode").forEach(button => button.classList.toggle("active", button === selectedButton));
    const isId = mode === "id";
    if (input) {
        input.type = isId ? "text" : "tel";
        input.value = "";
        input.placeholder = isId ? "Search customer ID" : "Search customer mobile number";
        input.focus();
    }
    if (label) label.textContent = isId ? "Customer ID" : "Mobile Number";
    if (countryCode) countryCode.hidden = isId;
    const results = document.getElementById("billingCustomerLookupResults");
    if (results) {
        results.hidden = true;
        results.innerHTML = "";
    }
}

function searchBillingCustomers(query) {
    const results = document.getElementById("billingCustomerLookupResults");
    if (!results) return;
    const mode = document.querySelector(".billing-customer-mode.active")?.dataset.lookupMode || "phone";
    const rawQuery = String(query || "").trim();
    const searchValue = mode === "phone" ? rawQuery.replace(/\D/g, "") : rawQuery.toLowerCase();
    if (!searchValue) {
        results.hidden = true;
        results.innerHTML = "";
        return;
    }
    const matches = (Array.isArray(currentCustomers) ? currentCustomers : []).filter(customer => {
        if (mode === "id") return String(customer.id || "").toLowerCase().includes(searchValue);
        return String(customer.phone || "").replace(/\D/g, "").includes(searchValue);
    }).slice(0, 6);
    results.innerHTML = matches.length
        ? matches.map(customer => `<button type="button" class="billing-customer-result" role="option" data-customer-id="${esc(customer.id)}"><strong>${esc(customer.name)}</strong><span>${esc(customer.phone || "")}</span></button>`).join("")
        : `<div class="billing-customer-no-results" role="status">No matching customer. Enter the customer's details below to add them to this order.</div>`;
    results.hidden = false;
    results.querySelectorAll("[data-customer-id]").forEach(button => {
        button.addEventListener("click", () => {
            const customer = currentCustomers.find(entry => String(entry.id) === button.dataset.customerId);
            if (!customer) return;
            const phoneMode = document.querySelector('.billing-customer-mode[data-lookup-mode="phone"]');
            if (phoneMode) setBillingCustomerLookupMode("phone", phoneMode);
            const phone = document.getElementById("billingCustomerPhoneQuick");
            const name = document.getElementById("billingCustomerNameQuick");
            const email = document.getElementById("billingCustomerEmailQuick");
            if (phone) phone.value = customer.phone || "";
            if (name) name.value = customer.name || "";
            if (email) email.value = customer.email || "";
            fillBillingCustomerFields(customer);
            results.hidden = true;
            results.innerHTML = "";
        });
    });
}

function getBillingCustomerDetails() {
    const value = id => document.getElementById(id)?.value.trim() || "";
    return {
        name: value("billingCustomerNameQuick"),
        phone: value("billingCustomerPhoneQuick"),
        email: value("billingCustomerEmailQuick"),
        gstin: value("billingCustomerGstinQuick"),
        birthDate: value("billingCustomerBirthDateQuick"),
        address: value("billingCustomerAddressQuick"),
        city: value("billingCustomerCityQuick"),
        state: value("billingCustomerStateQuick")
    };
}

function fillBillingCustomerFields(customer = {}) {
    const fields = {
        billingCustomerGstinQuick: customer.gstin || customer.customer_gstin,
        billingCustomerBirthDateQuick: (customer.birth_date || customer.customer_birth_date) ? String(customer.birth_date || customer.customer_birth_date).slice(0, 10) : "",
        billingCustomerAddressQuick: customer.address || customer.customer_address,
        billingCustomerCityQuick: customer.city || customer.customer_city,
        billingCustomerStateQuick: customer.state || customer.customer_state
    };
    Object.entries(fields).forEach(([id, value]) => {
        const field = document.getElementById(id);
        if (field) field.value = value || "";
    });
}

let menuCategories=[];
async function loadMenuCategories(){
    try{
        menuCategories=await api('/menu/categories');
        renderMenuCategoryMaster();
        populateMenuCategorySelect();
        setText('menuCategoryCount',menuCategories.length);
        return menuCategories;
    }catch(e){
        console.error('Load menu categories failed:',e);
        menuCategories=[];
        return [];
    }
}
function populateMenuCategorySelect(selected=''){
    const select=document.getElementById('menuCategory');
    if(!select)return;
    select.innerHTML='<option value="">Select category</option>'+menuCategories.filter(c=>c.active!==false).map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    if(selected)select.value=String(selected);
}
function renderMenuCategoryMaster(){
    const grid=document.getElementById('menuCategoryMasterGrid');
    const list=document.getElementById('menuCategoryMasterList');
    const html=(menuCategories||[]).length?menuCategories.map(c=>`<div class="menu-category-master-row"><div><strong>${esc(c.name)}</strong><small>Sort ${Number(c.sort_order||0)} · ${c.active?'Active':'Inactive'}</small></div><div class="table-actions"><button type="button" onclick="editMenuCategory(${c.id})">✏️ Edit</button><button type="button" onclick="toggleMenuCategory(${c.id})">${c.active?'Disable':'Enable'}</button><button type="button" onclick="deleteMenuCategory(${c.id})">🗑️ Delete</button></div></div>`).join(''):'<div class="empty">No menu categories created yet.</div>';
    if(grid)grid.innerHTML=html;
    if(list)list.innerHTML=html;
}
function openMenuCategoryModal(category=null){
    document.getElementById('menuCategoryEditingId').value=category?.id||'';
    document.getElementById('menuCategoryName').value=category?.name||'';
    document.getElementById('menuCategorySort').value=category?.sort_order??0;
    document.getElementById('menuCategoryActive').value=category?.active===false?'false':'true';
    document.getElementById('menuCategoryModalTitle').textContent=category?'Edit Menu Category':'Create Menu Category';
    document.getElementById('menuCategoryModal').style.display='flex';
    renderMenuCategoryMaster();
}
function closeMenuCategoryModal(){document.getElementById('menuCategoryModal')?.style.setProperty('display','none');}
function editMenuCategory(id){const c=menuCategories.find(x=>Number(x.id)===Number(id));if(c)openMenuCategoryModal(c);}
async function saveMenuCategory(){
    const id=document.getElementById('menuCategoryEditingId')?.value||'';
    const payload={name:document.getElementById('menuCategoryName')?.value.trim(),sortOrder:Number(document.getElementById('menuCategorySort')?.value||0),active:document.getElementById('menuCategoryActive')?.value!=='false'};
    if(!payload.name)return alert('Enter a category name.');
    try{await api(id?`/menu/categories/${id}`:'/menu/categories',{method:id?'PUT':'POST',body:JSON.stringify(payload)});document.getElementById('menuCategoryName').value='';await loadMenuCategories();await loadMenu();alert(id?'Category updated successfully.':'Category created successfully.');if(!id)document.getElementById('menuCategoryModalTitle').textContent='Create Menu Category';}catch(e){alert(e.message);}
}
async function toggleMenuCategory(id){const c=menuCategories.find(x=>Number(x.id)===Number(id));if(!c)return;try{await api(`/menu/categories/${id}`,{method:'PUT',body:JSON.stringify({name:c.name,sortOrder:c.sort_order,active:!c.active})});await loadMenuCategories();await loadMenu();}catch(e){alert(e.message);}}
async function deleteMenuCategory(id){if(!confirm('Delete this menu category?'))return;try{await api(`/menu/categories/${id}`,{method:'DELETE'});await loadMenuCategories();await loadMenu();}catch(e){alert(e.message);}}

async function loadMenu() {
    try {
        await loadMenuCategories();
        currentMenu = await api("/menu");
        const sidebar = document.getElementById("billingCategorySidebar");
        const grid = document.querySelector("#new-order .menu-grid");
        if (!grid) return;

        const categories = menuCategories.filter(c=>c.active!==false).map(c=>c.name).filter(Boolean);

        if (sidebar) {
    sidebar.innerHTML = "";

    // All Items button
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "category-btn active";
    allButton.innerHTML = `<span>All Items</span>`;

    allButton.addEventListener("click", function () {
        filterCategory("All", allButton);
    });

    sidebar.appendChild(allButton);

    // Database categories
    categories.forEach(function (category) {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "category-btn";

        button.innerHTML =
            `<span class="category-dot"></span><span>${esc(category)}</span>`;

        button.addEventListener("click", function () {
            filterCategory(category, button);
        });

        sidebar.appendChild(button);
    });
}

        grid.innerHTML = "";
        const channelMenu = currentMenu.filter(item => item.available !== false && isMenuItemAvailableOnSaleChannel(item));
        if (!channelMenu.length) {
            grid.innerHTML = `<div class="menu-empty-state">No items are available on the ${esc(getSaleChannel(currentSaleChannelKey())?.label || "selected")} channel. Update item channel availability in Menu Management.</div>`;
            return;
        }
        channelMenu.forEach(item => {
            const card = document.createElement("div");
            card.className = "food-card modern-food-card";
            card.dataset.category = String(item.category || "").trim();
            const variants = getAvailableMenuVariants(item);
            const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
            const variantsUnavailable = hasVariants && variants.length === 0;
            card.classList.toggle("variants-unavailable", variantsUnavailable);
            card.setAttribute("aria-disabled", variantsUnavailable ? "true" : "false");
            card.onclick = () => {
                if (!variantsUnavailable) selectBillingMenuItem(item);
            };

            const image = item.image_url || item.imageUrl || "";
            const startingPrice = variants.length
                ? Math.min(...variants.map(variant => resolveMenuPrice(item, variant)))
                : resolveMenuPrice(item);
            card.innerHTML = `
                <div class="food-card-image">
                    ${image
                        ? `<img src="${esc(image)}" alt="${esc(item.name)}">`
                        : `<div class="food-icon">${menuIcon(item.category)}</div>`}
                    ${hasVariants ? `<span class="variant-badge">${variantsUnavailable ? "Unavailable" : `${variants.length} size${variants.length > 1 ? "s" : ""}`}</span>` : ""}
                </div>
                <div class="food-card-content">
                    <h3>${esc(item.name)}</h3>
                    <p class="food-meta">${esc(item.category || "Uncategorized")} · ${esc(item.unit || "ea")}</p>
                    ${renderMenuItemTagBadges(item.tags,"food-card-tags")}
                    <div class="food-card-bottom"><strong>${variants.length ? `From ${money(startingPrice)}` : variantsUnavailable ? "Unavailable" : money(startingPrice)}</strong><button type="button" ${variantsUnavailable ? "disabled" : ""}>${hasVariants ? "Choose" : "Add"}</button></div>
                </div>`;
            const addBtn = card.querySelector("button");
            if (addBtn) addBtn.onclick = e => {
                e.stopPropagation();
                if (!variantsUnavailable) selectBillingMenuItem(item);
            };
            grid.appendChild(card);
        });
    } catch (e) {
        console.error("Load menu failed:", e);
    }
}

function menuIcon() { return ""; }


function filterCategory(category, button) {
    const selectedCategory = String(category || "")
        .trim()
        .toLowerCase();

    document
        .querySelectorAll("#billingCategorySidebar .category-btn")
        .forEach(function (btn) {
            btn.classList.remove("active");
        });

    if (button) {
        button.classList.add("active");
    }

    document
        .querySelectorAll("#new-order .food-card")
        .forEach(function (card) {
            const cardCategory = String(
                card.dataset.category || ""
            )
                .trim()
                .toLowerCase();

            card.style.display =
                selectedCategory === "all" ||
                cardCategory === selectedCategory
                    ? ""
                    : "none";
        });
}
// ==========================================
// PAYMENT
// ==========================================

let paymentCategory = "full";
let selectedPaymentMethod = "";
let paymentCollectedSoFar = 0;
let paymentDueNow = 0;
let splitPayments = [];
let previousPaymentAllocations = [];

function getCurrentCheckoutBreakdown() {
    const calculated = getBillingBreakdown();
    const order = currentOpenOrderData?.order;
    const isCompletedOrder = String(order?.status || "").trim().toLowerCase() === "completed";
    if (!currentOpenOrderId || (!isQrTrackedOrder(order) && !isCompletedOrder)) return calculated;
    return {
        ...calculated,
        subtotal: Number(order.subtotal || 0),
        discount: Number(order.discount || 0),
        serviceCharge: Number(order.service_charge || 0),
        gst: Number(order.gst || 0),
        total: Number(order.total || 0),
        roundingAdjustment: 0
    };
}

async function openPayment() {
    const newOrderPage = document.getElementById("new-order");
    if (!newOrderPage?.classList.contains("active-page")) return;
    if (!cart.length) return alert("Please add at least one item.");
    if (orderType === "Dine-in" && !document.getElementById("tableNumber")?.value) return alert("Please select a table for Dine-in.");

    paymentCollectedSoFar = 0;
    previousPaymentAllocations = [];
    if (currentOpenOrderId) {
        try {
            const summary = await api(`/orders/${currentOpenOrderId}/payment-summary`);
            paymentCollectedSoFar = Math.max(0, Number(summary.amountCollected || 0));
            previousPaymentAllocations = Array.isArray(summary.allocations) ? summary.allocations : [];
            if (currentOpenOrderData) currentOpenOrderData.paymentSummary = summary;
        } catch (error) {
            return alert("Unable to load previous payments: " + error.message);
        }
    }
    if (!newOrderPage.classList.contains("active-page") || !cart.length) return;

    const breakdown = getCurrentCheckoutBreakdown();
    paymentDueNow = Math.max(0, Number(breakdown.total || 0) - paymentCollectedSoFar);
    paymentCategory = "full";
    selectedPaymentMethod = preferredPaymentMethod();
    renderPaymentMethods();
    splitPayments = [];
    document.querySelectorAll('input[name="paymentCategory"]').forEach(input => input.checked = input.value === "full");
    const received = document.getElementById("cashReceived");
    if (received) received.value = paymentDueNow.toFixed(2);
    const splitAmount = document.getElementById("splitPaymentAmount");
    if (splitAmount) splitAmount.value = "";
    const date = document.getElementById("paymentOrderDate");
    if (date) date.textContent = formatPOSDateTime();
    const type = document.getElementById("paymentOrderType");
    if (type) type.textContent = orderType + (document.getElementById("tableNumber")?.value ? " · " + document.getElementById("tableNumber").value : "");
    document.getElementById("paymentCurrencySymbol") && (document.getElementById("paymentCurrencySymbol").textContent = appSettings.currency || "₹");
    document.querySelectorAll("[data-payment-method]").forEach(button => {
        button.classList.toggle("selected", button.dataset.paymentMethod === selectedPaymentMethod);
        button.setAttribute("aria-pressed", button.dataset.paymentMethod === selectedPaymentMethod ? "true" : "false");
    });
    setPaymentCategory("full");
    const modal = document.getElementById("paymentModal");
    if (modal) modal.style.display = "flex";
}

function closePayment() {
    const modal = document.getElementById("paymentModal");
    if (modal) modal.style.display = "none";
}

function renderNonChargeableReasonOptions() {
    const select = document.getElementById("paymentNonChargeableReason");
    if (!select) return;
    const selected = select.value;
    const reasons = normalizeNonChargeableReasons(appSettings.nonChargeableReasons || DEFAULT_NON_CHARGEABLE_REASONS);
    select.innerHTML = '<option value="">Choose a reason</option>' + reasons.map(reason => `<option value="${esc(reason)}">${esc(reason)}</option>`).join("");
    if (reasons.includes(selected)) select.value = selected;
    const hint = document.getElementById("nonChargeableReasonHint");
    if (hint) hint.textContent = reasons.length ? "Choose the reason for this no-charge bill." : "Add reasons in Settings before completing a non-chargeable bill.";
    select.disabled = reasons.length === 0;
}

function setPaymentCategory(category) {
    const previousCategory = paymentCategory;
    paymentCategory = ["full", "partial", "split", "non-chargeable"].includes(category) ? category : "full";
    const nonChargeable = paymentCategory === "non-chargeable";
    const single = document.getElementById("singlePaymentEntry");
    const split = document.getElementById("splitPaymentEntry");
    const notice = document.getElementById("nonChargeableNotice");
    const methods = document.querySelector(".pos-payment-method-section");
    renderNonChargeableReasonOptions();
    if (single) single.hidden = nonChargeable || paymentCategory === "split";
    if (split) split.hidden = nonChargeable || paymentCategory !== "split";
    if (notice) notice.hidden = !nonChargeable;
    if (methods) methods.hidden = nonChargeable;
    const label = document.getElementById("paymentReceivedLabel");
    if (label) label.textContent = paymentCategory === "partial" ? "Amount to collect" : isCashPaymentMethod(selectedPaymentMethod) ? "Cash received" : "Payment amount";
    const hint = document.getElementById("paymentMethodHint");
    if (hint) hint.textContent = paymentCategory === "split" ? "Choose a method for each amount" : "Choose one method";
    const received = document.getElementById("cashReceived");
    if (received && paymentCategory === "full") received.value = paymentDueNow.toFixed(2);
    if (received && paymentCategory === "partial" && previousCategory !== "partial") received.value = "";
    if (paymentCategory !== "split") {
        splitPayments = [];
        renderSplitPayments();
    }
    updatePaymentSummary();
}

function selectPaymentMethod(method) {
    selectedPaymentMethod = String(method || preferredPaymentMethod());
    document.querySelectorAll("[data-payment-method]").forEach(button => {
        const selected = button.dataset.paymentMethod === selectedPaymentMethod;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    const label = document.getElementById("paymentReceivedLabel");
    if (label && paymentCategory !== "split") label.textContent = paymentCategory === "partial" ? "Amount to collect" : isCashPaymentMethod(selectedPaymentMethod) ? "Cash received" : "Payment amount";
    const received = document.getElementById("cashReceived");
    if (received && paymentCategory === "full" && !isCashPaymentMethod(selectedPaymentMethod)) received.value = paymentDueNow.toFixed(2);
    updatePaymentSummary();
}

function addSplitPayment() {
    const amount = Number(document.getElementById("splitPaymentAmount")?.value || 0);
    if (!Number.isFinite(amount) || amount <= 0) return alert("Enter a payment amount greater than zero.");
    splitPayments.push({ method: selectedPaymentMethod, amount: Math.round(amount * 100) / 100 });
    const input = document.getElementById("splitPaymentAmount");
    if (input) input.value = "";
    renderSplitPayments();
    updatePaymentSummary();
}
function removeSplitPayment(index) {
    splitPayments.splice(index, 1);
    renderSplitPayments();
    updatePaymentSummary();
}
function renderSplitPayments() {
    const list = document.getElementById("splitPaymentList");
    if (!list) return;
    list.innerHTML = splitPayments.map((payment, index) => `<div class="split-payment-row"><span>${esc(payment.method)}</span><strong>${money(payment.amount)}</strong><button type="button" aria-label="Remove payment" onclick="removeSplitPayment(${index})">×</button></div>`).join("");
}
function updatePaymentSummary() {
    const b = getCurrentCheckoutBreakdown();
    const setMoney = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = money(value); };
    setMoney("paymentSubtotal", b.subtotal);
    setMoney("paymentCharges", b.serviceCharge);
    setMoney("paymentTax", b.gst);
    renderLiveTaxBreakdown("paymentTaxBreakdown", b.taxBreakdown);
    setMoney("paymentDiscount", b.discount);
    const roundingRow = document.getElementById("paymentRoundingRow");
    if (roundingRow) roundingRow.hidden = Math.abs(Number(b.roundingAdjustment || 0)) < 0.005;
    setMoney("paymentRounding", b.roundingAdjustment || 0);
    setMoney("paymentBillTotal", b.total);
    setMoney("paymentBillTotalHeader", b.total);
    const due = Math.max(0, Number(b.total || 0) - paymentCollectedSoFar);
    let currentCollection = 0;
    if (paymentCategory === "partial") currentCollection = Math.min(due, Math.max(0, Number(document.getElementById("cashReceived")?.value || 0)));
    if (paymentCategory === "split") currentCollection = Math.min(due, splitPayments.reduce((sum, payment) => sum + payment.amount, 0));
    if (paymentCategory === "full") currentCollection = due;
    if (paymentCategory === "non-chargeable") currentCollection = 0;
    const amountCollected = paymentCollectedSoFar + currentCollection;
    const amountDue = paymentCategory === "non-chargeable" ? 0 : Math.max(0, due - currentCollection);
    setMoney("paymentAmountCollected", amountCollected);
    setMoney("paymentAmountDue", amountDue);
    setMoney("checkoutAmountCollected", amountCollected);
    setMoney("checkoutAmountDue", amountDue);
    const entered = Number(document.getElementById("cashReceived")?.value || 0);
    const applied = paymentCategory === "partial" ? entered : due;
    setMoney("changeAmount", isCashPaymentMethod(selectedPaymentMethod) && paymentCategory !== "split" ? Math.max(0, entered - applied) : 0);
    const allocations = document.getElementById("paymentAllocations");
    if (allocations) allocations.innerHTML = [
        ...previousPaymentAllocations.map(payment => `<div><span>Paid · ${esc(payment.method)}</span><strong>${money(payment.amount)}</strong></div>`),
        ...splitPayments.map(payment => `<div><span>This payment · ${esc(payment.method)}</span><strong>${money(payment.amount)}</strong></div>`)
    ].join("");
}
function updateCashChange() { updatePaymentSummary(); }
function choosePayment(method) { selectPaymentMethod(method); }

async function confirmPOSPayment() {
    const due = Math.max(0, Number(getCurrentCheckoutBreakdown().total || 0) - paymentCollectedSoFar);
    if (paymentCategory === "non-chargeable") {
        const nonChargeableReason = document.getElementById("paymentNonChargeableReason")?.value || "";
        if (!nonChargeableReason) return alert("Choose a non-chargeable reason before continuing.");
        return completeOrder("Non-chargeable", { paymentMode: "non-chargeable", nonChargeable: true, nonChargeableReason, amountDue: due, keepOpen: false });
    }
    if (paymentCategory === "partial") {
        const amount = Math.round(Number(document.getElementById("cashReceived")?.value || 0) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0 || amount >= due) return alert("Enter an amount greater than zero and less than the remaining balance. Use Full Payment to settle the full balance.");
        if (isCashPaymentMethod(selectedPaymentMethod) && Number(document.getElementById("cashReceived")?.value || 0) < amount) return alert("Cash received is less than the payment amount.");
        return completeOrder(selectedPaymentMethod, { paymentMode: "partial", payments: [{ method: selectedPaymentMethod, amount }], amountDue: due, keepOpen: false });
    }
    if (paymentCategory === "split") {
        const amount = Math.round(splitPayments.reduce((sum, payment) => sum + payment.amount, 0) * 100) / 100;
        if (splitPayments.length < 2) return alert("Add at least two payment methods for a split payment.");
        if (Math.abs(amount - due) > 0.01) return alert("Split payments must add up to the remaining balance of " + money(due) + ".");
        return completeOrder(splitPayments.map(payment => payment.method).join(" + "), { paymentMode: "split", payments: splitPayments.slice(), amountDue: due, keepOpen: false });
    }
    const tendered = Number(document.getElementById("cashReceived")?.value || 0);
    if (isCashPaymentMethod(selectedPaymentMethod) && tendered < due) return alert("Cash received is less than the remaining bill amount.");
    return completeOrder(selectedPaymentMethod, { paymentMode: "full", payments: [{ method: selectedPaymentMethod, amount: due }], amountDue: due, keepOpen: false });
}

let completingOrder = false;
let clearNewOrderDraftAfterPayment = false;

async function completeOrder(paymentMethod, paymentOptions = {}) {
    if (completingOrder) return;
    if (!cart.length) return alert("There are no items in the order.");
    const priorOrder = currentOpenOrderData?.order || {};
    const isCompletedDueCollection = Boolean(
        currentOpenOrderId &&
        String(priorOrder.status || "").toLowerCase() === "completed" &&
        Number(currentOpenOrderData?.paymentSummary?.amountDue || 0) > 0
    );
    if (!isCompletedDueCollection && !validateBillingCustomerInfo()) return;
    completingOrder = true;
    const b = getCurrentCheckoutBreakdown();
    const subtotal = b.subtotal;
    const gst = b.gst;
    const total = b.total;
    const isQrExistingOrder = Boolean(currentOpenOrderId && isQrTrackedOrder(priorOrder));
    const paymentsToRecord = Array.isArray(paymentOptions.payments) ? paymentOptions.payments : [{ method: paymentMethod, amount: total }];

    try {
        const tableNumber = document.getElementById("tableNumber")?.value || null;
        const customerName = document.getElementById("billingCustomerNameQuick")?.value.trim() || "";
        const customerPhone = document.getElementById("billingCustomerPhoneQuick")?.value.trim() || "";
        const customerEmail = document.getElementById("billingCustomerEmailQuick")?.value.trim() || "";
        const customerDetails = getBillingCustomerDetails();
        if (Object.values(customerDetails).some(Boolean)) {
            if (!customerName || !customerPhone) throw new Error("Please enter both customer name and phone number, or leave customer details blank.");
        }
        let billingCustomer = null;
        if (customerName && customerPhone && !isQrExistingOrder && !isCompletedDueCollection) {
            const customerResult = await api("/customers/save-for-billing", { method: "POST", body: JSON.stringify(customerDetails) });
            billingCustomer = customerResult.customer || null;
            cacheBillingCustomer(billingCustomer);
        }
        const orderPayload = {
            orderType, saleChannelKey: currentSaleChannelKey(), tableNumber, pax: orderType === "Dine-in" ? Number(document.getElementById("billingPax")?.value || 1) : null, subtotal, gst, total, paymentMethod,
            customerId: billingCustomer?.id || currentOpenOrderData?.order?.customer_id || null,
            discount: b.discount, serviceCharge: b.serviceCharge,
            discountAdjustmentId: b.discountId, chargeAdjustmentId: b.chargeId,
            discountAdjustmentName: b.discountId ? b.discountName : null,
            chargeAdjustmentName: b.chargeId ? b.chargeName : null,
            marketingDealId: b.marketingDealId, marketingDealName: b.marketingDealName,
            notes: document.getElementById("billingOrderNotes")?.value.trim() || null,
            items: cart.map(item => ({ menuId: item.id, variantId: item.variantId || null, name: item.name, price: item.price, basePrice: item.basePrice ?? item.price, options: item.options || [], quantity: item.quantity, unit: item.unit, taxRate: item.taxRate, taxMode: item.taxMode })),
            itemCancellationReasons: cartItemCancellationReasons.slice()
        };
        let order;
        let orderNumber;
        const isNewOrder = !currentOpenOrderId;
        const billItems = cart.map(item => ({ name: item.name, price: Number(item.price), quantity: Number(item.quantity), unit: item.unit || "ea", options: item.options || [], taxRate: Number(item.taxRate ?? appSettings.gstRate ?? 0), taxMode: item.taxMode || "exclusive" }));
        const kotEnabled = appSettings.kotEnabled !== false;
        const checkoutPayload = {
            payments: paymentsToRecord,
            paymentMode: paymentOptions.paymentMode || (paymentOptions.nonChargeable ? "non-chargeable" : paymentOptions.keepOpen ? "partial" : "full"),
            paymentMethod,
            keepOpen: Boolean(paymentOptions.keepOpen),
            nonChargeable: Boolean(paymentOptions.nonChargeable),
            nonChargeableReason: String(paymentOptions.nonChargeableReason || ""),
            createKot: !isNewOrder && !isCompletedDueCollection && kotEnabled && !isQrExistingOrder,
            customerId: billingCustomer?.id || currentOpenOrderData?.order?.customer_id || null
        };
        let settlement;
        if (currentOpenOrderId) {
            const existing = currentOpenOrderData || await api(`/orders/${currentOpenOrderId}`);
            const orderId = existing.order?.id || currentOpenOrderId;
            const updated = isCompletedDueCollection
                ? await api(`/orders/${orderId}/settle`, { method: "POST", body: JSON.stringify(checkoutPayload) })
                : await api(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify({ ...orderPayload, checkout: checkoutPayload }) });
            order = updated.order;
            orderNumber = order.order_number;
            settlement = updated;
        } else {
            orderNumber = (appSettings.orderPrefix || "ORD-") + Date.now().toString().slice(-8);
            const initialStatus = paymentOptions.keepOpen ? "Open" : "Pending";
            const result = await api("/orders", { method: "POST", body: JSON.stringify({ orderNumber, ...orderPayload, initialStatus, createKot: !paymentOptions.keepOpen && kotEnabled, checkout: checkoutPayload }) });
            order = result.order;
            currentOpenOrderId = order.id;
            currentOpenOrderData = { order, items: [] };
            settlement = result;
        }

        const completedOrder = settlement.order || order;
        const invoice = settlement.invoice || null;
        const paymentSummary = settlement.paymentSummary || {};
        closePayment();
        cart = [];
        cartItemCancellationReasons = [];
        currentOpenOrderId = null;
        currentOpenOrderData = null;
        const tableInput = document.getElementById("tableNumber");
        if (tableInput) tableInput.value = "";
        updateCart();
        if (kotEnabled && appSettings.kotPrintMode === "checkout" && !paymentOptions.keepOpen && !isQrExistingOrder) {
            Promise.resolve().then(() => printKOT(order.id)).catch(error => console.warn("Kitchen ticket print failed:", error));
        }
        window.currentBillData = {
            orderId: completedOrder.id || order.id,
            isOpenOrder: Boolean(paymentOptions.keepOpen),
            orderNumber: completedOrder.order_number || orderNumber,
            invoiceNumber: invoice?.invoice_number || null,
            orderType: completedOrder.order_type || orderType,
            tableNumber: completedOrder.table_number || tableNumber,
            pax: completedOrder.pax || (orderType === "Dine-in" ? Number(document.getElementById("billingPax")?.value || 1) : null),
            subtotal: Number(completedOrder.subtotal ?? subtotal),
            discount: Number(completedOrder.discount ?? b.discount),
            discountName: b.discountName,
            serviceCharge: Number(completedOrder.service_charge ?? b.serviceCharge),
            chargeName: b.chargeName,
            gst: Number(completedOrder.gst ?? gst),
            taxBreakdown: b.taxBreakdown,
            total: Number(completedOrder.total ?? total),
            roundingAdjustment: b.roundingAdjustment,
            paymentMethod,
            customerId: completedOrder.customer_id || billingCustomer?.id || null,
            customerName: completedOrder.customer_name || billingCustomer?.name || customerName || priorOrder.customer_name || null,
            customerCode: billingCustomer?.customer_code || billingCustomer?.code || null,
            customerPhone: completedOrder.customer_phone || billingCustomer?.phone || customerPhone || priorOrder.customer_phone || null,
            customerEmail: completedOrder.customer_email || billingCustomer?.email || customerEmail || priorOrder.customer_email || null,
            customerGstin: completedOrder.customer_gstin || billingCustomer?.gstin || customerDetails.gstin || null,
            customerBirthDate: completedOrder.customer_birth_date || billingCustomer?.birth_date || customerDetails.birthDate || null,
            customerAddress: completedOrder.customer_address || billingCustomer?.address || customerDetails.address || null,
            customerCity: completedOrder.customer_city || billingCustomer?.city || customerDetails.city || null,
            customerState: completedOrder.customer_state || billingCustomer?.state || customerDetails.state || null,
            paymentAllocations: paymentSummary.allocations || [],
            cashierName: currentUser?.display_name || currentUser?.username || "",
            amountCollected: Number(paymentSummary.amountCollected || 0),
            amountDue: Number(paymentSummary.amountDue || 0),
            items: billItems
        };
        showPage("new-order");
        showProfileToast(paymentOptions.keepOpen ? "Payment recorded · balance due" : paymentOptions.paymentMode === "partial" ? "Order closed · balance due" : "Sale completed");
        if (!paymentOptions.keepOpen && appSettings.autoPrint === true) Promise.resolve().then(() => window.printThermalBill()).catch(error => console.warn("Bill print failed:", error));
        if (hasPermission("dashboard")) updateDashboard().catch(error=>console.warn("Dashboard refresh failed:",error.message));
    } catch (error) {
        console.error(error);
        alert("Failed to complete payment: " + error.message);
    } finally {
        completingOrder = false;
        if (clearNewOrderDraftAfterPayment) {
            clearNewOrderDraftAfterPayment = false;
            clearNewOrderDraft();
        }
    }
}
async function saveOpenOrder() {
    if (!cart.length) return alert("Please add at least one item to save the order.");
    if (orderType === "Dine-in" && !document.getElementById("tableNumber")?.value) {
        return alert("Please select a table for Dine-in.");
    }
    if (!validateBillingCustomerInfo()) return;

    const openOrderId = currentOpenOrderId;
    const openOrderData = currentOpenOrderData;
    const orderTypeToSave = orderType;
    const orderNotes = document.getElementById("billingOrderNotes")?.value.trim() || "";

    const subtotal = calculateSubtotal();
    const b = getBillingBreakdown();
    const tableNumber = document.getElementById("tableNumber")?.value || null;
    const items = cart.map(item => ({
        menuId: item.id,
        variantId: item.variantId || null,
        name: item.name,
        price: item.price,
        basePrice: item.basePrice ?? item.price,
        options: item.options || [],
        quantity: item.quantity,
        unit: item.unit,
        taxRate: item.taxRate,
        taxMode: item.taxMode
    }));
    const customerName = document.getElementById("billingCustomerNameQuick")?.value.trim() || "";
    const customerPhone = document.getElementById("billingCustomerPhoneQuick")?.value.trim() || "";
    const customerEmail = document.getElementById("billingCustomerEmailQuick")?.value.trim() || "";
    const customerDetails = getBillingCustomerDetails();

    if (Object.values(customerDetails).some(Boolean)) {
        if (!customerName || !customerPhone) return alert("Please enter both customer name and phone number, or leave customer details blank.");
    }

    try {
        let billingCustomer = null;
        if (customerName && customerPhone) {
            const r = await api("/customers/save-for-billing", {
                method: "POST",
                body: JSON.stringify(customerDetails)
            });
            billingCustomer = r.customer || null;
            cacheBillingCustomer(billingCustomer);
        }

        if (openOrderId) {
            const result = await api(`/orders/${openOrderId}`, {
                method: "PUT",
                body: JSON.stringify({
                    orderType: orderTypeToSave, saleChannelKey: currentSaleChannelKey(), tableNumber, pax: orderTypeToSave === "Dine-in" ? Number(document.getElementById("billingPax")?.value || 1) : null, subtotal, gst: b.gst, total: b.total,
                    paymentMethod: openOrderData?.order?.payment_method || null,
                    customerId: billingCustomer?.id || openOrderData?.order?.customer_id || null,
                    discount: b.discount,
                    serviceCharge: b.serviceCharge,
                    discountAdjustmentId: b.discountId,
                    chargeAdjustmentId: b.chargeId,
                    discountAdjustmentName: b.discountId ? b.discountName : null,
                    chargeAdjustmentName: b.chargeId ? b.chargeName : null,
                    marketingDealId: b.marketingDealId,
                    marketingDealName: b.marketingDealName,
                    notes: orderNotes || null,
                    createKot: appSettings.kotEnabled !== false && appSettings.kotPrintMode === "save",
                    items,
                    itemCancellationReasons: cartItemCancellationReasons.slice()
                })
            });
            cart = [];
            cartItemCancellationReasons = [];
            currentOpenOrderId = null;
            currentOpenOrderData = null;
            updateCart();
            await loadTables(); await updateDashboard(); await updateOrdersTable();
            const savedStatus = String(result.order.status || "").toLowerCase();
            showProfileToast(savedStatus === "completed" ? "Bill changes saved successfully." : "Order saved successfully.");
            if (appSettings.kotEnabled !== false && appSettings.kotPrintMode === "save") Promise.resolve().then(() => printKOT(result.order.id)).catch(error => console.warn("Kitchen ticket print failed:", error));
            return;
        }

        const orderNumber = (appSettings.orderPrefix || "ORD-") + Date.now().toString().slice(-8);
        const result = await api("/orders", {
            method: "POST",
            body: JSON.stringify({
                orderNumber, orderType: orderTypeToSave, saleChannelKey: currentSaleChannelKey(), tableNumber, pax: orderTypeToSave === "Dine-in" ? Number(document.getElementById("billingPax")?.value || 1) : null, subtotal,
                gst: b.gst, total: b.total, paymentMethod: null,
                customerId: billingCustomer?.id || null,
                discount: b.discount, serviceCharge: b.serviceCharge,
                discountAdjustmentId: b.discountId, chargeAdjustmentId: b.chargeId,
                discountAdjustmentName: b.discountId ? b.discountName : null,
                chargeAdjustmentName: b.chargeId ? b.chargeName : null,
                marketingDealId: b.marketingDealId,
                marketingDealName: b.marketingDealName,
                notes: orderNotes || null,
                initialStatus: "Open", createKot: appSettings.kotEnabled !== false && appSettings.kotPrintMode === "save", items
            })
        });

        cart = [];
        currentOpenOrderId = null;
        currentOpenOrderData = null;
        updateCart();
        await loadTables(); await updateDashboard(); await updateOrdersTable();
        showProfileToast("Order saved successfully.");
        if (appSettings.kotEnabled !== false && appSettings.kotPrintMode === "save") Promise.resolve().then(() => printKOT(result.order.id)).catch(error => console.warn("Kitchen ticket print failed:", error));
    } catch (error) {
        console.error(error);
        alert("Failed to save open order: " + error.message);
    }
}

async function payOpenOrder(orderId) {
    try {
        const data = await api(`/orders/${orderId}`);
        currentOpenOrderId = orderId;
        currentOpenOrderData = data;
        const order = data.order;
        cartItemCancellationReasons = [];
        cart = (data.items || []).map(item => ({
            id: item.menu_id || ("order-item-" + item.id),
            variantId: item.variant_id || null,
            cartKey: `${item.variant_id ? `${item.menu_id}:${item.variant_id}` : String(item.menu_id || item.id)}:${(item.options || []).flatMap(set => set.options || []).map(option => String(option.id)).sort().join(",")}`,
            name: item.item_name,
            price: Number(item.price),
            basePrice: Number(item.price)-((item.options||[]).flatMap(set=>set.options||[]).reduce((sum,option)=>sum+Number(option.price||0),0)),
            options: item.options || [],
            quantity: Number(item.quantity),
            orderItemId: Number(item.id),
            savedQuantity: Number(item.quantity),
            unit: item.unit || 'ea',
            taxRate: Number(item.tax_rate ?? 5),
            taxMode: item.tax_mode === 'inclusive' ? 'inclusive' : 'exclusive'
        }));
        orderType = order.order_type || "Dine-in";
        setOrderType(orderType);
        if (getSaleChannel(order.sales_channel_key)?.orderType === orderType) {
            selectedPOSChannelKey=order.sales_channel_key;
            renderBillingSaleChannelOptions();
            renderBillingAdjustmentSelectors();
            await loadMenu();
        }
        const tableSelect = document.getElementById("tableNumber");
        if (tableSelect) tableSelect.value = order.table_number || tableSelect.value;
        setBillingPaxForTable(order.table_number, order.pax || 1);
        const discountSelect = document.getElementById("billingDiscountSelect");
        const chargeSelect = document.getElementById("billingChargeSelect");
        if (discountSelect) discountSelect.value = order.marketing_deal_id ? `marketing:${order.marketing_deal_id}` : order.discount_adjustment_id ? String(order.discount_adjustment_id) : "";
        if (chargeSelect) chargeSelect.value = order.charge_adjustment_id ? String(order.charge_adjustment_id) : "";

        const n = document.getElementById("billingCustomerNameQuick");
        const p = document.getElementById("billingCustomerPhoneQuick");
        const e = document.getElementById("billingCustomerEmailQuick");
        if (n) n.value = order.customer_name || "";
        if (p) p.value = order.customer_phone || "";
        if (e) e.value = order.customer_email || "";
        fillBillingCustomerFields(order);
        const note = document.getElementById("billingOrderNotes");
        if (note) note.value = order.notes || "";
        updateCart();
        showPage("new-order");
        openPayment();
    } catch (error) {
        alert("Unable to open order for payment: " + error.message);
    }
}

window.openBillPreview = function(data) {
    window.currentBillData = data || {};

    const modal = document.getElementById("billModal");
    const isCleanPreview = data?.viewMode === "clean";
    modal?.classList.toggle("bill-preview-sidecar", data?.viewMode === "side-panel");
    modal?.classList.toggle("bill-preview-clean", isCleanPreview);
    modal?.classList.add("bill-preview-receipt");

    const restaurantName = document.getElementById("billRestaurantName");
    if (restaurantName) restaurantName.textContent = appSettings.restaurantName || "SLASH POS";
    const businessLegalName = document.getElementById("billBusinessLegalName");
    if (businessLegalName) {
        businessLegalName.textContent = String(appSettings.businessLegalName || "").trim();
        businessLegalName.hidden = !businessLegalName.textContent;
    }
    const restaurantLogo = document.getElementById("billRestaurantLogo");
    if (restaurantLogo) {
        const logo = businessLogoUrl();
        restaurantLogo.src = logo;
        restaurantLogo.hidden = !logo || isCleanPreview;
    }
    const restaurantAddress = document.getElementById("billRestaurantAddress");
    if (restaurantAddress) {
        restaurantAddress.textContent = appSettings.address || "";
        restaurantAddress.hidden = !restaurantAddress.textContent;
    }
    const restaurantPhone = document.getElementById("billRestaurantPhone");
    if (restaurantPhone) {
        restaurantPhone.textContent = appSettings.phone ? `Phone: ${appSettings.phone}` : "";
        restaurantPhone.hidden = !restaurantPhone.textContent;
    }
    const restaurantGstin = document.getElementById("billRestaurantGstin");
    if (restaurantGstin) {
        restaurantGstin.textContent = appSettings.gstin ? `GST#: ${appSettings.gstin}` : "";
        restaurantGstin.hidden = !restaurantGstin.textContent;
    }
    const restaurantFssai = document.getElementById("billRestaurantFssai");
    if (restaurantFssai) {
        restaurantFssai.textContent = appSettings.fssai ? `FSSAI#: ${appSettings.fssai}` : "";
        restaurantFssai.hidden = !restaurantFssai.textContent;
    }
    const customHeader = document.getElementById("billCustomHeader");
    if (customHeader) {
        const configuredHeader = String(appSettings.header || "").trim();
        customHeader.textContent = configuredHeader === "Cafe Management System" ? "" : configuredHeader;
        customHeader.hidden = !customHeader.textContent;
    }
    const invoiceTitle = document.getElementById("billInvoiceTitle");
    if (invoiceTitle) invoiceTitle.textContent = data?.isOpenOrder ? "Order" : "Invoice";
    const customFooter = document.getElementById("billCustomFooter");
    if (customFooter) customFooter.textContent = String(appSettings.footer || "Visit Again!\nThank you.").replace("Thank You!\nVisit Again 😊", "Visit Again!\nThank you.");
    const poweredBy = document.getElementById("billPoweredBy");
    if (poweredBy) {
        poweredBy.textContent = "Powered by Slash";
        poweredBy.hidden = appSettings.showPoweredByCafePilot === false;
    }
    const statusBadge = document.getElementById("billStatusBadge");
    if (statusBadge) {
        const method = String(data?.paymentMethod || "").toLowerCase();
        const status = String(data?.orderStatus || "").toLowerCase();
        const due = Number(data?.amountDue || 0);
        const collected = Number(data?.amountCollected || 0);
        const state = status === "cancelled" ? "cancelled" : /non.?chargeable/.test(method) ? "paid" : due <= 0 ? "paid" : collected > 0 ? "partial" : "open";
        statusBadge.dataset.state = state;
        statusBadge.textContent = state === "cancelled" ? "CANCELLED" : state === "paid" ? (/non.?chargeable/.test(method) ? "NON-CHARGEABLE" : "PAID") : state === "partial" ? "PARTIALLY PAID" : "UNPAID";
    }

    const fallbackItems = Number(data?.orderId) === Number(currentOrderForDetails?.order?.id)
        ? currentOrderForDetails?.items
        : [];
    const sourceItems = Array.isArray(data?.items) && data.items.length ? data.items : fallbackItems;
    const billOrder = Number(data?.orderId) === Number(currentOrderForDetails?.order?.id)
        ? currentOrderForDetails.order
        : { order_number: data?.orderNumber, total: data?.total, subtotal: data?.subtotal, gst: data?.gst };
    const items = normalizeOrderBillItems(sourceItems, billOrder);
    const taxBreakdown = Array.isArray(data?.taxBreakdown) ? data.taxBreakdown : buildBillTaxBreakdown(items, data.discount, data.gst);
    window.currentBillData = { ...data, items, taxBreakdown };
    const totalQuantity = items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0);
    const customerCode = data?.customerCode || (data?.customerId ? `#${data.customerId}` : "");
    const printToken = document.getElementById("billPrintToken");
    if (printToken) {
        printToken.textContent = `Token No: ${data.tokenNumber}`;
        printToken.hidden = !data.tokenNumber;
    }
    setText("billPrintGuestName", data?.customerName || "Guest");
    const printCustomerCode = document.getElementById("billPrintCustomerCode");
    if (printCustomerCode) {
        printCustomerCode.textContent = customerCode;
        printCustomerCode.hidden = !customerCode;
    }
    setText("billPrintInvoiceNumber", `${data?.isOpenOrder ? "Order" : "Invoice"} ${data?.invoiceNumber || data?.orderNumber || "—"}`);
    setText("billPrintItemCount", `${items.length} ${items.length === 1 ? "item" : "items"} (${totalQuantity} Qty)`);
    setText("billPrintDate", data?.date || formatPOSDateTime());
    const printCashier = document.getElementById("billPrintCashier");
    if (printCashier) {
        printCashier.textContent = data?.cashierName || "";
        printCashier.hidden = !printCashier.textContent;
    }
    const orderContext = document.getElementById("billPrintOrderContext");
    if (orderContext) {
        orderContext.textContent = [data?.orderType, data?.tableNumber ? `Table ${data.tableNumber}` : "", Number(data?.pax) > 0 ? `${Number(data.pax)} PAX` : ""].filter(Boolean).join(" · ");
        orderContext.hidden = !orderContext.textContent;
    }
    const itemCount = document.getElementById("billQuickItemCount");
    if (itemCount) itemCount.textContent = `${items.length} ${items.length === 1 ? "item" : "items"}`;
    const subtotalLabel = document.getElementById("billSubtotalLabel");
    if (subtotalLabel) subtotalLabel.textContent = "Sub Total";
    const totalLabel = document.getElementById("billTotalLabel");
    if (totalLabel) totalLabel.textContent = isCleanPreview ? "Bill Total" : "TOTAL";
    const nameHeader = document.getElementById("billItemNameHeader");
    if (nameHeader) nameHeader.textContent = isCleanPreview ? "Name" : "Item";
    const rateHeader = document.getElementById("billItemRateHeader");
    if (rateHeader) rateHeader.textContent = isCleanPreview ? "Rate" : "Price";
    const amountHeader = document.getElementById("billItemAmountHeader");
    if (amountHeader) amountHeader.textContent = isCleanPreview ? "Amount" : "Total";

        const billActions =
        document.querySelector(
            "#billModal .bill-actions"
        );

    if (
        billActions &&
        !document.getElementById("thermalPaperWidth")
    ) {

        const paperLabel =
            document.createElement("label");

        paperLabel.style.display =
            "inline-flex";

        paperLabel.style.alignItems =
            "center";

        paperLabel.style.gap =
            "6px";

        paperLabel.style.marginRight =
            "8px";

        paperLabel.innerHTML = `
            <span>Paper:</span>

            <select
                id="thermalPaperWidth"
                style="
                    padding:6px;
                    border:1px solid #ccc;
                    border-radius:6px;
                ">

                <option value="80">
                    80mm
                </option>

                <option value="58">
                    58mm
                </option>

            </select>
        `;

        billActions.insertBefore(
            paperLabel,
            billActions.firstChild
        );

        const savedWidth =
            localStorage.getItem(
                "cafeThermalPaperWidth"
            );

        if (
            savedWidth === "58" ||
            savedWidth === "80"
        ) {
            document.getElementById(
                "thermalPaperWidth"
            ).value = savedWidth;
        }

        document.getElementById(
            "thermalPaperWidth"
        ).addEventListener(
            "change",
            function() {

                localStorage.setItem(
                    "cafeThermalPaperWidth",
                    this.value
                );

            }
        );

    }

    if (!modal) {
        alert("Bill modal not found.");
        return;
    }

    document.getElementById("billOrderNumber").textContent =
        data.orderNumber || "-";

    const invoiceRow = document.getElementById("billInvoiceRow");
    if (invoiceRow) invoiceRow.style.display = data.invoiceNumber ? "flex" : "none";
    setText("billInvoiceNumber", data.invoiceNumber || "-");

    document.getElementById("billDate").textContent =
        data.date || formatPOSDateTime();

    document.getElementById("billOrderType").textContent =
        data.isOpenOrder ? `OPEN ORDER · ${data.orderType || "-"}` : data.orderType || "-";

    document.getElementById("billTableNumber").textContent =
        data.tableNumber ? `${data.tableNumber}${Number(data.pax) > 0 ? ` · ${Number(data.pax)} PAX` : ""}` : "-";

    document.getElementById("billSubtotal").textContent =
        money(data.subtotal || 0);

    const billDiscountRow = document.getElementById("billDiscountRow");
    const billDiscountAmount = Number(data.discount || 0);
    if (billDiscountRow) {
        billDiscountRow.style.display = billDiscountAmount > 0 ? "flex" : "none";
        const label = document.getElementById("billDiscountLabel");
        if (label) label.textContent = data.discountName ? `Discount · ${data.discountName}` : "Discount";
        const amount = document.getElementById("billDiscountAmount");
        if (amount) amount.textContent = `−${money(billDiscountAmount)}`;
    }

    const billChargeRow = document.getElementById("billChargeRow");
    const billChargeAmount = Number(data.serviceCharge || 0);
    if (billChargeRow) {
        billChargeRow.style.display = billChargeAmount > 0 ? "flex" : "none";
        const label = document.getElementById("billChargeLabel");
        if (label) label.textContent = data.chargeName ? `Charge · ${data.chargeName}` : "Charges";
        const amount = document.getElementById("billChargeAmount");
        if (amount) amount.textContent = money(billChargeAmount);
    }

    document.getElementById("billGST").textContent =
        money(data.gst || 0);
    const billGstRow = document.getElementById("billGstRow");
    if (billGstRow) billGstRow.style.display = isCleanPreview && Number(data.gst || 0) <= 0 ? "none" : "";
    const billTaxBreakdown = document.getElementById("billTaxBreakdown");
    if (billTaxBreakdown) {
        billTaxBreakdown.innerHTML = taxBreakdown.map(row =>
            `<div><span>${esc(row.component)} ${esc(formatBillTaxRate(row.rate))}% on ${esc(money(row.taxableBase))}</span><strong>${esc(money(row.taxAmount))}</strong></div>`
        ).join("");
        billTaxBreakdown.style.display = taxBreakdown.length ? "block" : "none";
    }
    if (billGstRow) billGstRow.style.display = taxBreakdown.length ? "none" : (isCleanPreview && Number(data.gst || 0) <= 0 ? "none" : "");

    const roundedTotal = Number(data.total || 0);
    const roundingAdjustmentValue = Number(data.roundingAdjustment || 0);
    const unroundedTotal = roundedTotal - roundingAdjustmentValue;
    setText("billTotalLabel", "Bill Total");
    setText("billTotal", money(unroundedTotal));
    setText("billRoundedTotal", money(roundedTotal));
    const roundedTotalRow = document.getElementById("billRoundedTotalRow");
    if (roundedTotalRow) roundedTotalRow.style.display = "flex";

    const billRoundingRow = document.getElementById("billRoundingRow");
    if (billRoundingRow) billRoundingRow.style.display = "none";
    setText("billRounding", money(roundingAdjustmentValue));

    const allocations = Array.isArray(data.paymentAllocations) ? data.paymentAllocations : [];
    const collected = data.amountCollected === undefined
        ? allocations.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
        : Math.max(0, Number(data.amountCollected || 0));
    const allocationList = document.getElementById("billPaymentAllocations");
    if (allocationList) allocationList.innerHTML = allocations.length
        ? allocations.map(payment => `<div><span>${esc(payment.method || "Payment")}</span><strong>${money(payment.amount || 0)}</strong></div>`).join("")
        : (!data.isOpenOrder && collected > 0 ? `<div><span>${esc(data.paymentMethod || "Payment")}</span><strong>${money(collected)}</strong></div>` : "");
    const paymentMethodLine = document.getElementById("billPaymentMethod");
    if (paymentMethodLine) {
        paymentMethodLine.textContent = "";
        paymentMethodLine.hidden = true;
    }
    const due = data.amountDue === undefined
        ? Math.max(0, Number(data.total || 0) - collected)
        : Math.max(0, Number(data.amountDue || 0));
    setText("billAmountCollected", money(collected));
    setText("billAmountDue", money(due));
    const collectedRow = document.getElementById("billCollectedRow");
    if (collectedRow) collectedRow.style.display = "none";
    const paymentSection = document.getElementById("billPayment");
    if (paymentSection) paymentSection.style.display = data.isOpenOrder ? "none" : "block";

    const tableRow = document.getElementById("billTableRow");

    if (tableRow) {
        tableRow.style.display =
            data.tableNumber ? "block" : "none";
    }

    const billCustomerRow =
        document.getElementById("billCustomerRow");

    const billCustomerDetails =
        document.getElementById("billCustomerDetails");

    const customerParts = [];

    if (data.customerName) customerParts.push(data.customerName);
    if (data.customerPhone) customerParts.push(data.customerPhone);
    if (data.customerEmail) customerParts.push(data.customerEmail);
    if (data.customerGstin) customerParts.push("GSTIN: " + data.customerGstin);
    if (data.customerBirthDate) customerParts.push("DOB: " + data.customerBirthDate);
    if (data.customerAddress) customerParts.push(data.customerAddress);
    if (data.customerCity) customerParts.push(data.customerCity);
    if (data.customerState) customerParts.push(data.customerState);

    if (billCustomerRow && billCustomerDetails) {
        billCustomerRow.style.display =
            customerParts.length ? "block" : "none";
        billCustomerDetails.textContent =
            customerParts.join(" • ");
    }

    const body = document.getElementById("billItemsBody");

    if (body) {

        body.innerHTML = "";

        items.forEach(function(item, index) {
            const row = document.createElement("tr");
            const qty = Number(item.quantity || 0);
            const price = Number(item.price || 0);
            const lineTotal = Number(item.lineTotal) > 0 || price === 0 ? Number(item.lineTotal || 0) : qty * price;
            const optionText = formatItemOptionNames(item.options);
            const unit = String(item.unit || "ea").trim();
            const name = appSettings.uppercaseItems ? String(item.name || "-").toUpperCase() : String(item.name || "-");
            row.className = "bill-print-item-row";
            row.innerHTML = `<td colspan="3"><strong>${index + 1}. ${esc(name)}</strong><small>${qty} @ ${esc(money(price))}/${esc(unit)}</small>${optionText ? `<small class="bill-print-item-options">${esc(optionText)}</small>` : ""}</td><td class="bill-print-item-total">${esc(money(lineTotal))}</td>`;
            body.appendChild(row);
        });
    }

    modal.style.display = "flex";
};


window.closeBillModal = function() {

    const modal = document.getElementById("billModal");

    if (modal) {
        modal.style.display = "none";
        modal.classList.remove("bill-preview-sidecar");
        modal.classList.remove("bill-preview-clean");
    }

};


window.printBill = function() {

    window.printThermalBill({ manual: true });
};

  const width =
    document.getElementById(
        "thermalPaperWidth"
    )?.value ||
    localStorage.getItem(
        "cafeThermalPaperWidth"
    ) ||
    "80";

window.printThermalBill = async function(options = {}) {
    const data = window.currentBillData;
    const manualPrint = options.manual === true;
    const configuredBillCopies = Math.min(20, Math.max(0, Math.floor(Number(appSettings.billCopies) || 0)));
    const billCopies = manualPrint && configuredBillCopies === 0 ? 1 : configuredBillCopies;
    if (!data) return alert("No bill is available to print.");
    if (!manualPrint && billCopies === 0) { showProfileToast("Automatic bill printing skipped · copies set to 0"); return; }

    if (!(window.cafePrinters || []).some(printer => printer.is_default && printer.active !== false) && data.orderId) {
        try { window.cafePrinters = await api("/printers?source=order"); }
        catch (error) { return alert("Could not load an order printer: " + error.message); }
    }

    const defaultPrinter = (window.cafePrinters || []).find(function(printer) {
        return printer.is_default && printer.active !== false;
    });

    if (!defaultPrinter) {
        return alert("No default bill printer is configured. Open Printer settings and select a default printer.");
    }

    const markBillPrinted=async()=>{
        if(data.orderId&&!data.isOpenOrder){
            await api(`/orders/${Number(data.orderId)}/printed`,{method:"POST"});
            if(Array.isArray(currentOrders)){const order=currentOrders.find(item=>Number(item.id)===Number(data.orderId));if(order)order.bill_printed_at=order.bill_printed_at||new Date().toISOString();}
        }
    };
    const source=data.orderId?"?source=order":"";
    try {
        // LOCAL = Windows installed printer. Print directly through the local Slash POS Printer Service.
        if (defaultPrinter.connection_type === "local") {
            const receipt = printerReceiptText(data, defaultPrinter.paper_width || appSettings.paperWidth || "80");
            if (window.cafePOSDesktop?.saveReceiptPdf && /microsoft print to pdf/i.test(defaultPrinter.name)) {
                const result = await window.cafePOSDesktop.saveReceiptPdf({
                    kind: "invoice",
                    bill: data,
                    settings: {
                        restaurantName: appSettings.restaurantName,
                        businessLegalName: appSettings.businessLegalName,
                        businessType: appSettings.businessType,
                        address: appSettings.address,
                        phone: appSettings.phone,
                        gstin: appSettings.gstin,
                        fssai: appSettings.fssai,
                        currency: appSettings.currency,
                        businessLogoUrl: businessLogoUrl(),
                        header: appSettings.header,
                        footer: appSettings.footer,
                        customerMessage: appSettings.customerMessage,
                        showPoweredByCafePilot: appSettings.showPoweredByCafePilot
                    }
                });
                if (!result?.success || !result.outputFile) throw new Error(result?.error || "Could not create the invoice PDF.");
                await markBillPrinted();
                showProfileToast((data.isOpenOrder ? "Proforma PDF saved to " : "Invoice PDF saved to ") + result.outputFile);
                return;
            }
            const serviceUrl = window.CAFE_PRINT_SERVICE_URL || "http://127.0.0.1:18181";
            let result = {};
            for (let copy = 0; copy < billCopies; copy++) {
                const response = await fetch(serviceUrl + "/print", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ printerName: defaultPrinter.name, receipt, paperWidth: defaultPrinter.paper_width || appSettings.paperWidth || "80" })
                });
                result = await response.json().catch(function(){ return {}; });
                if (!response.ok) throw new Error(result.error || "Windows print service rejected the job.");
            }
            await markBillPrinted();
            showProfileToast(result.outputFile ? "PDF saved to " + result.outputFile : "Bill sent to " + defaultPrinter.name + ".");
            return;
        }

        if (defaultPrinter.connection_type === "network") {
            await api("/printers/" + defaultPrinter.id + "/print"+source, {
                method: "POST",
                body: JSON.stringify({ receipt: data, settings: appSettings, copies: billCopies })
            });
            await markBillPrinted();
            showProfileToast("Bill sent to " + defaultPrinter.name + ".");
            return;
        }

        if (defaultPrinter.connection_type === "bluetooth") {
            const receipt = printerReceiptText(data, defaultPrinter.paper_width || appSettings.paperWidth || "80");
            for (let copy = 0; copy < billCopies; copy++) await sendBluetoothPrinterText(defaultPrinter, receipt, false);
            await markBillPrinted();
            showProfileToast("Bill sent to " + defaultPrinter.name + ".");
            return;
        }

        throw new Error("Unsupported printer connection type.");
    } catch (error) {
        console.error("Direct bill printing failed:", error);
        alert("Could not print to " + defaultPrinter.name + ": " + error.message);
    }
};

// ==========================================
// ORDERS
// ==========================================

function getOrderAmountDue(order) {
    const reportedDue = Number(order?.amount_due);
    if (Number.isFinite(reportedDue)) return Math.max(0, reportedDue);
    if (/non.?chargeable/i.test(String(order?.payment_method || ""))) return 0;
    const total = Number(order?.total || 0);
    const collected = Number(order?.amount_collected || 0);
    return Math.max(0, Math.round((total - collected) * 100) / 100);
}

async function updateOrdersTable(refresh = true, refreshSelectedDetails = true) {
    try {
        if (refresh || !Array.isArray(currentOrders)) currentOrders = await api("/orders");
        const list = document.getElementById("ordersTableBody");
        if (!list) return;
        renderOrderFilterOptions();
        const allOrders = Array.isArray(currentOrders) ? currentOrders : [];
        const group = order => {
            const status = String(order.status || "").toLowerCase();
            return status === "completed" ? "closed" : status === "cancelled" ? "cancelled" : "open";
        };
        const hasAmountDue = order => group(order) === "closed" && getOrderAmountDue(order) > 0;
        const openOrders = allOrders.filter(order => group(order) === "open");
        const closedOrders = allOrders.filter(order => group(order) === "closed" && !hasAmountDue(order));
        const amountDueOrders = allOrders.filter(hasAmountDue);
        const cancelledOrders = allOrders.filter(order => group(order) === "cancelled");
        const statusFilter = document.getElementById("ordersStatusFilter")?.value || "";
        const activeTab = window.currentOrdersTab || "open";
        document.querySelectorAll(".orders-tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === (statusFilter || activeTab)));
        const selectedGroup = statusFilter || activeTab;
        const baseOrders = allOrders.filter(order => {
            if (selectedGroup === "amount_due") return hasAmountDue(order);
            if (selectedGroup === "closed") return group(order) === "closed" && !hasAmountDue(order);
            return group(order) === selectedGroup;
        });
        const query = String(document.getElementById("ordersSearch")?.value || "").trim().toLocaleLowerCase();
        const fromDate = document.getElementById("ordersDateFrom")?.value || "";
        const toDate = document.getElementById("ordersDateTo")?.value || "";
        const channel = String(document.getElementById("ordersChannelFilter")?.value || "").toLocaleLowerCase();
        const paymentMode = document.getElementById("ordersPaymentFilter")?.value || "";
        const localDateKey = value => {
            return getPOSDateKey(value);
        };
        const visibleOrders = baseOrders.filter(order => {
            const orderDate = localDateKey(order.created_at);
            const searchMatch = !query || [order.order_number,order.id,order.order_type,order.table_number,order.pax,order.status,order.payment_method,order.customer_name,order.customer_phone].some(value => String(value || "").toLocaleLowerCase().includes(query));
            const dateMatch = (!fromDate || orderDate >= fromDate) && (!toDate || orderDate <= toDate);
            const channelMatch = !channel || String(order.sale_channel || order.order_type || "").toLocaleLowerCase() === channel;
            const methods = Array.isArray(order.payment_modes) ? order.payment_modes.map(value => String(value || "").trim().toLocaleLowerCase()).filter(Boolean) : [];
            const method = String(order.payment_method || "").trim().toLocaleLowerCase();
            const paymentMatch = !paymentMode || (paymentMode === "__unpaid" ? !methods.length && (!method || method === "unpaid" || method === "partially paid") : methods.includes(paymentMode.toLocaleLowerCase()) || method === paymentMode.toLocaleLowerCase());
            return searchMatch && dateMatch && channelMatch && paymentMatch;
        });
        const title = document.getElementById("ordersListTitle");
        if (title) title.textContent = `${statusFilter || activeTab} orders`.replace(/^./, value => value.toUpperCase());
        const count = document.getElementById("ordersResultCount");
        if (count) count.textContent = `${visibleOrders.length} ${visibleOrders.length === 1 ? "order" : "orders"}`;
        list.innerHTML = visibleOrders.map(order => {
            const selected = Number(window.selectedOrderId) === Number(order.id);
            const status = String(order.status || "Open");
            const statusClass = group(order);
            const dueOrder = hasAmountDue(order);
            const orderDate = order.created_at ? formatPOSDateTime(order.created_at) : "";
            const tableMeta = [order.sale_channel || order.order_type, order.table_number ? `Table ${esc(order.table_number)}${Number(order.pax) > 0 ? ` · ${Number(order.pax)} PAX` : ""}` : ""].filter(Boolean).map(esc).join(" · ") || "-";
            const orderId = Number(order.id);
            const cardClass = `order-list-card ${selected ? "selected" : ""}`;
            const heading = `<span class="order-list-card-top"><strong>${esc(order.order_number || `#${order.id}`)}</strong><span class="order-status-pill ${dueOrder ? "due" : statusClass}">${dueOrder ? "Amount Due" : esc(status)}</span></span>`;
            const normalizedStatus = status.trim().toLowerCase();
            if (isQrTrackedOrder(order) && !["completed", "cancelled"].includes(normalizedStatus)) {
                const customerMeta = order.customer_name || (statusClass === "open" ? "Unpaid" : "");
                return `<article class="${cardClass} qr-order-list-card" data-order-id="${orderId}" role="listitem" tabindex="0" onclick="viewOrder(${orderId})" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();viewOrder(${orderId})}"><button type="button" class="order-list-card-open" onclick="event.stopPropagation();viewOrder(${orderId})" aria-label="Open ${esc(order.order_number || `order ${orderId}`)}">${heading}</button><div class="qr-order-list-meta"><span>${tableMeta}</span>${customerMeta ? `<span>${esc(customerMeta)}</span>` : ""}</div>${renderQrOrderListAction(order)}</article>`;
            }
            return `<article class="${cardClass}" data-order-id="${orderId}" role="listitem"><button type="button" class="order-list-card-open" onclick="viewOrder(${orderId})" aria-label="Open ${esc(order.order_number || `order ${orderId}`)}">${heading}<span class="order-list-card-meta"><span>${tableMeta}</span><span>${esc(orderDate)}</span></span><span class="order-list-card-bottom"><span>${dueOrder ? "Outstanding balance" : esc(order.customer_name || order.payment_method || (statusClass === "open" ? "Unpaid" : ""))}</span><strong>${money(dueOrder ? getOrderAmountDue(order) : order.total)}</strong></span></button></article>`;
        }).join("") || `<div class="orders-empty-state"><span>⌕</span><strong>No matching orders</strong><small>Try changing the search or filters.</small></div>`;

        const openCount = document.getElementById("openOrdersCount");
        const closedCount = document.getElementById("closedOrdersCount");
        const cancelledCount = document.getElementById("cancelledOrdersCount");
        const amountDueCount = document.getElementById("amountDueOrdersCount");
        if (openCount) openCount.textContent = openOrders.length;
        if (closedCount) closedCount.textContent = closedOrders.length;
        if (cancelledCount) cancelledCount.textContent = cancelledOrders.length;
        if (amountDueCount) amountDueCount.textContent = amountDueOrders.length;

        const selectedVisible = visibleOrders.find(order => Number(order.id) === Number(window.selectedOrderId));
        if (visibleOrders.length && (!selectedVisible || (refresh && refreshSelectedDetails))) {
            await viewOrder(selectedVisible?.id || visibleOrders[0].id);
            lastOrderDetailsRefreshAt = Date.now();
        }
        else if (!visibleOrders.length) closeOrderDetails();
    } catch (error) {
        console.error("Orders failed:", error);
    }
}

function renderOrderFilterOptions() {
    const channelSelect = document.getElementById("ordersChannelFilter");
    if (channelSelect) {
        const selected = channelSelect.value;
        const channels = [...new Set(["Dine-in","Takeaway",...(currentOrders || []).map(order => String(order.sale_channel || order.order_type || "").trim()).filter(Boolean)])];
        channelSelect.innerHTML = '<option value="">All channels</option>' + channels.map(channel => `<option value="${esc(channel)}">${esc(channel)}</option>`).join("");
        if (channels.includes(selected)) channelSelect.value = selected;
    }
    const paymentSelect = document.getElementById("ordersPaymentFilter");
    if (paymentSelect) {
        const selected = paymentSelect.value;
        const modes = normalizePaymentModes(appSettings.paymentModes).map(mode => mode.name);
        paymentSelect.innerHTML = '<option value="">All payment modes</option><option value="__unpaid">Unpaid</option>' + modes.map(mode => `<option value="${esc(mode)}">${esc(mode)}</option>`).join("");
        if (["__unpaid",...modes].includes(selected)) paymentSelect.value = selected;
    }
}

function filterOrders() {
    syncOrdersFilterToggle();
    updateOrdersTable(false);
}

function toggleOrdersFilters() {
    const panel = document.getElementById("ordersFilterBar");
    const button = document.getElementById("ordersFilterToggle");
    if (!panel || !button) return;
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    button.title = expanded ? "Hide order filters" : "Show order filters";
    button.classList.toggle("expanded", expanded);
}

function syncOrdersFilterToggle() {
    const badge = document.getElementById("ordersFilterBadge");
    if (!badge) return;
    const activeCount = ["ordersStatusFilter", "ordersDateFrom", "ordersDateTo", "ordersChannelFilter", "ordersPaymentFilter"]
        .filter(id => String(document.getElementById(id)?.value || "").trim()).length;
    badge.textContent = String(activeCount);
    badge.hidden = activeCount === 0;
    document.getElementById("ordersFilterToggle")?.classList.toggle("has-active-filters", activeCount > 0);
}

function clearOrdersSearch() {
    const input = document.getElementById("ordersSearch");
    if (input) input.value = "";
    updateOrdersTable(false);
    input?.focus();
}

function resetOrdersFilters() {
    ["ordersSearch","ordersDateFrom","ordersDateTo","ordersChannelFilter","ordersPaymentFilter","ordersStatusFilter"].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = "";
    });
    syncOrdersFilterToggle();
    switchOrdersTab("open");
}

function downloadOrdersCSV() {
    const orders = (Array.isArray(currentOrders) ? currentOrders : []).filter(order => {
        const statusFilter = document.getElementById("ordersStatusFilter")?.value || window.currentOrdersTab || "open";
        const status = String(order.status || "").toLowerCase();
        const group = status === "completed" ? "closed" : status === "cancelled" ? "cancelled" : "open";
        const dueOrder = group === "closed" && getOrderAmountDue(order) > 0;
        const inSelectedBucket = statusFilter === "amount_due" ? dueOrder : group === statusFilter && !(statusFilter === "closed" && dueOrder);
        if (!inSelectedBucket) return false;
        const dateKey = getPOSDateKey(order.created_at);
        const from = document.getElementById("ordersDateFrom")?.value || "";
        const to = document.getElementById("ordersDateTo")?.value || "";
        const channel = String(document.getElementById("ordersChannelFilter")?.value || "").toLowerCase();
        const payment = document.getElementById("ordersPaymentFilter")?.value || "";
        const methods = Array.isArray(order.payment_modes) ? order.payment_modes.map(value => String(value || "").trim().toLowerCase()).filter(Boolean) : [];
        const method = String(order.payment_method || "").trim().toLowerCase();
        const query = String(document.getElementById("ordersSearch")?.value || "").trim().toLowerCase();
        return (!from || dateKey >= from) && (!to || dateKey <= to) && (!channel || String(order.sale_channel || order.order_type || "").toLowerCase() === channel) && (!payment || (payment === "__unpaid" ? !methods.length && (!method || method === "unpaid" || method === "partially paid") : methods.includes(payment.toLowerCase()) || method === payment.toLowerCase())) && (!query || [order.order_number,order.id,order.order_type,order.table_number,order.pax,order.status,order.payment_method,methods.join(" "),order.customer_name,order.customer_phone].some(value => String(value || "").toLowerCase().includes(query)));
    });
    if (!orders.length) return alert("No orders match the current filters.");
    const columns = [["Order number","order_number"],["Order ID","id"],["Date","created_at"],["Status","status"],["Sale channel","sale_channel"],["Table","table_number"],["PAX","pax"],["Customer","customer_name"],["Phone","customer_phone"],["Payment mode","payment_method"],["Subtotal","subtotal"],["Discount","discount"],["Charges","service_charge"],["GST","gst"],["Total","total"],["Amount due","amount_due"]];
    const cell = value => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    const csv = "\uFEFF" + [columns.map(([label]) => label),...orders.map(order => columns.map(([,key]) => key === "created_at" && order[key] ? formatPOSDateTime(order[key]) : key === "payment_method" && Array.isArray(order.payment_modes) && order.payment_modes.length ? order.payment_modes.join(" + ") : order[key]))].map(row => row.map(cell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = `cafe-pos-orders-${getPOSDateKey()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
}

window.switchOrdersTab = function(tab) {
    window.currentOrdersTab = ["closed","cancelled","amount_due"].includes(tab) ? tab : "open";
    const statusFilter = document.getElementById("ordersStatusFilter");
    if (statusFilter) statusFilter.value = "";
    document.querySelectorAll(".orders-tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === window.currentOrdersTab));
    updateOrdersTable(false);
};

async function viewOrderActivity(orderId) {
    const modal = document.getElementById("orderActivityModal");
    const list = document.getElementById("orderActivityList");
    const title = document.getElementById("orderActivityTitle");
    if (!modal || !list) return;
    const order = (currentOrders || []).find(item => Number(item.id) === Number(orderId));
    if (title) title.textContent = `Activity Log · ${order?.order_number || `Order #${orderId}`}`;
    list.innerHTML = '<p class="access-muted">Loading activity…</p>';
    modal.style.display = "flex";
    try {
        const result = await api(`/orders/${Number(orderId)}/activity`);
        const entries = Array.isArray(result.activities) ? result.activities : [];
        list.innerHTML = entries.length ? entries.map(item => `
            <article class="order-activity-entry">
                <span class="order-activity-marker" aria-hidden="true"></span>
                <div class="order-activity-copy"><strong>${esc(item.event_type || "Order updated")}</strong><p>${esc(item.description || "-")}</p><small>${esc(item.actor || "Staff")} · ${esc(item.created_at ? formatPOSDateTime(item.created_at) : "-")}</small></div>
            </article>`).join("") : '<p class="access-muted">No activity has been recorded for this order.</p>';
    } catch (error) {
        list.innerHTML = `<p class="access-muted">Unable to load activity: ${esc(error.message)}</p>`;
    }
}

function closeOrderActivity() {
    const modal = document.getElementById("orderActivityModal");
    if (modal) modal.style.display = "none";
}

let orderActionMenuDismissListener = null;
function closeOrderDetailsMenu() {
    const menu = document.getElementById("orderDetailsMoreMenu");
    const button = document.getElementById("orderDetailsMoreButton");
    if (menu) menu.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    if (orderActionMenuDismissListener) {
        document.removeEventListener("click", orderActionMenuDismissListener);
        orderActionMenuDismissListener = null;
    }
}
function toggleOrderDetailsMenu(event) {
    event?.stopPropagation();
    const menu = document.getElementById("orderDetailsMoreMenu");
    const button = document.getElementById("orderDetailsMoreButton");
    if (!menu || !button) return;
    if (!menu.hidden) return closeOrderDetailsMenu();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    orderActionMenuDismissListener = event => {
        if (!event.target.closest(".orders-detail-more-wrap")) closeOrderDetailsMenu();
    };
    setTimeout(() => document.addEventListener("click", orderActionMenuDismissListener), 0);
}
function focusOrderInfo() {
    closeOrderDetailsMenu();
    const content = document.getElementById("orderDetailsContent");
    if (content) content.scrollTo({ top: 0, behavior: "smooth" });
}

function isQrTrackedOrder(order) {
    return Boolean(order?.public_tracking_token) || /^QR-/i.test(String(order?.order_number || ""));
}

function renderQrOrderListAction(order) {
    const status = String(order?.status || "").trim().toLowerCase();
    const orderId = Number(order?.id);
    let label = "";
    let action = "";
    let className = "";
    let permitted = false;
    let permissionHint = "";
    if (status === "pending") {
        label = "Accept";
        action = `updateQrOrderWorkflow(${orderId},'Preparing')`;
        className = "accept";
        permitted = hasPermission("kitchen", "edit");
        permissionHint = "Kitchen edit access is required to accept this order.";
    } else if (status === "preparing") {
        label = "Mark ready";
        action = `updateQrOrderWorkflow(${orderId},'Ready')`;
        className = "ready";
        permitted = hasPermission("kitchen", "edit");
        permissionHint = "Kitchen edit access is required to mark this order ready.";
    } else if (status === "ready") {
        label = "Checkout";
        action = `checkoutQrOrder(${orderId})`;
        className = "checkout";
        permitted = hasPermission("payments", "create") && hasPermission("new_order", "view");
        permissionHint = "Checkout access is required to complete this order.";
    } else {
        return "";
    }
    return `<button type="button" class="qr-order-list-action ${className}" onclick="event.stopPropagation();${action}"${permitted ? "" : ` disabled title="${permissionHint}"`}>${label}</button>`;
}

function renderQrOrderWorkflow(order) {
    const panel = document.getElementById("qrOrderWorkflow");
    if (!panel) return;
    const status = String(order?.status || "").trim().toLowerCase();
    if (!isQrTrackedOrder(order) || ["completed", "cancelled"].includes(status)) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
    }
    const canAdvance = hasPermission("kitchen", "edit");
    const canCheckout = hasPermission("payments", "create") && hasPermission("new_order", "view");
    let note = "";
    if (status === "pending") {
        note = "New QR order · use Accept on its order card to send the ticket to the kitchen.";
    } else if (status === "preparing") {
        note = "Accepted · kitchen is preparing this order. Mark it ready from its order card.";
    } else if (status === "ready") {
        note = "Ready · complete checkout from its order card to close this QR order.";
    }
    if (status === "ready" && !canCheckout) note += " Ask a cashier with checkout access to complete payment.";
    else if (!canAdvance && status !== "ready") note += " You do not have kitchen edit access for this step.";
    panel.innerHTML = `<div class="qr-order-workflow-copy"><span class="eyebrow">QR ORDER FLOW</span><strong>${esc(note)}</strong></div>`;
    panel.hidden = false;
}

async function updateQrOrderWorkflow(orderId, status) {
    try {
        await api(`/orders/${Number(orderId)}/qr-status`, { method: "PUT", body: JSON.stringify({ status }) });
        if (status === "Preparing" && appSettings.kotEnabled !== false && hasPermission("kitchen", "print")) await printKOT(orderId);
        await updateOrdersTable(true, false);
        await viewOrder(orderId);
        if (appSettings.kotEnabled !== false && hasPermission("kitchen", "view")) await loadKOT(false);
    } catch (error) {
        alert(error.message || "Could not update this QR order.");
    }
}

async function checkoutQrOrder(orderId) {
    closeOrderDetailsMenu();
    await payOpenOrder(Number(orderId));
}

async function viewOrder(orderId) {

    try {

        const data = await api("/orders/" + Number(orderId));
        const paymentSummary = data.paymentSummary || null;


        currentOrderForDetails =
            data;

        const order =
            data.order;

        window.selectedOrderId = Number(order.id);


        const sourceItems = Array.isArray(data.items) ? data.items : [];
        const items = sourceItems.map(item => {
            const qty = Math.max(1, Number(item.quantity || 1));
            const missingLineValues = Number(item.price || 0) === 0 && Number(item.line_total || 0) === 0;
            if (String(order.order_number || "").startsWith("QR-") && sourceItems.length === 1 && missingLineValues && Number(order.total || 0) > 0) {
                const gross = Number(order.subtotal || 0) + Number(order.gst || 0);
                return { ...item, price: gross / qty, line_total: gross };
            }
            return item;
        });

        const discountAdjustmentName = order.discount_adjustment_name || order.marketing_deal_name || "";
        const chargeAdjustmentName = order.charge_adjustment_name || "";

        const paymentAllocations = Array.isArray(paymentSummary?.allocations) ? paymentSummary.allocations : [];
        const amountCollected = paymentSummary
            ? Math.max(0, Number(paymentSummary.amountCollected || 0))
            : paymentAllocations.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
        const amountDue = paymentSummary
            ? Math.max(0, Number(paymentSummary.amountDue || 0))
            : Math.max(0, Number(order.total || 0) - amountCollected);


        const box =
            document.getElementById(
                "orderDetailsContent"
            );


        if (!box) {

            return;

        }


        box.innerHTML = `

            <div class="order-detail-summary">
                <div><span>Sale channel</span><strong>${esc(order.sale_channel || order.order_type || "-")}</strong></div>
                <div><span>Table</span><strong>${esc(order.table_number || "-")}${order.table_number && Number(order.pax) > 0 ? ` · ${Number(order.pax)} PAX` : ""}</strong></div>
                <div><span>Status</span><strong>${esc(order.status || "-")}</strong></div>
                <div><span>Payment mode</span><strong>${esc(order.payment_method || "Unpaid")}</strong></div>
                ${order.non_chargeable_reason ? `<div><span>Non-chargeable reason</span><strong>${esc(order.non_chargeable_reason)}</strong></div>` : ""}
            </div>

            ${order.customer_name || order.customer_phone || order.customer_gstin || order.customer_address ? `<div class="order-customer-info"><strong>Customer</strong><span>${esc(order.customer_name || "")}${order.customer_phone ? ` · ${esc(order.customer_phone)}` : ""}${order.customer_email ? ` · ${esc(order.customer_email)}` : ""}</span>${order.customer_gstin ? `<small>GSTIN: ${esc(order.customer_gstin)}</small>` : ""}${order.customer_address ? `<small>${esc(order.customer_address)}${order.customer_city ? `, ${esc(order.customer_city)}` : ""}${order.customer_state ? `, ${esc(order.customer_state)}` : ""}</small>` : ""}</div>` : ""}


            <div class="table-container">

                <table>

                    <thead>

                        <tr>

                            <th>Item</th>
                            <th>Qty</th>
                            <th>Price</th>
                            <th>Total</th>

                        </tr>

                    </thead>


                    <tbody>

                        ${
                            items
                                .map(function(item) {

                                    return `

                                        <tr>

                                            <td>
                                                ${esc(
                                                    item.item_name
                                                )}${formatItemOptionNames(item.options)?`<br><small>${esc(formatItemOptionNames(item.options))}</small>`:""}
                                            </td>

                                            <td>
                                                ${item.quantity}
                                            </td>

                                            <td>
                                                ${money(
                                                    item.price
                                                )}
                                            </td>

                                            <td>
                                                ${money(
                                                    item.line_total
                                                )}
                                            </td>

                                        </tr>

                                    `;

                                })
                                .join("")
                        }

                    </tbody>

                </table>

            </div>


        <div class="bill">

                <div>

                    <span>Subtotal</span>

                    <span>
                        ${money(order.subtotal)}
                    </span>

                </div>


                <div>

                    <span>GST</span>

                    <span>
                        ${money(order.gst)}
                    </span>

                </div>

                ${Number(order.discount||0)>0?`<div><span>${discountAdjustmentName?`Discount · ${esc(discountAdjustmentName)}`:'Discount'}</span><span>−${money(order.discount)}</span></div>`:''}
                ${Number(order.service_charge||0)>0?`<div><span>${chargeAdjustmentName?`Charge · ${esc(chargeAdjustmentName)}`:'Charges'}</span><span>${money(order.service_charge)}</span></div>`:''}


                <div class="total">

                    <strong>Total</strong>

                    <strong>
                        ${money(order.total)}
                    </strong>

                </div>

                <div class="order-details-payment-summary">
                    <strong>Payment details</strong>
                    ${paymentAllocations.length ? paymentAllocations.map(payment => `<div><span>${esc(payment.method || "Payment")}</span><strong>${money(payment.amount || 0)}</strong></div>`).join("") : `<div><span>${esc(order.payment_method || "Payment")}</span><strong>${amountCollected > 0 ? money(amountCollected) : "—"}</strong></div>`}
                    <div><span>Amount Collected</span><strong>${money(amountCollected)}</strong></div>
                    <div class="due"><span>Amount Due</span><strong>${money(amountDue)}</strong></div>
                </div>

            </div>

        `;


        const empty = document.getElementById("orderDetailsEmpty");
        const actions = document.getElementById("orderDetailsActions");
        const title = document.getElementById("orderDetailsPanelTitle");
        const hint = document.getElementById("orderDetailsPanelHint");
        if (empty) empty.hidden = true;
        if (box) box.hidden = false;
        if (title) title.textContent = order.order_number || `Order #${order.id}`;
        if (hint) hint.textContent = `${order.created_at ? formatPOSDateTime(order.created_at) : ""}${order.customer_name ? ` · ${order.customer_name}` : ""}`;
        if (actions) {
            const status = String(order.status || "").toLowerCase();
            const closed = status === "completed";
            const cancelled = status === "cancelled";
            const canEdit = closed
                ? (order.bill_printed_at ? hasPermission("orders", "edit_after_print") || hasPermission("orders", "edit_closed") : hasPermission("orders", "edit_closed"))
                : !cancelled && (hasPermission("orders", "edit_open") || hasPermission("orders", "edit"));
            const canCancel = !cancelled && (closed ? hasPermission("orders", "cancel_closed") : (hasPermission("orders", "edit_open") || hasPermission("orders", "edit")));
            const toolbar = document.getElementById("orderDetailsToolbar");
            const orderIdValue = Number(order.id);
            const isQrOrder = isQrTrackedOrder(order);
            const hasOutstandingBalance = amountDue > 0.009;
            const canTakePayment = !cancelled && (
                (closed && hasOutstandingBalance) ||
                (!closed && (!isQrOrder || status === "ready"))
            );
            const menuItems = [
                `<button type="button" role="menuitem" onclick="closeOrderDetailsMenu();viewOrderBill(${orderIdValue})">🧾 View bill</button>`,
                `<button type="button" role="menuitem" onclick="closeOrderDetailsMenu();viewOrderActivity(${orderIdValue})">◷ Activity</button>`,
                canTakePayment && (!isQrOrder || closed) ? `<button type="button" role="menuitem" onclick="closeOrderDetailsMenu();payOpenOrder(${orderIdValue})">💳 Take payment</button>` : "",
                canEdit ? `<button type="button" role="menuitem" onclick="closeOrderDetailsMenu();editOpenOrder(${orderIdValue})">✎ Edit order</button>` : "",
                canCancel ? `<button type="button" role="menuitem" class="danger" onclick="closeOrderDetailsMenu();cancelOrder(${orderIdValue})">Cancel order</button>` : "",
                `<button type="button" role="menuitem" onclick="closeOrderDetailsMenu();printCurrentOrder()">🖨️ Print bill</button>`
            ].filter(Boolean);
            const moreMenu = document.getElementById("orderDetailsMoreMenu");
            if (moreMenu) moreMenu.innerHTML = menuItems.join("");
            if (toolbar) toolbar.hidden = false;
            renderQrOrderWorkflow(order);
            actions.innerHTML = "";
            actions.hidden = true;
        }
        document.querySelectorAll(".order-list-card").forEach(card => card.classList.toggle("selected", Number(card.dataset.orderId) === Number(order.id)));


    } catch (error) {

        alert(error.message);

    }

}


function closeOrderDetails() {
    closeOrderDetailsMenu();
    const qrWorkflow = document.getElementById("qrOrderWorkflow");
    if (qrWorkflow) { qrWorkflow.hidden = true; qrWorkflow.innerHTML = ""; }
    window.selectedOrderId = null;
    const title = document.getElementById("orderDetailsPanelTitle");
    const hint = document.getElementById("orderDetailsPanelHint");
    const empty = document.getElementById("orderDetailsEmpty");
    const content = document.getElementById("orderDetailsContent");
    const actions = document.getElementById("orderDetailsActions");
    const toolbar = document.getElementById("orderDetailsToolbar");
    if (title) title.textContent = "Select an order";
    if (hint) hint.textContent = "Choose an order from the list to see its items and bill.";
    if (empty) empty.hidden = false;
    if (content) { content.hidden = true; content.innerHTML = ""; }
    if (actions) { actions.hidden = true; actions.innerHTML = ""; }
    if (toolbar) toolbar.hidden = true;
    document.querySelectorAll(".order-list-card.selected").forEach(card => card.classList.remove("selected"));
}


let pendingCancellationOrderId = null;
let pendingItemCancellationResolver = null;
function requestItemCancellationReason(item) {
    return new Promise(resolve => {
        const order = currentOpenOrderData?.order || {};
        const reasons = normalizeCancellationReasons(appSettings.cancellationReasons || DEFAULT_CANCELLATION_REASONS);
        const select = document.getElementById("cancelItemReason");
        if (select) select.innerHTML = reasons.map(reason => `<option value="${esc(reason)}">${esc(reason)}</option>`).join("");
        const closed = String(order.status || "").toLowerCase() === "completed";
        const orderLabel = order.order_number || (currentOpenOrderId ? `#${currentOpenOrderId}` : "this order");
        const description = document.getElementById("cancelItemDialogDescription");
        if (description) description.textContent = `Remove one ${item.name || "item"} from ${closed ? "closed bill" : "open order"} ${orderLabel}? Choose a reason to record this cancellation.`;
        const error = document.getElementById("cancelItemDialogError");
        if (error) {
            error.textContent = reasons.length ? "" : "Add a cancellation reason in Settings before removing items.";
            error.hidden = reasons.length > 0;
        }
        const confirmButton = document.getElementById("confirmCancelItemButton");
        if (confirmButton) confirmButton.disabled = reasons.length === 0;
        pendingItemCancellationResolver = resolve;
        document.getElementById("cancelItemModal").style.display = "flex";
    });
}

function finishItemCancellationReason(reason = "") {
    const modal = document.getElementById("cancelItemModal");
    if (modal) modal.style.display = "none";
    const resolve = pendingItemCancellationResolver;
    pendingItemCancellationResolver = null;
    if (resolve) resolve(reason);
}

function closeCancelItemDialog() {
    finishItemCancellationReason("");
}

function confirmCancelItem() {
    const reason = document.getElementById("cancelItemReason")?.value || "";
    const error = document.getElementById("cancelItemDialogError");
    if (!reason) {
        if (error) { error.textContent = "Choose a cancellation reason before removing the item."; error.hidden = false; }
        return;
    }
    finishItemCancellationReason(reason);
}

function cancelOrder(orderId) {
    const order = currentOrders.find(entry => Number(entry.id) === Number(orderId));
    const closed = String(order?.status || "").toLowerCase() === "completed";
    if (closed && !hasPermission("orders", "cancel_closed")) return alert("You do not have permission to cancel a closed order.");
    if (!closed && !hasPermission("orders", "edit_open") && !hasPermission("orders", "edit")) return alert("You do not have permission to cancel this open order.");
    pendingCancellationOrderId = Number(orderId);
    const reasons = normalizeCancellationReasons(appSettings.cancellationReasons || DEFAULT_CANCELLATION_REASONS);
    const reasonSelect = document.getElementById("cancelOrderReason");
    if (reasonSelect) reasonSelect.innerHTML = reasons.map(reason => `<option value="${esc(reason)}">${esc(reason)}</option>`).join("");
    const description = document.getElementById("cancelOrderDialogDescription");
    if (description) description.textContent = `${closed ? "Cancel closed order" : "Cancel open order"} ${order?.order_number || `#${orderId}`}? This action cannot be undone.`;
    const paymentNotice = document.getElementById("cancelOrderPaymentNotice");
    if (paymentNotice) paymentNotice.hidden = !closed;
    const error = document.getElementById("cancelOrderDialogError");
    if (error) { error.hidden = true; error.textContent = ""; }
    const confirmButton = document.getElementById("confirmCancelOrderButton");
    if (confirmButton) confirmButton.disabled = !reasons.length;
    if (!reasons.length && error) { error.textContent = "Add a cancellation reason in Settings before cancelling orders."; error.hidden = false; }
    document.getElementById("cancelOrderModal").style.display = "flex";
}

function closeCancelOrderDialog() {
    const modal = document.getElementById("cancelOrderModal");
    if (modal) modal.style.display = "none";
    pendingCancellationOrderId = null;
}

async function submitCancelOrder() {
    const orderId = Number(pendingCancellationOrderId);
    const reason = document.getElementById("cancelOrderReason")?.value || "";
    const errorBox = document.getElementById("cancelOrderDialogError");
    const confirmButton = document.getElementById("confirmCancelOrderButton");
    if (!orderId) return;
    if (!reason) {
        if (errorBox) { errorBox.textContent = "Add a cancellation reason in Settings before cancelling orders."; errorBox.hidden = false; }
        return;
    }
    if (!confirm(`Cancel order ${currentOrders.find(order => Number(order.id) === orderId)?.order_number || `#${orderId}`}?`)) return;
    if (confirmButton) confirmButton.disabled = true;
    if (errorBox) { errorBox.hidden = true; errorBox.textContent = ""; }
    try {
        await api(`/orders/${orderId}/cancel`, { method: "PUT", body: JSON.stringify({ reason }) });
        closeCancelOrderDialog();
        await updateOrdersTable();
        await loadTables();
        if (hasPermission("dashboard", "view")) await updateDashboard();
        if (window.selectedOrderId === orderId) await viewOrder(orderId);
        showProfileToast("Order cancelled and recorded.");
    } catch (error) {
        if (errorBox) { errorBox.textContent = error.message || "Could not cancel this order."; errorBox.hidden = false; }
    } finally {
        if (confirmButton) confirmButton.disabled = false;
    }
}


// ==========================================
// PRINT CUSTOMER BILL
// ==========================================

async function printCurrentOrder() {
    if (!currentOrderForDetails) return alert("Open an order first.");

    const order = currentOrderForDetails.order || {};
    const sourceItems = currentOrderForDetails.items || [];

    window.currentBillData = {
        orderId: Number(order.id) || null,
        isOpenOrder: String(order.status || "").toLowerCase() !== "completed",
        invoiceNumber: order.invoice_number || order.invoiceNumber || order.order_number || "-",
        orderNumber: order.order_number || "-",
        orderType: order.order_type || "-",
        tableNumber: order.table_number || "",
        pax: order.pax || null,
        date: order.created_at ? formatPOSDateTime(order.created_at) : formatPOSDateTime(),
        customerName: order.customer_name || "",
        customerPhone: order.customer_phone || "",
        customerEmail: order.customer_email || "",
        customerGstin: order.customer_gstin || "",
        customerBirthDate: order.customer_birth_date || "",
        customerAddress: order.customer_address || "",
        customerCity: order.customer_city || "",
        customerState: order.customer_state || "",
        items: normalizeOrderBillItems(sourceItems, order).map(function(item) {
            return {
                name: item.item_name || item.name || "-",
                quantity: Number(item.quantity || 0),
                price: Number(item.price || 0),
                options: item.options || [],
                taxRate: Number(item.taxRate ?? item.tax_rate ?? 0),
                taxMode: item.taxMode || item.tax_mode || "exclusive"
            };
        }),
        subtotal: Number(order.subtotal || 0),
        discount: Number(order.discount || 0),
        discountName: order.discount_adjustment_name || order.marketing_deal_name || "",
        serviceCharge: Number(order.service_charge || 0),
        chargeName: order.charge_adjustment_name || "",
        gst: Number(order.gst || 0),
        total: Number(order.total || 0),
        paymentMethod: order.payment_method || "-"
    };

    await window.printThermalBill({ manual: true });
}

// ==========================================
// TABLE MANAGEMENT
// ==========================================

async function loadTables() {

    try {

        restaurantTables =
            await api("/tables");


        window.restaurantTables =
            restaurantTables;


        const orderSelect =
            document.getElementById(
                "tableNumber"
            );


        const reservationSelect =
            document.getElementById(
                "reservationTable"
            );


        [
            orderSelect,
            reservationSelect
        ]
        .forEach(function(select) {
            if (!select || String(select.tagName).toUpperCase() !== "SELECT") return;
            const selected = select.value;
            select.innerHTML = `<option value="">Select Table</option>`;
            restaurantTables.filter(table => table.status === "Available").forEach(function(table) {
                const option = document.createElement("option");
                option.value = table.table_number;
                option.textContent = `${table.table_number} - ${table.capacity} seats`;
                select.appendChild(option);
            });
            if ([...select.options].some(option => option.value === selected)) {
                select.value = selected;
            }
        });

        const grid =
            document.getElementById(
                "tablesGrid"
            );


        if (grid) {

            grid.innerHTML =
                restaurantTables
                    .map(function(table) {

                        return `

                            <article class="table-card">
                                <div class="table-card-header">
                                    <div class="table-card-heading">
                                        <span class="table-card-kicker">TABLE</span>
                                        <h3>${esc(table.table_number)}</h3>
                                    </div>
                                    <span class="table-status ${String(table.status || "Available").toLowerCase()}">
                                        ${esc(table.status || "Available")}
                                    </span>
                                </div>

                                <div class="table-card-visual">
                                    <div class="table-icon" aria-hidden="true">
                                        <svg viewBox="0 0 32 32" role="img" focusable="false">
                                            <path d="M10 4.75v8.5c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2v-8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                            <path d="M8 14.25h16v4.5c0 1.1-.9 2-2 2H10c-1.1 0-2-.9-2-2v-4.5Z" fill="#e8eef7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                                            <path d="M10 20.75v6m12-6v6M7.5 11.5v3m17-3v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                        </svg>
                                    </div>
                                    <div class="table-capacity">
                                        <span class="table-capacity-label">SEATING</span>
                                        <strong>${esc(table.capacity)}</strong>
                                        <span>seats</span>
                                    </div>
                                </div>

                                <div class="table-card-actions">
                                    <button type="button" class="table-action-btn table-edit-btn"
                                        onclick="openEditTableModal(${table.id})">
                                        Edit table
                                    </button>
                                    <button type="button" class="table-action-btn table-delete-btn"
                                        aria-label="Delete table ${esc(table.table_number)}"
                                        onclick="deleteTable(${Number(table.id)})">
                                        Delete
                                    </button>
                                </div>
                            </article>

                        `;

                    })
                    .join("") ||
                "<p>No tables found.</p>";

        }



        const billingGrid = document.getElementById("billingTablesGrid");
        if (billingGrid) {
            billingGrid.innerHTML = restaurantTables.map(function(table) {
                const status = String(table.status || "Available").toLowerCase();
                const active = document.getElementById("tableNumber")?.value === table.table_number;
                const label = status === "occupied" ? "Occupied" : status === "reserved" ? "Reserved" : "Available";
                return `
                    <button type="button"
                        class="billing-table-card ${status} ${active ? "selected" : ""}"
                        onclick="selectBillingTable(${JSON.stringify(String(table.table_number)).replace(/"/g, '&quot;')}, ${JSON.stringify(String(table.status)).replace(/"/g, '&quot;')})">
                        <span class="billing-table-number">${esc(table.table_number)}</span>
                        <span class="billing-table-seat">${esc(table.capacity)} seats</span>
                        <span class="billing-table-status">${label}</span>
                    </button>`;
            }).join("") || `<div class="billing-table-empty">No tables configured.</div>`;
        }

        setText(
            "availableTablesCount",
            restaurantTables.filter(
                function(table) {
                    return table.status === "Available";
                }
            ).length
        );


        setText(
            "occupiedTablesCount",
            restaurantTables.filter(
                function(table) {
                    return table.status === "Occupied";
                }
            ).length
        );


        setText(
            "reservedTablesCount",
            restaurantTables.filter(
                function(table) {
                    return table.status === "Reserved";
                }
            ).length
        );


        setText(
            "totalTablesCount",
            restaurantTables.length
        );


    } catch (error) {

        console.error(
            "Tables failed:",
            error
        );

    }

}


async function changeTableStatus(id, status) {

    try {

        await api(
            `/tables/${id}/status`,
            {

                method: "PUT",

                body: JSON.stringify({
                    status
                })

            }
        );


        await loadTables();

        await loadReservations();


    } catch (error) {

        alert(error.message);

    }

}


function openAddTableModal() {

    const number =
        document.getElementById(
            "newTableNumber"
        );


    const capacity =
        document.getElementById(
            "newTableCapacity"
        );


    if (number) {

        number.value = "";

    }


    if (capacity) {

        capacity.value = "4";

    }


    const modal =
        document.getElementById(
            "addTableModal"
        );


    if (modal) {

        modal.style.display =
            "flex";

    }

}


function closeAddTableModal() {

    const modal =
        document.getElementById(
            "addTableModal"
        );


    if (modal) {

        modal.style.display =
            "none";

    }

}


async function addNewTable() {

    const tableNumber =
        document.getElementById(
            "newTableNumber"
        )?.value.trim();


    const capacity =
        Number(
            document.getElementById(
                "newTableCapacity"
            )?.value
        );


    if (
        !tableNumber ||
        !Number.isFinite(capacity) ||
        capacity < 1
    ) {

        return alert(
            "Enter a valid table number and capacity."
        );

    }


    try {

        await api(
            "/tables",
            {

                method: "POST",

                body: JSON.stringify({

                    tableNumber,
                    capacity

                })

            }
        );


        closeAddTableModal();

        await loadTables();


        alert(
            "Table added successfully! ✅"
        );


    } catch (error) {

        alert(error.message);

    }

}


function openEditTableModal(id) {

    const table =
        restaurantTables.find(
            function(item) {

                return item.id == id;

            }
        );


    if (!table) {

        return alert(
            "Table not found."
        );

    }


    editingTableId =
        table.id;


    document.getElementById(
        "editTableNumber"
    ).value =
        table.table_number;


    document.getElementById(
        "editTableCapacity"
    ).value =
        table.capacity;


    document.getElementById(
        "editTableModal"
    ).style.display =
        "flex";

}


function closeEditTableModal() {

    document.getElementById(
        "editTableModal"
    ).style.display =
        "none";


    editingTableId =
        null;

}


async function updateTable() {

    if (!editingTableId) {

        return;

    }


    const tableNumber =
        document.getElementById(
            "editTableNumber"
        ).value.trim();


    const capacity =
        Number(
            document.getElementById(
                "editTableCapacity"
            ).value
        );


    if (
        !tableNumber ||
        !Number.isFinite(capacity) ||
        capacity < 1
    ) {

        return alert(
            "Enter valid table details."
        );

    }


    try {

        await api(
            `/tables/${editingTableId}`,
            {

                method: "PUT",

                body: JSON.stringify({

                    tableNumber,
                    capacity

                })

            }
        );


        closeEditTableModal();

        await loadTables();


        alert(
            "Table updated successfully! ✅"
        );


    } catch (error) {

        alert(error.message);

    }

}


async function deleteTable(id) {

    if (
        !confirm(
            `Delete this table?\n\nThis cannot be undone.`
        )
    ) {

        return;

    }


    try {

        await api(
            `/tables/${id}`,
            {
                method: "DELETE"
            }
        );


        await loadTables();


        alert(
            `Table deleted successfully! 🗑️`
        );


    } catch (error) {

        alert(error.message);

    }

}


// ==========================================
// RESERVATIONS
// ==========================================

let reservationAutoRefreshBusy = false;
function startReservationAutoRefresh(){
    if(reservationAutoRefreshTimer)clearInterval(reservationAutoRefreshTimer);
    if(!currentUser)return;
    const syncDueReservations=async()=>{
        if(!currentUser||document.visibilityState!=="visible"||reservationAutoRefreshBusy)return;
        reservationAutoRefreshBusy=true;
        try{
            await loadTables();
            if(document.getElementById("reservations")?.classList.contains("active-page"))await loadReservations();
        }catch(error){console.warn("Reservation schedule sync failed:",error.message);}
        finally{reservationAutoRefreshBusy=false;}
    };
    syncDueReservations();
    reservationAutoRefreshTimer=setInterval(syncDueReservations,30000);
    if(!window.__reservationAutoRefreshVisibilityListener){
        document.addEventListener("visibilitychange",()=>{
            if(document.visibilityState==="visible"&&currentUser)syncDueReservations();
        });
        window.__reservationAutoRefreshVisibilityListener=true;
    }
}
function stopReservationAutoRefresh(){
    if(reservationAutoRefreshTimer){clearInterval(reservationAutoRefreshTimer);reservationAutoRefreshTimer=null;}
    reservationAutoRefreshBusy=false;
}

async function loadReservations() {

    try {

        currentReservations =
            await api("/reservations");


        const tbody =
            document.getElementById(
                "reservationsTableBody"
            );


        if (!tbody) {

            return;

        }


        tbody.innerHTML = "";


        currentReservations.forEach(
            function(reservation) {

                const active = ["Reserved", "Confirmed", "Arrived"].includes(reservation.status);


                const tr =
                    document.createElement(
                        "tr"
                    );


                tr.innerHTML = `

                    <td>
                        ${reservation.id}
                    </td>

                    <td>
                        ${esc(
                            reservation.customer_name
                        )}
                    </td>

                    <td>
                        ${esc(
                            reservation.phone
                        )}
                    </td>

                    <td>
                        ${esc(
                            reservation.reservation_date
                        )}
                    </td>

                    <td>
                        ${esc(
                            reservation.reservation_time
                        )}
                    </td>

                    <td>
                        ${reservation.guests}
                    </td>

                    <td>
                        ${esc(
                            reservation.table_number || "-"
                        )}
                    </td>

                    <td>
                        ${esc(
                            reservation.status
                        )}
                    </td>

                    <td>

                        ${active ? `
                            ${reservation.status === "Reserved" ? `<button type="button" onclick="updateReservationStatus(${reservation.id}, 'Confirmed')">Confirm</button>` : ""}
                            ${["Reserved", "Confirmed"].includes(reservation.status) ? `<button type="button" onclick="updateReservationStatus(${reservation.id}, 'Arrived')">Arrived</button>` : ""}
                            ${reservation.status === "Arrived" ? `<button type="button" onclick="updateReservationStatus(${reservation.id}, 'Completed')">Complete</button>` : `<button type="button" onclick="updateReservationStatus(${reservation.id}, 'Cancelled')">Cancel</button>`}
                        ` : `<button type="button" onclick="updateReservationStatus(${reservation.id}, 'Reserved')">Reserve</button>`}

                    </td>

                `;


                tbody.appendChild(tr);

            }
        );


    } catch (error) {

        console.error(
            "Reservations failed:",
            error
        );

    }

}


function openReservationForm() {

    const form =
        document.getElementById(
            "reservationForm"
        );


    if (form) form.hidden = !form.hidden;


    loadTables();

}


async function addReservation() {

    const customerName =
        document.getElementById(
            "reservationCustomerName"
        ).value.trim();


    const phone =
        document.getElementById(
            "reservationPhone"
        ).value.trim();


    const reservationDate =
        document.getElementById(
            "reservationDate"
        ).value;


    const reservationTime =
        document.getElementById(
            "reservationTime"
        ).value;


    const guests =
        Number(
            document.getElementById(
                "reservationGuests"
            ).value
        );


    const tableNumber =
        document.getElementById(
            "reservationTable"
        ).value;


    const notes =
        document.getElementById(
            "reservationNotes"
        ).value.trim();


    if (
        !customerName ||
        !phone ||
        !reservationDate ||
        !reservationTime ||
        !guests
    ) {

        return alert(
            "Fill all required reservation fields."
        );

    }


    try {

        await api(
            "/reservations",
            {

                method: "POST",

                body: JSON.stringify({

                    customerName,
                    phone,
                    reservationDate,
                    reservationTime,
                    guests,
                    tableNumber,
                    status: "Reserved",
                    notes

                })

            }
        );


        showProfileToast("Reservation created successfully.", true);


        document.getElementById("reservationForm").hidden = true;


        [
            "reservationCustomerName",
            "reservationPhone",
            "reservationDate",
            "reservationTime",
            "reservationGuests",
            "reservationNotes"
        ]
        .forEach(function(id) {

            const element =
                document.getElementById(id);

            if (element) {

                element.value = "";

            }

        });


        document.getElementById(
            "reservationTable"
        ).value = "";


        await loadTables();

        await loadReservations();


    } catch (error) {

        alert(error.message);

    }

}


async function updateReservationStatus(
    id,
    status
) {

    try {

        await api(
            `/reservations/${id}/status`,
            {

                method: "PUT",

                body: JSON.stringify({
                    status
                })

            }
        );


        await loadReservations();

        await loadTables();


    } catch (error) {

        alert(error.message);

    }

}


// ==========================================
// KOT GROUPS
// ==========================================

let kotGroups=[];
let kotGroupSelectedTargets={categories:new Set(),items:new Set()};
let kotGroupWorkingTargets=null;
let kotGroupTargetType="categories";

async function loadKOTGroups(){
    try{
        kotGroups=await api("/kot-groups");
        const c=document.getElementById("kotGroupsContainer");
        setText("kotGroupCount",kotGroups.length);
        if(!c)return;
        if(!kotGroups.length){c.innerHTML='<div class="kot-groups-empty"><strong>No KOT groups yet</strong><span>Create a group to route menu categories or items to a printer.</span></div>';return;}
        c.innerHTML=kotGroups.map(g=>{
            const categoryCount=Array.isArray(g.category_names)?g.category_names.length:0;
            const itemCount=Array.isArray(g.item_ids)?g.item_ids.length:0;
            return `<article class="kot-group-admin-card"><div class="kot-group-card-heading"><span class="kot-group-card-icon">🧩</span><div><h3>${esc(g.name)}</h3><p>${esc(g.description||g.station||"Kitchen station")}</p></div><span class="access-status ${g.active?'active':'inactive'}">${g.active?'Active':'Inactive'}</span></div><div class="kot-group-card-meta"><span><small>STATION</small><strong>${esc(g.station||"Kitchen")}</strong></span><span><small>ROUTES</small><strong>${categoryCount} categories · ${itemCount} items</strong></span></div><div class="kot-group-card-actions"><button type="button" class="table-action-btn" onclick="editKOTGroup(${Number(g.id)})">Edit group</button><button type="button" class="cancel-btn" onclick="deleteKOTGroup(${Number(g.id)})">Delete</button></div></article>`;
        }).join("");
    }catch(e){const c=document.getElementById("kotGroupsContainer");if(c)c.innerHTML=`<div class="kot-groups-empty">Failed to load KOT groups: ${esc(e.message)}</div>`;}
}

function openKOTGroupModal(group=null){
    document.getElementById("kotGroupModalTitle").textContent=group?"Edit KOT Group":"Add KOT Group";
    document.getElementById("kotGroupId").value=group?.id||"";
    document.getElementById("kotGroupName").value=group?.name||"";
    document.getElementById("kotGroupDescription").value=group?.description||"";
    document.getElementById("kotGroupStation").value=group?.station||"Kitchen";
    document.getElementById("kotGroupSort").value=group?.sort_order??0;
    document.getElementById("kotGroupActive").checked=group?.active!==false;
    showKOTGroupsView("editor");
    populateKOTGroupTargets(group||{}).catch(error=>alert("Unable to load printer and routing choices: "+error.message));
}
function closeKOTGroupModal(){document.getElementById("kotGroupTargetPickerModal")?.style.setProperty("display","none");showKOTGroupsView("groups");}
function editKOTGroup(id){const g=(kotGroups||[]).find(x=>Number(x.id)===Number(id));if(g)openKOTGroupModal(g);}
async function saveKOTGroup(){
    const id=Number(document.getElementById("kotGroupId").value||0);
    const body={name:document.getElementById("kotGroupName").value.trim(),description:document.getElementById("kotGroupDescription").value.trim(),station:document.getElementById("kotGroupStation").value,sortOrder:Number(document.getElementById("kotGroupSort").value||0),active:document.getElementById("kotGroupActive").checked,printerId:Number(document.getElementById("kotGroupPrinter").value||0)||null,categoryNames:[...kotGroupSelectedTargets.categories],itemIds:[...kotGroupSelectedTargets.items].map(Number)};
    if(!body.name)return alert("Enter a KOT group name.");
    try{await api(id?`/kot-groups/${id}`:"/kot-groups",{method:id?"PUT":"POST",body:JSON.stringify(body)});closeKOTGroupModal();await loadKOTGroups();alert(id?"KOT group updated! ✅":"KOT group created! ✅");}catch(e){alert(e.message);}
}
async function deleteKOTGroup(id){
    if(!confirm("Delete this KOT group? Existing KOT history will keep working; menu items will become unassigned."))return;
    try{await api(`/kot-groups/${id}`,{method:"DELETE"});await loadKOTGroups();await loadMenuManagement();alert("KOT group deleted. ✅");}catch(e){alert(e.message);}
}

async function populateKOTGroupTargets(group={}){
    const printerSelect=document.getElementById("kotGroupPrinter");
    const [printers,menu]=await Promise.all([
        api("/kot-groups/printers").catch(()=>[]),
        currentMenu?.length?Promise.resolve(currentMenu):api("/menu").catch(()=>[])
    ]);
    currentMenu=menu||[];
    if(printerSelect)printerSelect.innerHTML='<option value="">Use the regular print dialog</option>'+(printers||[]).map(p=>`<option value="${Number(p.id)}">${esc(p.name)} · ${esc(p.connection_type||"local")}</option>`).join("");
    if(printerSelect)printerSelect.value=group.printer_id?String(group.printer_id):"";
    try{if(!menuCategories.length)await loadMenuCategories();}catch(_){/* current menu still supplies category names */}
    kotGroupSelectedTargets={
        categories:new Set((Array.isArray(group.category_names)?group.category_names:[]).map(String)),
        items:new Set((Array.isArray(group.item_ids)?group.item_ids:[]).map(String))
    };
    renderKOTGroupTargetSummaries();
}

function getKOTGroupTargetOptions(type){
    if(type==="categories"){
        return [...new Set([...(menuCategories||[]).map(category=>String(category.name||"").trim()),...(currentMenu||[]).map(item=>String(item.category||"").trim())].filter(Boolean))]
            .sort((a,b)=>a.localeCompare(b)).map(value=>({value,label:value,detail:"Category"}));
    }
    return (currentMenu||[]).map(item=>({value:String(item.id),label:item.name||"Menu item",detail:item.category||"Uncategorized"}));
}

function renderKOTGroupTargetSummaries(){
    const categories=[...kotGroupSelectedTargets.categories];
    const items=[...kotGroupSelectedTargets.items];
    const categorySummary=document.getElementById("kotGroupCategoriesSummary");
    const itemSummary=document.getElementById("kotGroupItemsSummary");
    if(categorySummary)categorySummary.textContent=categories.length?`${categories.length} categor${categories.length===1?"y":"ies"} selected`:"No categories selected";
    if(itemSummary)itemSummary.textContent=items.length?`${items.length} item${items.length===1?"":"s"} selected`:"No items selected";
    const categoryChips=document.getElementById("kotGroupCategoriesChips");
    const itemChips=document.getElementById("kotGroupItemsChips");
    if(categoryChips)categoryChips.innerHTML=categories.slice(0,4).map(value=>`<span>${esc(value)}</span>`).join("")+(categories.length>4?`<span class="kot-target-more">+${categories.length-4} more</span>`:"");
    if(itemChips)itemChips.innerHTML=items.slice(0,4).map(id=>{const item=currentMenu.find(entry=>String(entry.id)===String(id));return `<span>${esc(item?.name||`Item ${id}`)}</span>`;}).join("")+(items.length>4?`<span class="kot-target-more">+${items.length-4} more</span>`:"");
}

function openKOTGroupTargetPicker(type){
    kotGroupTargetType=type==="items"?"items":"categories";
    kotGroupWorkingTargets=new Set(kotGroupSelectedTargets[kotGroupTargetType]);
    const title=document.getElementById("kotGroupTargetPickerTitle");
    const search=document.getElementById("kotGroupTargetSearch");
    if(title)title.textContent=kotGroupTargetType==="categories"?"Select categories":"Select menu items";
    if(search){search.value="";search.placeholder=kotGroupTargetType==="categories"?"Search categories…":"Search menu items…";}
    renderKOTGroupTargetOptions();
    document.getElementById("kotGroupTargetPickerModal").style.display="flex";
}

function renderKOTGroupTargetOptions(){
    const box=document.getElementById("kotGroupTargetOptions");
    if(!box)return;
    const term=String(document.getElementById("kotGroupTargetSearch")?.value||"").trim().toLowerCase();
    const options=getKOTGroupTargetOptions(kotGroupTargetType).filter(option=>`${option.label} ${option.detail}`.toLowerCase().includes(term));
    box.innerHTML=options.length?options.map(option=>`<label class="kot-target-option"><input type="checkbox" data-target-value="${esc(option.value)}" ${kotGroupWorkingTargets?.has(String(option.value))?"checked":""} onchange="updateKOTGroupTargetSelection(this)"><span class="kot-target-option-copy"><strong>${esc(option.label)}</strong><small>${esc(option.detail)}</small></span></label>`).join(""):'<div class="kot-target-empty">No matching options.</div>';
    const selectAll=document.getElementById("kotGroupTargetSelectAll");
    const visible=[...box.querySelectorAll("input[type=checkbox]")];
    if(selectAll){selectAll.checked=visible.length>0&&visible.every(input=>input.checked);selectAll.indeterminate=visible.some(input=>input.checked)&&!selectAll.checked;selectAll.disabled=!visible.length;}
}

function updateKOTGroupTargetSelection(input){
    if(!kotGroupWorkingTargets||!input)return;
    const value=String(input.dataset.targetValue||"");
    if(input.checked)kotGroupWorkingTargets.add(value);else kotGroupWorkingTargets.delete(value);
    renderKOTGroupTargetOptions();
}

function toggleAllKOTGroupTargets(checked){
    if(!kotGroupWorkingTargets)return;
    const term=String(document.getElementById("kotGroupTargetSearch")?.value||"").trim().toLowerCase();
    const visible=getKOTGroupTargetOptions(kotGroupTargetType).filter(option=>`${option.label} ${option.detail}`.toLowerCase().includes(term));
    visible.forEach(option=>checked?kotGroupWorkingTargets.add(String(option.value)):kotGroupWorkingTargets.delete(String(option.value)));
    renderKOTGroupTargetOptions();
}

function closeKOTGroupTargetPicker(){document.getElementById("kotGroupTargetPickerModal")?.style.setProperty("display","none");kotGroupWorkingTargets=null;}

function confirmKOTGroupTargetPicker(){
    if(kotGroupWorkingTargets)kotGroupSelectedTargets[kotGroupTargetType]=new Set(kotGroupWorkingTargets);
    renderKOTGroupTargetSummaries();
    closeKOTGroupTargetPicker();
}

// ==========================================
// KITCHEN / KOT
// ==========================================

let kotState={tab:"pending",range:"today",from:"",to:"",items:[]};
let kotAlertTimer=null;
let kotAlertInitialized=false;
let knownPendingKOTIds=new Set();
let kotAlertAudioContext=null;
let pendingKOTAlertSounds=0;
let pendingQrAlertSounds=0;
let pendingQrServiceAlertSounds=0;
let pendingQrServiceVoiceRequests=[];

function setKOTTab(tab){
    kotState.tab=tab;
    document.querySelectorAll(".kot-tab").forEach(b=>b.classList.remove("active"));
    const tabIds={pending:"kotTabPending",ready:"kotTabReady",completed:"kotTabCompleted",cancelled:"kotTabCancelled"};
    document.getElementById(tabIds[tab]||tabIds.pending)?.classList.add("active");
    renderKOT();
}

function toggleKOTCustomDates(){
    const custom=document.getElementById("kotDateFilter")?.value==="custom";
    ["kotFromDate","kotToDate"].forEach(id=>{
        const el=document.getElementById(id);
        if(el)el.style.display=custom?"inline-block":"none";
    });
}

async function applyKOTFilter(){
    kotState.range=document.getElementById("kotDateFilter")?.value||"today";
    kotState.from=document.getElementById("kotFromDate")?.value||"";
    kotState.to=document.getElementById("kotToDate")?.value||"";
    if(kotState.range==="custom"&&(!kotState.from||!kotState.to))return alert("Select both From and To dates.");
    if(kotState.range==="custom"&&kotState.from>kotState.to)return alert("From date cannot be after To date.");
    await loadKOT(false);
}

function canKitchenReceiveKOTAlerts(){
    return Boolean(appSettings.kotEnabled !== false && currentUser && hasPermission("kitchen","view"));
}

function ensureKOTAlertAudio(){
    try{
        if(!kotAlertAudioContext) kotAlertAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }catch(e){ console.warn("KOT alert audio unavailable:",e.message); }
    return kotAlertAudioContext;
}

function primeKOTAlertAudio(){
    // Resume only from a real login/pointer/key gesture, then replay alerts queued while audio was locked.
    flushPendingQrServiceVoices();
    const context=ensureKOTAlertAudio();
    if(!context)return;
    const flush=()=>{
        if(context.state!=="running")return;
        const qrCount=Math.min(3,pendingQrAlertSounds),kotCount=Math.min(3,pendingKOTAlertSounds),serviceCount=Math.min(3,pendingQrServiceAlertSounds),serviceVoices=pendingQrServiceVoiceRequests.splice(0);
        pendingQrAlertSounds=0;pendingKOTAlertSounds=0;pendingQrServiceAlertSounds=0;
        for(let i=0;i<qrCount;i++)emitPOSQrOrderAlertSound();
        for(let i=0;i<kotCount;i++)emitKOTAlertSound();
        for(let i=0;i<serviceCount;i++)emitPOSNotificationBuzzer();
        serviceVoices.forEach(queueQrTableServiceVoice);
    };
    if(context.state==="running"){flush();return;}
    context.resume().then(flush).catch(()=>{});
}

function emitPOSNotificationBuzzer(){
    try{
        const context=ensureKOTAlertAudio();
        if(!context||context.state!=="running")return;
        const now=context.currentTime;
        [
            {offset:0,frequency:220,duration:0.17},
            {offset:0.23,frequency:185,duration:0.18},
            {offset:0.48,frequency:220,duration:0.17}
        ].forEach(pulse=>{
            const osc=context.createOscillator();
            const gain=context.createGain();
            const at=now+pulse.offset;
            osc.type="square";
            osc.frequency.setValueAtTime(pulse.frequency,at);
            osc.frequency.exponentialRampToValueAtTime(pulse.frequency*0.78,at+pulse.duration);
            gain.gain.setValueAtTime(0.0001,at);
            gain.gain.exponentialRampToValueAtTime(0.12,at+0.012);
            gain.gain.setValueAtTime(0.12,at+pulse.duration*0.68);
            gain.gain.exponentialRampToValueAtTime(0.0001,at+pulse.duration);
            osc.connect(gain);
            gain.connect(context.destination);
            osc.start(at);
            osc.stop(at+pulse.duration+0.01);
        });
    }catch(e){ console.warn("POS buzzer alert failed:",e.message); }
}

function emitKOTAlertSound(){
    emitPOSNotificationBuzzer();
}

function playKOTAlertSound(){
    if(!canKitchenReceiveKOTAlerts()||appSettings.enableKOTSound===false)return;
    const context=ensureKOTAlertAudio();
    if(!context||context.state!=="running"){
        pendingKOTAlertSounds=Math.min(3,pendingKOTAlertSounds+1);
        return;
    }
    emitKOTAlertSound();
}

function showKOTArrivalToast(count){
    if(!appSettings.enableNotifications || !count) return;
    let toast=document.getElementById("kotArrivalToast");
    if(!toast){
        toast=document.createElement("div");
        toast.id="kotArrivalToast";
        toast.className="kot-arrival-toast";
        document.body.appendChild(toast);
    }
    toast.innerHTML=`🔔 <strong>${count}</strong> new KOT ${count===1?"has":"have"} arrived`;
    toast.classList.add("show");
    clearTimeout(window.__kotToastTimer);
    window.__kotToastTimer=setTimeout(()=>toast.classList.remove("show"),4500);
}

async function autoPrintQrFollowupTicket(ticket){
    const rows=await api(`/kot?orderId=${encodeURIComponent(ticket.orderId)}&print=1`);
    const batch=(rows||[]).filter(item=>Number(item.ticket_number||1)===Number(ticket.ticketNumber));
    // Background polls cannot open browser print dialogs or Bluetooth pickers.
    // Auto-send only when every station has a configured local/network printer.
    if(!batch.length||batch.some(item=>!Number(item.printer_id)||!["local","network"].includes(String(item.printer_connection_type||""))))return;
    await printKOT(ticket.orderId,undefined,ticket.ticketNumber);
}

function inspectNewKOTAlerts(items){
    if(!canKitchenReceiveKOTAlerts()) return;
    // The QR order poll announces first orders. This poll also announces later
    // ticket batches added to an already accepted QR order.
    const pendingIds=new Set((items||[]).filter(i=>["Pending","Preparing"].includes(i.status)&&(!isQrTrackedOrder(i)||Number(i.ticket_number||1)>1)).map(i=>Number(i.id)));
    if(!kotAlertInitialized){
        knownPendingKOTIds=pendingIds;
        kotAlertInitialized=true;
        return;
    }
    const newlyPendingIds=[...pendingIds].filter(id=>!knownPendingKOTIds.has(id));
    const newCount=newlyPendingIds.length;
    knownPendingKOTIds=pendingIds;
    if(newCount>0){
        playKOTAlertSound();
        showKOTArrivalToast(newCount);
        const newIds=new Set(newlyPendingIds);
        const newQrBatches=new Map((items||[]).filter(item=>newIds.has(Number(item.id))&&isQrTrackedOrder(item)&&Number(item.ticket_number||1)>1).map(item=>[`${item.order_id}:${item.ticket_number}`,{orderId:Number(item.order_id),ticketNumber:Number(item.ticket_number)}]));
        if(hasPermission("kitchen","print"))newQrBatches.forEach(ticket=>Promise.resolve().then(()=>autoPrintQrFollowupTicket(ticket)).catch(error=>console.warn("New QR kitchen ticket print failed:",error)));
        if(newQrBatches.size){
            if(document.getElementById("orders")?.classList.contains("active-page"))Promise.resolve().then(()=>updateOrdersTable(true,false)).catch(()=>{});
            if([...newQrBatches.values()].some(ticket=>ticket.orderId===Number(window.selectedOrderId)))Promise.resolve().then(()=>viewOrder(Number(window.selectedOrderId))).catch(()=>{});
        }
    }
}

async function pollKOTAlerts(){
    if(appSettings.kotEnabled === false || !currentUser || !hasPermission("kitchen","view")) return;
    try{
        const items=await api("/kot?range=today");
        inspectNewKOTAlerts(items);
        if(document.getElementById("kitchen")?.classList.contains("active-page") && kotState.range==="today"){kotState.items=items;renderKOT();}
    }catch(e){
        console.warn("KOT alert polling failed:",e.message);
    }
}

function startKOTAlertPolling(){
    stopKOTAlertPolling();
    if(!currentUser || !hasPermission("kitchen","view")) return;
    const interval=Math.min(60000,Math.max(3000,(Number(appSettings.kotAlertInterval)||5)*1000));
    // Seed from today's KOTs, then poll only for new arrivals so custom UI filters do not disable alerts.
    pollKOTAlerts();
    kotAlertTimer=setInterval(pollKOTAlerts,interval);
}

function stopKOTAlertPolling(){
    if(kotAlertTimer){clearInterval(kotAlertTimer);kotAlertTimer=null;}
}

function formatKOTAge(value, now = Date.now()) {
    const time = new Date(value || now).getTime();
    if (!Number.isFinite(time)) return "Time unavailable";
    const seconds = Math.max(0, Math.floor((now - time) / 1000));
    if (seconds < 5) return "Just now";
    if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderKOT(){
    const items=Array.isArray(kotState.items)?kotState.items:[],groups={};
    items.forEach(item=>{
        const ticketNumber=Number(item.ticket_number||1),key=`${item.order_id}:${ticketNumber}`;
        if(!groups[key])groups[key]={orderId:item.order_id,orderNumber:item.order_number,orderType:item.order_type,tableNumber:item.table_number,pax:item.pax,orderStatus:item.order_status,ticketNumber,status:item.status,createdAt:item.created_at,orderNote:item.order_notes,items:[]};
        groups[key].items.push(item);
        const ss=groups[key].items.map(i=>i.status);
        groups[key].status=String(groups[key].orderStatus||"").toLowerCase()==="cancelled"?"Cancelled":ss.every(s=>s==="Completed")?"Completed":ss.some(s=>s==="Ready")?"Ready":ss.some(s=>s==="Preparing")?"Preparing":"Pending";
    });
    const all=Object.values(groups),pending=all.filter(o=>o.status==="Pending"||o.status==="Preparing"),ready=all.filter(o=>o.status==="Ready"),completed=all.filter(o=>o.status==="Completed"),cancelled=all.filter(o=>o.status==="Cancelled");
    setText("kotCountPending",pending.length);setText("kotCountReady",ready.length);setText("kotCountCompleted",completed.length);setText("kotCountCancelled",cancelled.length);
    const selected=kotState.tab==="pending"?pending:kotState.tab==="ready"?ready:kotState.tab==="cancelled"?cancelled:completed,container=document.getElementById("kotContainer");
    if(!container)return;
    container.innerHTML="";
    if(!selected.length){container.innerHTML=`<div class="dashboard-box"><p>No KOTs for this tab/date range.</p></div>`;return;}
    selected.forEach(order=>{
        let next=order.status==="Pending"?"Preparing":order.status==="Preparing"?"Ready":order.status==="Ready"?"Completed":null;
        const card=document.createElement("div");
        card.className="kot-card"+(order.status==="Cancelled"?" kot-card-cancelled":"");
        const byGroup={};
        (order.items||[]).forEach(item=>{const key=item.kot_group_id?String(item.kot_group_id):"none";if(!byGroup[key])byGroup[key]={name:item.kot_group_name||"Unassigned",station:item.kot_group_station||"Kitchen",items:[]};byGroup[key].items.push(item);});
        const groupedHtml=Object.values(byGroup).map(g=>`<div class="kot-group-block"><div class="kot-group-heading"><strong>${esc(g.name)}</strong><span>${esc(g.station)}</span></div>${g.items.map(item=>{const options=formatItemOptionNames(item.options),quantity=Number(item.quantity||0),cancelled=Number(item.cancelled_quantity||0),fullyCancelled=quantity<=0&&cancelled>0;return `<div class="kot-item ${fullyCancelled?"kot-item-cancelled":""}"><span class="kot-item-copy">${fullyCancelled?`<del>${esc(item.item_name)}</del>`:esc(item.item_name)}${options?`<small class="kot-item-options">${esc(options)}</small>`:""}</span><strong>${cancelled?`<del>(${cancelled})</del> `:""}${quantity>0?`× ${quantity}`:cancelled?"0":"× 0"}</strong></div>`;}).join("")}</div>`).join("");
        const actions=order.status==="Cancelled"?'<span class="kot-cancelled-label">✕ Cancelled order · items are crossed out</span>':(appSettings.kotEnabled===false)?'<span class="access-muted">KOT workflow disabled in Settings</span>':(next?`<button class="big-btn" onclick="updateKOTOrder(${order.orderId}, '${next}', ${order.ticketNumber})">${next==="Preparing"?"👨‍🍳 Start Preparing":next==="Ready"?"✅ Mark Ready":"✅ Complete"}</button>`:`<span>✅ Completed</span>`);
        const receivedAt=order.createdAt?formatPOSTime(order.createdAt):"";
        card.innerHTML=`<div class="kot-header"><strong>${esc(order.orderNumber)} · Ticket #${order.ticketNumber}</strong><span>${esc(order.orderType)}</span></div><div class="kot-table">Table: ${esc(order.tableNumber||"-")}${Number(order.pax)>0?` · ${Number(order.pax)} PAX`:""}</div><div class="kot-age-label" title="Ticket arrival time">Received ${esc(formatKOTAge(order.createdAt))}${receivedAt?` · ${esc(receivedAt)}`:""}</div><div class="kot-items">${groupedHtml}</div><div class="kot-status">Status: <strong>${esc(order.status)}</strong></div><div class="kot-actions">${actions}${appSettings.kotEnabled!==false?`<button class="big-btn" onclick="printKOT(${order.orderId},undefined,${order.ticketNumber})">🖨️ Print Ticket #${order.ticketNumber}</button>`:""}</div>`;
        const orderNote=String(order.orderNote||"").trim();
        if(orderNote){const note=document.createElement("div");note.className="kot-order-note";note.innerHTML="<strong>Order note:</strong> "+esc(orderNote);card.insertBefore(note,card.querySelector(".kot-items"));}
        container.appendChild(card);
    });
}

async function loadKOT(isPoll=false){
    if(appSettings.kotEnabled === false) return;
    try{
        const p=new URLSearchParams();
        p.set("range",kotState.range||"today");
        if(kotState.range==="custom"){p.set("from",kotState.from);p.set("to",kotState.to);}
        const items=await api("/kot?"+p.toString());
        if(isPoll) inspectNewKOTAlerts(items);
        kotState.items=items;
        renderKOT();
    }catch(e){
        console.error("Load KOT failed:",e);
        const c=document.getElementById("kotContainer");
        if(c)c.innerHTML=`<p>Failed to load KOT: ${esc(e.message)}</p>`;
    }
}

async function updateKOTOrder(orderId,status,ticketNumber){
    if(appSettings.kotEnabled===false)return alert("KOT / Kitchen workflow is disabled in Settings.");
    try{
        const orderItems=(kotState.items||[]).filter(item=>Number(item.order_id)===Number(orderId)&&(ticketNumber===undefined||Number(item.ticket_number||1)===Number(ticketNumber))&&Number(item.quantity||0)>0&&String(item.status||"").toLowerCase()!=="completed");
        if(!orderItems.length)return alert("KOT not found for the selected date/filter.");
        for(const item of orderItems){
            await api(`/kot/${item.id}`,{method:"PUT",body:JSON.stringify({status})});
        }
        await loadKOT(false);
        await updateOrdersTable();
        await loadTables();
        await updateDashboard();
    }catch(error){
        console.error("KOT update failed:",error);
        alert(error.message);
    }
}

// ==========================================
// PRINT KOT
// ==========================================

async function printOpenOrder(orderId){
    if(!hasPermission("orders","print_open"))return alert("You do not have permission to print open orders.");
    try{
        const data=await api("/orders/"+Number(orderId));
        const paymentSummary=data.paymentSummary||null;
        const order=data.order||{};
        if(String(order.status||"").toLowerCase()==="completed")return alert("This order is already closed. Use the closed bill print action.");
        const bill={orderId:Number(orderId),isOpenOrder:true,orderNumber:order.order_number,invoiceNumber:"",date:order.created_at?formatPOSDateTime(order.created_at):formatPOSDateTime(),orderType:order.order_type,tableNumber:order.table_number,subtotal:Number(order.subtotal||0),discount:Number(order.discount||0),discountName:order.discount_adjustment_name||order.marketing_deal_name||"",serviceCharge:Number(order.service_charge||0),chargeName:order.charge_adjustment_name||"",gst:Number(order.gst||0),total:Number(order.total||0),paymentMethod:order.payment_method||"Unpaid",amountCollected:Number(paymentSummary?.amountCollected||0),amountDue:Number(paymentSummary?.amountDue??order.total??0),customerName:order.customer_name||"",customerPhone:order.customer_phone||"",customerEmail:order.customer_email||"",cashierName:order.cashier_name||"",items:(data.items||[]).map(item=>({name:item.item_name,price:Number(item.price||0),quantity:Number(item.quantity||0),unit:item.unit||"ea",options:item.options||[],taxRate:Number(item.tax_rate||0),taxMode:item.tax_mode||"exclusive"}))};
        window.openBillPreview(bill);
        await window.printThermalBill({ manual: true });
    }catch(error){alert("Unable to print open order: "+error.message);}
}

async function viewOrderBill(orderId){
    try{
        const data=await api("/orders/"+Number(orderId));
        const paymentSummary=data.paymentSummary||null;
        const order=data.order||{};let orderItems=Array.isArray(data.items)?data.items:[];if(!orderItems.length&&Number(currentOrderForDetails?.order?.id)===Number(orderId))orderItems=currentOrderForDetails.items||[];
        const collected=Number(paymentSummary?.amountCollected||0);
        window.openBillPreview({
            orderId:Number(orderId),
            isOpenOrder:!["completed","cancelled"].includes(String(order.status||"").toLowerCase()),
            orderNumber:order.order_number||`#${orderId}`,
            invoiceNumber:order.invoice_number||"",
            customerCode:order.customer_id?`#${order.customer_id}`:"",
            cashierName:order.cashier_name||"",
            date:order.created_at?formatPOSDateTime(order.created_at):formatPOSDateTime(),
            orderType:order.order_type||"",
            tableNumber:order.table_number||"",
            pax:Number(order.pax||0),
            subtotal:Number(order.subtotal||0),
            discount:Number(order.discount||0),
            discountName:order.discount_adjustment_name||order.marketing_deal_name||"",
            serviceCharge:Number(order.service_charge||0),
            chargeName:order.charge_adjustment_name||"",
            gst:Number(order.gst||0),
            roundingAdjustment:Number(order.rounding_adjustment||0),
            total:Number(order.total||0),
            paymentMethod:order.payment_method||"Unpaid",
            paymentAllocations:Array.isArray(paymentSummary?.allocations)?paymentSummary.allocations:[],
            amountCollected:collected,
            amountDue:Number(paymentSummary?.amountDue??Math.max(0,Number(order.total||0)-collected)),
            customerName:order.customer_name||"",
            customerPhone:order.customer_phone||"",
            customerEmail:order.customer_email||"",
            customerGstin:order.customer_gstin||"",
            customerBirthDate:order.customer_birth_date||"",
            customerAddress:order.customer_address||"",
            customerCity:order.customer_city||"",
            customerState:order.customer_state||"",
            items:normalizeOrderBillItems(orderItems,order),
            viewMode:"side-panel"
        });
    }catch(error){alert("Unable to view this bill: "+(error.message||"Please try again."));}
}

async function openOrderKOTView(orderId = window.selectedOrderId){
    const id = Number(orderId);
    const modal = document.getElementById("orderKOTViewModal");
    const body = document.getElementById("orderKOTViewBody");
    const title = document.getElementById("orderKOTViewTitle");
    const printAll = document.getElementById("orderKOTPrintAllButton");
    if (!id || !modal || !body) return;
    window.orderKOTViewOrderId = id;
    const order = (currentOrders || []).find(item => Number(item.id) === id);
    if (title) title.textContent = `KOT View · ${order?.order_number || `Order #${id}`}`;
    if (printAll) printAll.disabled = true;
    body.innerHTML = '<p class="access-muted">Loading kitchen tickets…</p>';
    modal.style.display = "flex";
    try {
        const isCancelled = String(order?.status || "").toLowerCase() === "cancelled";
        const isUnacceptedQrOrder = (Boolean(order?.public_tracking_token) || /^QR-/i.test(String(order?.order_number || ""))) && String(order?.status || "").toLowerCase() === "pending";
        let tickets = await api(`/kot?orderId=${encodeURIComponent(id)}`);
        if (!tickets?.length && appSettings.kotEnabled !== false && !isCancelled && !isUnacceptedQrOrder && hasPermission("kitchen", "print")) {
            await api(`/orders/${id}/kot`, { method: "POST" });
            tickets = await api(`/kot?orderId=${encodeURIComponent(id)}`);
        }
        const canPrintKOT = hasPermission("kitchen", "print") && appSettings.kotEnabled !== false;
        if (!tickets?.length) {
            body.innerHTML = isUnacceptedQrOrder
                ? '<div class="order-kot-empty"><span class="orders-kot-grid-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span><strong>Waiting for order acceptance</strong><p>The kitchen ticket will be created and sent when this QR order is accepted.</p></div>'
                : '<div class="order-kot-empty"><span class="orders-kot-grid-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span><strong>No KOT tickets for this order</strong><p>Map menu items or categories to a KOT group and assign its printer in Settings → KOT Groups.</p></div>';
        } else {
            const ticketBatches = new Map();
            (tickets || []).forEach(ticket => {
                const ticketNumber = Number(ticket.ticket_number || 1);
                if (!ticketBatches.has(ticketNumber)) ticketBatches.set(ticketNumber, []);
                ticketBatches.get(ticketNumber).push(ticket);
            });
            body.innerHTML = `<div class="order-kot-summary"><strong>${tickets.length} kitchen item${tickets.length === 1 ? "" : "s"}</strong><span>Each add-on batch keeps the same order number and gets its own kitchen ticket.</span></div>` + [...ticketBatches.entries()].map(([ticketNumber, batchTickets]) => {
                const groups = new Map();
                batchTickets.forEach(ticket => {
                    const key = ticket.kot_group_id ? String(ticket.kot_group_id) : "unassigned";
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key).push(ticket);
                });
                const cards = [...groups.entries()].map(([key, groupTickets]) => {
                    const first = groupTickets[0];
                    const groupName = first.kot_group_name || "Unassigned";
                    const station = first.kot_group_station || "Kitchen";
                    const printer = first.printer_name || "No printer assigned · uses the print dialog";
                    const items = groupTickets.map(ticket => {
                        const options = formatItemOptionNames(ticket.options);
                        const quantity=Number(ticket.quantity||0),cancelled=Number(ticket.cancelled_quantity||0),fullyCancelled=quantity<=0&&cancelled>0;
                        return `<li class="${fullyCancelled?"order-kot-cancelled":""}"><div><strong>${fullyCancelled?`<del>${esc(ticket.item_name||"Item")}</del>`:esc(ticket.item_name||"Item")}</strong>${options?`<small>${esc(options)}</small>`:""}</div><span>${cancelled?`<del>(${cancelled})</del> `:""}${quantity>0?`× ${quantity}`:cancelled?"0":"× 0"}</span><em>${fullyCancelled?"Cancelled":esc(ticket.status||"Pending")}</em></li>`;
                    }).join("");
                    const groupArgument = key === "unassigned" ? "'unassigned'" : String(Number(key));
                    return `<article class="order-kot-group-card"><header><div><strong>${esc(groupName)}</strong><small>${esc(station)}</small></div><span class="order-kot-item-count">${groupTickets.length} item${groupTickets.length === 1 ? "" : "s"}</span></header><div class="order-kot-printer"><span>Assigned printer</span><strong>${esc(printer)}</strong></div><ul>${items}</ul>${canPrintKOT ? `<button type="button" class="table-action-btn" onclick="reprintKOTGroup(${id},${groupArgument},${ticketNumber})">🖨️ Print / Reprint this group</button>` : ""}</article>`;
                }).join("");
                const ticketAge = formatKOTAge(batchTickets[0]?.created_at);
                return `<section class="order-kot-ticket-batch"><h3>Kitchen ticket #${ticketNumber} · ${esc(order?.order_number || `Order #${id}`)}</h3><p class="order-kot-received-time">Received ${esc(ticketAge)} · ${esc(batchTickets[0]?.created_at ? formatPOSDateTime(batchTickets[0].created_at) : "Time unavailable")}</p>${cards}</section>`;
            }).join("");
        }
        const orderNote=String(tickets?.[0]?.order_notes||"").trim();
        if(orderNote){body.querySelectorAll(".order-kot-ticket-batch").forEach(section=>{const note=document.createElement("p");note.className="kot-order-note";note.innerHTML="<strong>Order note:</strong> "+esc(orderNote);const received=section.querySelector(".order-kot-received-time");if(received)section.insertBefore(note,received);else section.appendChild(note);});}
        if (printAll) printAll.disabled = !tickets?.length || !canPrintKOT;
    } catch (error) {
        body.innerHTML = `<p class="order-kot-error">Unable to load KOT tickets: ${esc(error.message || "Please try again.")}</p>`;
    }
}

function closeOrderKOTView(){
    const modal = document.getElementById("orderKOTViewModal");
    if (modal) modal.style.display = "none";
}

async function reprintKOTGroup(orderId, groupId, ticketNumber){
    await printKOT(orderId, groupId, ticketNumber);
}

async function printKOT(orderId, onlyGroupId, ticketNumber){
    try{
        let tickets=await api(`/kot?orderId=${encodeURIComponent(Number(orderId))}&print=1`);
        if (ticketNumber !== undefined) tickets = tickets.filter(ticket => Number(ticket.ticket_number || 1) === Number(ticketNumber));
        if (onlyGroupId !== undefined) {
            tickets = tickets.filter(ticket => onlyGroupId === "unassigned"
                ? !Number(ticket.kot_group_id)
                : Number(ticket.kot_group_id) === Number(onlyGroupId));
        }
        if(!tickets.length)return alert("KOT not found.");
        const buckets=new Map();
        tickets.forEach(ticket=>{const key=ticket.kot_group_id?String(ticket.kot_group_id):"unassigned";if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(ticket);});
        for(const [groupId,groupTickets] of buckets){
            const first=groupTickets[0],groupName=first.kot_group_name||"Kitchen";
            const ticketTime = parsePOSDate(first.created_at || Date.now());
            const receipt=[appSettings.restaurantName||"SLASH POS","KITCHEN ORDER TICKET",`KOT #${first.id}`,`Ticket: #${Number(first.ticket_number||1)}`,`Group: ${groupName}`,`Order: ${first.order_number||orderId}`,`Type: ${first.order_type||"-"}`,`Table: ${first.table_number||"-"}${Number(first.pax)>0?` · ${Number(first.pax)} PAX`:""}`,`Received: ${formatKOTAge(ticketTime)} · ${formatPOSDateTime(ticketTime)}`];
            const orderNote=String(first.order_notes||"").trim();
            if(orderNote)receipt.push("Order note: "+orderNote);
            receipt.push("--------------------------------");
            groupTickets.forEach(item=>{const options=formatItemOptionNames(item.options),quantity=Number(item.quantity||0),cancelled=Number(item.cancelled_quantity||0);receipt.push(`${quantity<=0&&cancelled>0?"CANCELLED: ":""}${item.item_name||"Item"} x${quantity}${cancelled>0?` (cancelled x${cancelled})`:""}`);if(options)receipt.push(`  + ${options}`);});
            receipt.push("--------------------------------", "KITCHEN COPY", "", "");
            const text=receipt.join("\n");
            const printerId=Number(first.printer_id||0);
            if(printerId&&first.printer_connection_type==="local"){
                const response=await fetch((window.CAFE_PRINT_SERVICE_URL||"http://127.0.0.1:18181")+"/print",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({printerName:first.printer_name,receipt:text,paperWidth:first.printer_paper_width||appSettings.paperWidth||"80"})});
                const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"Windows print service rejected the KOT.");
            }else if(printerId&&first.printer_connection_type==="network"){
                await api(`/printers/${printerId}/print?source=kot`,{method:"POST",body:JSON.stringify({receipt:text,settings:appSettings})});
            }else if(printerId&&first.printer_connection_type==="bluetooth"){
                await sendBluetoothPrinterText({name:first.printer_name,bluetooth_name:first.printer_bluetooth_name,service_uuid:first.printer_service_uuid,characteristic_uuid:first.printer_characteristic_uuid},text);
            }else{
                const win=window.open("","_blank","width=420,height=700");
                if(!win)return alert("Please allow pop-ups to print KOT.");
                const noteHtml=first.order_notes?'<p class="order-note"><strong>Order note:</strong> '+esc(first.order_notes)+'</p>':'';const rows=groupTickets.map(item=>{const options=formatItemOptionNames(item.options),quantity=Number(item.quantity||0),cancelled=Number(item.cancelled_quantity||0),fullyCancelled=quantity<=0&&cancelled>0;return `<div class="item ${fullyCancelled?"cancelled":""}"><span>${fullyCancelled?`<del>${esc(item.item_name||"Item")}</del>`:esc(item.item_name||"Item")}${options?`<small>${esc(options)}</small>`:""}</span><strong>${cancelled?`<del>(${cancelled})</del> `:""}${quantity>0?`× ${quantity}`:cancelled?"0":"× 0"}</strong></div>`;}).join("");
                win.document.write(`<!doctype html><html><head><title>KOT ${esc(first.order_number||orderId)} · Ticket ${Number(first.ticket_number||1)}</title><style>body{font:16px Arial;width:300px;margin:0 auto;padding:15px;color:#111}h2,.center{text-align:center}.line{border-top:1px dashed;margin:12px 0}.order-note{padding:8px;border:1px dashed #777;font-weight:bold}.item{display:flex;justify-content:space-between;gap:12px;margin:12px 0;font-weight:bold}.item small{display:block;font-weight:normal;margin-top:4px}.item.cancelled{color:#777}.item del{color:#777}.footer{text-align:center;font-weight:bold}</style></head><body><h2>${esc(appSettings.restaurantName||"SLASH POS")}</h2><div class="center">KITCHEN ORDER TICKET · ${esc(groupName)}</div><div class="line"></div><p>Ticket: <b>#${Number(first.ticket_number||1)}</b><br>Order: <b>${esc(first.order_number||orderId)}</b><br>Type: ${esc(first.order_type||"-")} · Table: ${esc(first.table_number||"-")}${Number(first.pax)>0?` · ${Number(first.pax)} PAX`:""}<br>Received: <b>${esc(formatKOTAge(ticketTime))}</b><br>${esc(formatPOSDateTime(ticketTime))}</p>${noteHtml}<div class="line"></div>${rows}<div class="line"></div><div class="footer">KITCHEN COPY</div><script>window.onload=()=>window.print()<\/script></body></html>`);
                win.document.close();
            }
        }
        showProfileToast("KOT sent to the assigned group printers.");
    }catch(error){
        if(isBluetoothSelectionCancelled(error)){
            showProfileToast("Bluetooth printer selection was cancelled. Choose a printer to send the KOT.");
            return;
        }
        console.error("Print KOT failed:",error);
        alert("Unable to print KOT: "+(error?.message||"Windows could not send the print job. Check that the printer is installed and online, then retry."));
    }
}

// ==========================================
// MENU MANAGEMENT
// ==========================================

const MENU_ITEM_TAG_OPTIONS=[
    {label:"Veg",key:"veg"},
    {label:"Non-Veg",key:"non-veg"},
    {label:"Beverage",key:"beverage"},
    {label:"Egg",key:"egg"},
    {label:"Chef Special",key:"chef-special"}
];
function menuTagKey(value){return String(value||"").trim().toLocaleLowerCase().replace(/[^a-z0-9]/g,"");}
function menuTagOption(value){
    const key=menuTagKey(value);
    return MENU_ITEM_TAG_OPTIONS.find(option=>menuTagKey(option.label)===key||option.key.replace(/-/g,"")===key)||null;
}
function renderMenuItemTagBadges(tags,containerClass="menu-item-tags"){
    const values=Array.isArray(tags)?tags:[];
    if(!values.length)return "";
    return `<div class="${containerClass}">${values.map(value=>{
        const option=menuTagOption(value),label=option?.label||String(value||"").trim();
        if(!label)return "";
        const token=(option?.key||"other").replace(/[^a-z0-9-]/g,"");
        return `<span class="menu-item-tag menu-tag-badge menu-tag-${token}" title="${esc(label)}"><span class="menu-tag-icon" aria-hidden="true"></span><span>${esc(label)}</span></span>`;
    }).join("")}</div>`;
}
function setMenuTagPicker(tags=[]){
    const values=Array.isArray(tags)?tags:[];
    const selected=new Set(values.map(menuTagKey));
    document.querySelectorAll("#menuTagPicker input[type=checkbox]").forEach(input=>{input.checked=selected.has(menuTagKey(input.value));if(!input.dataset.summaryBound){input.addEventListener("change",updateMenuTagPickerSummary);input.dataset.summaryBound="true";}});
    updateMenuTagPickerSummary();
    const legacy=values.filter(value=>!menuTagOption(value));
    const legacyBox=document.getElementById("menuLegacyTags");
    if(legacyBox){legacyBox.hidden=!legacy.length;legacyBox.innerHTML=legacy.length?`Existing custom tags will be kept: ${legacy.map(value=>`<span class="menu-legacy-tag">${esc(value)}</span>`).join(" ")}`:"";}
}
function updateMenuTagPickerSummary(){
    const summary=document.getElementById("menuTagPickerSummary");
    if(!summary)return;
    const selected=[...document.querySelectorAll("#menuTagPicker input[type=checkbox]:checked")].map(input=>input.value);
    summary.textContent=selected.length?selected.map(value=>menuTagOption(value)?.label||value).join(", "):"Choose item tags";
}
function selectedMenuItemTags(existingTags=[]){
    const selected=[...document.querySelectorAll("#menuTagPicker input[type=checkbox]:checked")].map(input=>menuTagOption(input.value)?.label||input.value);
    const legacy=(Array.isArray(existingTags)?existingTags:[]).filter(value=>!menuTagOption(value));
    return [...new Set([...selected,...legacy])];
}

async function loadMenuManagement(){
    try{
        await loadMenuCategories();
        currentMenu=await api('/menu');
        setText('menuItemCount',currentMenu.length);
        try{kotGroups=await api('/kot-groups');}catch(_){kotGroups=kotGroups||[];}
        try{await loadMenuOptionSets();}catch(_){menuOptionSets=[];}
        renderMenuOptionSetsOverview();
        const list=document.querySelector('#menu .menu-list');
        if(!list)return;
        list.innerHTML=`<div class="menu-modern-head"><div><strong>${currentMenu.length}</strong><span>menu items</span></div><div class="menu-modern-actions"><input id="menuManagementSearch" type="search" placeholder="Search item, category, variant…" oninput="filterMenuManagement()"><select id="menuManagementNature" onchange="filterMenuManagement()"><option value="">All types</option><option>Goods</option><option>Service</option></select></div></div><div id="menuManagementGrid" class="menu-management-grid"></div>`;
        renderMenuManagementCards();
        renderMenuCategoryMaster();
    }catch(e){console.error('Menu management failed:',e);}
}
function filterMenuManagement(){renderMenuManagementCards();}

function renderMenuManagementCards(){
    const grid=document.getElementById('menuManagementGrid');
    if(!grid)return;
    const q=String(document.getElementById('menuManagementSearch')?.value||'').toLowerCase();
    const nature=String(document.getElementById('menuManagementNature')?.value||'');
    const items=currentMenu.filter(item=>{
        const hay=`${item.name} ${item.sku||''} ${item.description||''} ${(item.tags||[]).join(' ')} ${item.category} ${item.nature} ${(item.variants||[]).map(v=>v.name).join(' ')}`.toLowerCase();
        return(!q||hay.includes(q))&&(!nature||item.nature===nature);
    });
    grid.innerHTML=items.length?items.map(item=>{
        const channel=item.channel_prices||{},variants=item.variants||[],available=item.available!==false;
        return `<article class="menu-admin-card ${available?'':'disabled'}">
          <div class="menu-admin-top"><div class="menu-admin-icon">${menuIcon(item.category)}</div><div><h3>${esc(item.name)}</h3><p>${esc(item.category)} · ${esc(item.nature||'Goods')} · ${esc(item.unit||'ea')}</p></div><span class="menu-availability ${available?'active':'inactive'}">${available?'Available':'Hidden from menu'}</span></div>
          <div class="menu-item-description-meta"><span class="menu-admin-sku">SKU · ${esc(item.sku||'—')}</span>${item.description?`<p>${esc(item.description)}</p>`:''}${renderMenuItemTagBadges(item.tags)}</div>
          <div class="menu-admin-price-row"><div><small>Base</small><strong>${money(item.price)}</strong></div><div><small>Tax</small><strong>${esc(menuTaxLabel(item))} · ${esc(item.tax_mode||'exclusive')}</strong></div></div>
          <div class="menu-channel-chips">${POS_CHANNELS.filter(saleChannel=>!Array.isArray(item.sales_channels)||item.sales_channels.includes(saleChannel.key)).map(saleChannel=>`<span>${esc(saleChannel.label)} ${money(channel[saleChannel.key]??item.price)}</span>`).join('')}</div>
          ${variants.length?`<div class="menu-variant-list"><strong>Variants</strong>${variants.map(v=>`<span>${esc(v.name)} · ${money(resolveMenuPrice(item,v))}</span>`).join('')}</div>`:''}
          <div class="menu-admin-actions"><button type="button" class="table-action-btn" onclick="openMenuPriceEditor(${Number(item.id)})">💰 Manage prices</button><button type="button" class="table-action-btn" onclick="editMenuItem(${Number(item.id)})">Edit details</button><label class="menu-availability-toggle"><input type="checkbox" ${available?'checked':''} onchange="setMenuItemAvailability(${Number(item.id)},this.checked)" aria-label="Enable ${esc(item.name)} in the POS"><span>${available?'POS On':'POS Off'}</span></label></div>
        </article>`;
    }).join(''):'<div class="menu-empty-state">No matching menu items.</div>';
}

let menuPriceEditingId=null;
function openMenuPriceEditor(id){
    const item=currentMenu.find(row=>Number(row.id)===Number(id));
    if(!item)return;
    menuPriceEditingId=Number(item.id);
    const prices=item.channel_prices||{};
    document.getElementById('menuPriceModalTitle').textContent=`Manage prices · ${item.name}`;
    document.getElementById('managedMenuBasePrice').value=item.price??0;
    document.getElementById('managedMenuChannelPrices').innerHTML=POS_CHANNELS.map(channel=>`<div class="form-group"><label for="managedMenuPrice_${channel.key}">${esc(channel.label)} price</label><input id="managedMenuPrice_${channel.key}" type="number" min="0" step="0.01" value="${Number(prices[channel.key]??item.price??0)}"></div>`).join('');
    document.getElementById('menuVariantPriceEditor').innerHTML=(item.variants||[]).map(variant=>`<label class="menu-price-variant-row"><span>${esc(variant.name)}${variant.unit?' · '+esc(variant.unit):''}</span><input class="managed-menu-variant-price" type="number" min="0" step="0.01" data-id="${Number(variant.id)}" value="${Number(variant.price||0)}" aria-label="${esc(variant.name)} price"></label>`).join('')||'<p class="access-muted">This item has no size variants.</p>';
    document.getElementById('menuPriceModal').style.display='flex';
}
function closeMenuPriceEditor(){document.getElementById('menuPriceModal').style.display='none';menuPriceEditingId=null;}
async function saveMenuPriceEditor(){
    if(!menuPriceEditingId)return;
    const fields={price:document.getElementById('managedMenuBasePrice').value};
    const channelPrices={};
    for(const channel of POS_CHANNELS){const value=document.getElementById('managedMenuPrice_'+channel.key)?.value;if(value===''||!Number.isFinite(Number(value))||Number(value)<0)return alert(`Enter a valid ${channel.label} price.`);channelPrices[channel.key]=Number(value);}
    if(Object.values(fields).some(value=>value===''||!Number.isFinite(Number(value))||Number(value)<0))return alert('Enter a valid price in every field.');
    const variantInputs=[...document.querySelectorAll('.managed-menu-variant-price')];
    if(variantInputs.some(input=>input.value===''||!Number.isFinite(Number(input.value))||Number(input.value)<0))return alert('Enter a valid price for every size variant.');
    const payload={price:Number(fields.price),channelPrices,variants:variantInputs.map(input=>({id:Number(input.dataset.id),price:Number(input.value)}))};
    try{await api(`/menu/${menuPriceEditingId}/prices`,{method:'PATCH',body:JSON.stringify(payload)});closeMenuPriceEditor();await loadMenuManagement();await loadMenu();showProfileToast('Menu prices updated.');}
    catch(error){alert(error.message||'Could not update menu prices.');}
}

async function setMenuItemAvailability(id,available){
    try{
        await api(available?`/menu/${id}/enable`:`/menu/${id}`,{method:available?'PUT':'DELETE'});
        await loadMenuManagement();
        await loadMenu();
        showProfileToast(available?'Item is back on the menu.':'Item is hidden from the menu.');
    }catch(error){
        alert(error.message||'Could not change item availability.');
        await loadMenuManagement();
    }
}

let restaurantMenuPublication=null;
let qrMenuCategoryNames=[];
let qrCategoryOrder=[];
async function editMenuItem(id){const item=currentMenu.find(x=>Number(x.id)===Number(id));if(item)openAddMenuModal(item);}
function renderMenuChannelFields(selectedChannels=null, channelPrices={}, basePrice=0){
    const availability=document.getElementById('menuChannelAvailability'),prices=document.getElementById('menuChannelPriceGrid');
    const normalizedSelection=normalizeMenuSaleChannelKeys(selectedChannels);
    const selected=new Set(normalizedSelection===null?POS_CHANNELS.map(channel=>channel.key):normalizedSelection);
    if(availability)availability.innerHTML=POS_CHANNELS.map(channel=>`<label class="menu-channel-availability-choice"><input type="checkbox" value="${esc(channel.key)}" ${selected.has(channel.key)?'checked':''}><span><strong>${esc(channel.label)}</strong>${channel.qrMenu?'<small>Guest QR ordering</small>':''}</span></label>`).join('');
    if(prices)prices.innerHTML=POS_CHANNELS.map(channel=>`<div class="form-group"><label for="menuPrice_${channel.key}">${esc(channel.label)} price</label><input id="menuPrice_${channel.key}" type="number" min="0" step="0.01" value="${Number(channelPrices[channel.key]??basePrice??0)}"></div>`).join('');
}
function openAddMenuModal(item=null){
    editingMenuItemId=item?.id||null;
    currentMenuImageData=item?.image_url||item?.imageUrl||null;
    populateMenuCategorySelect(item?.category||'');
    document.getElementById('addMenuModalTitle').textContent=editingMenuItemId?'Edit Menu Item':'Add Menu Item';
    document.getElementById('menuName').value=item?.name||'';
    document.getElementById('menuSku').value=item?.sku||'';
    document.getElementById('menuDescription').value=item?.description||'';
    setMenuTagPicker(item?.tags||[]);
    document.getElementById('menuPrice').value=item?.price??'';
    document.getElementById('menuCategory').value=item?.category||'';
    document.getElementById('menuNature').value=item?.nature||'Goods';
    document.getElementById('menuUnit').value=item?.unit||'ea';
    document.getElementById('menuTaxProfile').value=Number(item?.tax_rate||5)===0?'0':Number(item?.tax_rate||5)===18?'18':Number(item?.tax_rate||5)===28?'28':'5';
    document.getElementById('menuTaxMode').value=item?.tax_mode||'exclusive';
    const channelPrices=item?.channel_prices||{};
    renderMenuChannelFields(item?.sales_channels,channelPrices,item?.price||0);
    const file=document.getElementById('menuImageFile');
    if(file)file.value='';
    renderMenuItemImagePreview();
    const optionDisclosure=document.getElementById('menuOptionSetDisclosure');
    if(optionDisclosure)optionDisclosure.open=false;
    renderMenuOptionSetPicker(item?.option_set_ids||[]);
    renderMenuVariantsEditor(item?.variants||[]);
    document.getElementById('addMenuModal').style.display='flex';
}
function closeAddMenuModal(){document.getElementById('addMenuModal').style.display='none';document.getElementById('menuTagPicker')?.removeAttribute('open');editingMenuItemId=null;currentMenuImageData=null;}
function menuVariantEditorRow(variant={}){return `<div class="variant-editor-row"><input class="variant-name" placeholder="Variant (Small / Large)" value="${esc(variant.name||'')}"><input class="variant-sku" placeholder="SKU" value="${esc(variant.sku||'')}"><input class="variant-price" type="number" min="0" step="0.01" placeholder="Price" value="${variant.price??''}"><select class="variant-unit"><option value="ea" ${variant.unit==='ea'?'selected':''}>ea</option><option value="g" ${variant.unit==='g'?'selected':''}>g</option><option value="kg" ${variant.unit==='kg'?'selected':''}>kg</option><option value="ml" ${variant.unit==='ml'?'selected':''}>ml</option><option value="lt" ${variant.unit==='lt'?'selected':''}>lt</option></select><button type="button" class="cancel-btn" onclick="this.parentElement.remove()">✕</button></div>`;}
function renderMenuVariantsEditor(variants=[]){const wrap=document.getElementById('menuVariantsEditor');if(wrap)wrap.innerHTML=(variants||[]).map(menuVariantEditorRow).join('');}
function addMenuVariantRow(){document.getElementById('menuVariantsEditor')?.insertAdjacentHTML('beforeend',menuVariantEditorRow({}));}
function renderMenuItemImagePreview(){const box=document.getElementById('menuImagePreview');if(!box)return;box.innerHTML=currentMenuImageData?`<img src="${esc(currentMenuImageData)}" alt="Menu item preview">`:'<span>No image selected</span>';}
async function previewMenuItemImage(file){
    if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type))return alert('Choose a JPG, PNG or WebP image.');
    if(file.size>8*1024*1024)return alert('Choose an image smaller than 8 MB before compression.');
    try{
        const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas'),limit=60*1024;
        let longest=Math.min(1600,Math.max(bitmap.width,bitmap.height)),quality=0.86,encoded='';
        for(let attempt=0;attempt<24;attempt++){
            const scale=Math.min(1,longest/Math.max(bitmap.width,bitmap.height));
            canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
            canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,canvas.width,canvas.height);
            encoded=canvas.toDataURL('image/jpeg',quality);
            if(atob(encoded.split(',')[1]).length<=limit)break;
            if(quality>0.52)quality=Math.max(0.5,quality-0.08);else longest=Math.max(240,Math.floor(longest*0.84));
        }
        bitmap.close?.();
        if(atob(encoded.split(',')[1]).length>limit)throw new Error('Could not compress this image below 60 KB. Choose a smaller image.');
        currentMenuImageData=encoded;renderMenuItemImagePreview();
    }catch(error){alert(error.message||'Unable to read this image.');}
}
function clearMenuItemImage(){currentMenuImageData=null;const file=document.getElementById('menuImageFile');if(file)file.value='';renderMenuItemImagePreview();}
function renderMenuOptionSetPicker(selected=[]){const box=document.getElementById('menuOptionSetPicker');if(!box)return;const selectedIds=new Set((selected||[]).map(String));box.innerHTML=menuOptionSets.length?menuOptionSets.map(set=>`<label class="menu-option-set-choice"><input type="checkbox" value="${esc(set.id)}" ${selectedIds.has(String(set.id))?'checked':''} onchange="updateMenuOptionSetDisclosure()"><span><strong>${esc(set.name)}</strong><small>${Number(set.minSelections||0)}–${Number(set.maxSelections||1)} choices · ${(set.options||[]).length} options</small></span></label>`).join(''):'<span class="access-muted">No option sets yet. Create one to attach it to this item.</span>';updateMenuOptionSetDisclosure();}
function updateMenuOptionSetDisclosure(){const summary=document.getElementById('menuOptionSetSelectionSummary');if(!summary)return;const count=document.querySelectorAll('#menuOptionSetPicker input[type="checkbox"]:checked').length;summary.textContent=count?`${count} option set${count===1?'':'s'} selected`:menuOptionSets.length?'Choose from your saved option sets':'No saved option sets yet';}
async function saveMenuItemV2(){
    const wasEditing=Boolean(editingMenuItemId),name=document.getElementById('menuName').value.trim(),price=Number(document.getElementById('menuPrice').value),category=document.getElementById('menuCategory').value.trim();
    if(!name||!Number.isFinite(price)||price<0||!category)return alert('Enter valid menu details.');
    const taxMap={0:{rate:0,cgst:0,sgst:0,igst:0,label:'Tax 0%'},5:{rate:5,cgst:2.5,sgst:2.5,igst:5,label:'GST 5%'},18:{rate:18,cgst:9,sgst:9,igst:18,label:'GST 18%'},28:{rate:28,cgst:14,sgst:14,igst:28,label:'GST 28%'}};
    const t=taxMap[document.getElementById('menuTaxProfile').value]||taxMap[5],channelPrices={};
    const salesChannels=[...document.querySelectorAll('#menuChannelAvailability input:checked')].map(input=>input.value);
    if(!salesChannels.length)return alert('Choose at least one sale channel for this item.');
    for(const channel of POS_CHANNELS){const raw=String(document.getElementById('menuPrice_'+channel.key)?.value||'').trim();if(raw!==''){const value=Number(raw);if(Number.isFinite(value)&&value>=0)channelPrices[channel.key]=value;}}
    const variants=[...document.querySelectorAll('#menuVariantsEditor .variant-editor-row')].map(row=>({name:row.querySelector('.variant-name')?.value.trim(),sku:row.querySelector('.variant-sku')?.value.trim(),price:Number(row.querySelector('.variant-price')?.value),unit:row.querySelector('.variant-unit')?.value||'ea'})).filter(v=>v.name&&Number.isFinite(v.price)&&v.price>=0);
    const existing=editingMenuItemId?currentMenu.find(item=>Number(item.id)===Number(editingMenuItemId)):null;
    const payload={name,sku:document.getElementById('menuSku').value.trim(),description:document.getElementById('menuDescription').value.trim(),tags:selectedMenuItemTags(existing?.tags||[]),price,category,nature:document.getElementById('menuNature').value,unit:document.getElementById('menuUnit').value,taxRate:t.rate,cgstRate:t.cgst,sgstRate:t.sgst,igstRate:t.igst,taxLabel:t.label,taxMode:document.getElementById('menuTaxMode').value,channelPrices,salesChannels,variants,imageUrl:currentMenuImageData,optionSetIds:[...document.querySelectorAll('#menuOptionSetPicker input:checked')].map(input=>input.value),available:existing?existing.available!==false:true};
    try{await api(editingMenuItemId?`/menu/${editingMenuItemId}`:'/menu',{method:editingMenuItemId?'PUT':'POST',body:JSON.stringify(payload)});closeAddMenuModal();await loadMenuManagement();await loadMenu();showProfileToast(wasEditing?'Menu item updated successfully.':'Menu item added successfully.',true);}catch(error){alert(error.message);}
}

function optionSetNewId(){return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;}
function renderMenuOptionSetsOverview(){
    const list=document.getElementById('menuOptionSetOverviewList');
    setText('menuOptionSetCount',menuOptionSets.length);
    if(!list)return;
    list.innerHTML=menuOptionSets.length?menuOptionSets.map(set=>`<article class="menu-option-set-summary-card"><div class="menu-option-set-summary-top"><span class="menu-option-set-summary-icon">🧩</span><span class="menu-option-set-summary-count">${(set.options||[]).length} choices</span></div><h3>${esc(set.name)}</h3><p>${Number(set.minSelections||0)}–${Number(set.maxSelections||1)} selections allowed</p><div class="menu-option-set-summary-choices">${(set.options||[]).slice(0,5).map(option=>`<span>${esc(option.name)}</span>`).join('')}${(set.options||[]).length>5?`<small>+${set.options.length-5} more</small>`:''}</div></article>`).join(''):'<div class="menu-option-sets-empty"><span>🧩</span><strong>No item option sets yet</strong><p>Create option sets here, then attach them to menu items.</p><button type="button" class="big-btn" onclick="openOptionSetsModal()">＋ Create an option set</button></div>';
}
async function openOptionSetsModal(){
    try{await loadMenuOptionSets();}catch(error){alert('Could not load option sets: '+error.message);return;}
    if(!currentMenu.length){try{currentMenu=await api('/menu');}catch(error){alert('Could not load menu items: '+error.message);return;}}
    renderMenuOptionSetsOverview();renderOptionSetList();newOptionSet();document.getElementById('menuOptionSetsModal').style.display='flex';
}
function closeOptionSetsModal(){document.getElementById('menuOptionSetsModal').style.display='none';renderMenuOptionSetPicker([...document.querySelectorAll('#menuOptionSetPicker input:checked')].map(input=>input.value));}
function renderOptionSetList(selectedId=''){const select=document.getElementById('optionSetSelect');if(!select)return;select.innerHTML=menuOptionSets.map(set=>`<option value="${esc(set.id)}">${esc(set.name)}</option>`).join('');if(selectedId)select.value=String(selectedId);}
function availableOptionMenuItems(){return (currentMenu||[]).filter(item=>item&&item.id&&item.available!==false);}
function renderOptionSetMenuItemChoices(){
    const select=document.getElementById('optionSetMenuItem');if(!select)return;
    const selectedIds=new Set([...document.querySelectorAll('#optionSetItems .option-set-item-row')].map(row=>String(row.dataset.menuItemId||'')));
    const term=String(document.getElementById('optionSetMenuItemSearch')?.value||'').trim().toLocaleLowerCase();
    const choices=availableOptionMenuItems().filter(item=>!selectedIds.has(String(item.id))).filter(item=>!term||`${item.name||''} ${item.category||''}`.toLocaleLowerCase().includes(term));
    const prompt=term?(choices.length?'Choose a matching menu item':'No available menu items match your search'):'Choose an available menu item';
    select.innerHTML=`<option value="">${prompt}</option>`+choices.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}${item.category?` · ${esc(item.category)}`:''} · ${money(item.price||0)}</option>`).join('');
}
function renderOptionSetItems(options=[]){
    const box=document.getElementById('optionSetItems');if(!box)return;
    const linked=[],missing=[];
    (options||[]).forEach(option=>{
        const item=availableOptionMenuItems().find(candidate=>String(candidate.id)===String(option.menuItemId))||availableOptionMenuItems().find(candidate=>String(candidate.name||'').trim().toLowerCase()===String(option.name||'').trim().toLowerCase());
        if(item)linked.push({item,option});else missing.push(option);
    });
    box.innerHTML=linked.map(({item,option})=>`<div class="option-set-item-row" data-menu-item-id="${esc(item.id)}"><input class="option-set-option-id" type="hidden" value="${esc(option.id||'')}"><input class="option-set-menu-item-id" type="hidden" value="${esc(item.id)}"><div class="option-set-item-copy"><strong>${esc(item.name)}</strong><small>Menu price ${money(item.price||0)}</small></div><label>Extra price<input class="option-set-item-price" type="number" min="0" step="0.01" value="${Number(option.price||0)}" aria-label="Extra price for ${esc(item.name)}"></label><button type="button" class="option-set-item-remove" onclick="removeOptionSetMenuItem(this)" aria-label="Remove ${esc(item.name)}">✕</button></div>`).join('')+
        missing.map(option=>`<div class="option-set-legacy-row" data-option-id="${esc(option.id||'')}"><span>“${esc(option.name||'Unnamed option')}” is not an available menu item. Remove it or replace it with a menu item.</span><button type="button" onclick="this.closest('.option-set-legacy-row').remove()">Remove</button></div>`).join('')+
        (linked.length||missing.length?'':'<div class="option-set-items-empty">Add choices from the available menu items above.</div>');
    renderOptionSetMenuItemChoices();
}
function addOptionSetMenuItem(){
    const select=document.getElementById('optionSetMenuItem'),item=availableOptionMenuItems().find(candidate=>String(candidate.id)===String(select?.value||''));if(!item)return;
    const current=[...document.querySelectorAll('#optionSetItems .option-set-item-row')].map(row=>({id:row.querySelector('.option-set-option-id')?.value,menuItemId:row.querySelector('.option-set-menu-item-id')?.value,price:Number(row.querySelector('.option-set-item-price')?.value||0),name:currentMenu.find(candidate=>String(candidate.id)===String(row.dataset.menuItemId))?.name||''}));
    if(current.some(option=>String(option.menuItemId)===String(item.id)))return;
    current.push({id:`${optionSetNewId()}_option`,menuItemId:item.id,name:item.name,price:Number(item.price||0)});renderOptionSetItems(current);
}
function removeOptionSetMenuItem(button){const row=button?.closest('.option-set-item-row');if(!row)return;row.remove();renderOptionSetMenuItemChoices();}
function newOptionSet(){document.getElementById('optionSetSelect').value='';document.getElementById('optionSetId').value='';document.getElementById('optionSetName').value='';document.getElementById('optionSetMin').value='0';document.getElementById('optionSetMax').value='1';const search=document.getElementById('optionSetMenuItemSearch');if(search)search.value='';renderOptionSetItems([]);}
function selectOptionSetForEdit(id){const set=menuOptionSets.find(item=>String(item.id)===String(id));if(!set)return;document.getElementById('optionSetId').value=set.id;document.getElementById('optionSetName').value=set.name;document.getElementById('optionSetMin').value=set.minSelections??0;document.getElementById('optionSetMax').value=set.maxSelections??1;const search=document.getElementById('optionSetMenuItemSearch');if(search)search.value='';renderOptionSetItems(set.options||[]);}
async function saveOptionSet(){
    const existingId=document.getElementById('optionSetId').value||optionSetNewId(),name=document.getElementById('optionSetName').value.trim(),minSelections=Number(document.getElementById('optionSetMin').value||0),maxSelections=Number(document.getElementById('optionSetMax').value||1);
    if(document.querySelector('#optionSetItems .option-set-legacy-row'))return alert('Replace or remove options that are not available menu items before saving this set.');
    const options=[...document.querySelectorAll('#optionSetItems .option-set-item-row')].map(row=>{const menuItemId=Number(row.querySelector('.option-set-menu-item-id')?.value),menuItem=availableOptionMenuItems().find(item=>Number(item.id)===menuItemId),price=Number(row.querySelector('.option-set-item-price')?.value);return menuItem?{id:row.querySelector('.option-set-option-id')?.value||`${optionSetNewId()}_option`,menuItemId,name:menuItem.name,price}:null;}).filter(Boolean);
    if(!name||!options.length||options.some(option=>!Number.isFinite(option.price)||option.price<0)||new Set(options.map(option=>Number(option.menuItemId))).size!==options.length)return alert('Choose a set name and at least one unique, available menu item with a valid extra price.');
    if(!Number.isInteger(minSelections)||!Number.isInteger(maxSelections)||minSelections<0||maxSelections<1||minSelections>maxSelections||maxSelections>options.length)return alert('Check the minimum and maximum selections against the number of options.');
    const item={id:existingId,name,minSelections,maxSelections,options},next=menuOptionSets.filter(set=>String(set.id)!==String(existingId)).concat(item);
    try{const result=await api('/menu-option-sets',{method:'PUT',body:JSON.stringify({optionSets:next})});menuOptionSets=result.optionSets||next;renderMenuOptionSetsOverview();renderOptionSetList(item.id);selectOptionSetForEdit(item.id);renderMenuOptionSetPicker([...document.querySelectorAll('#menuOptionSetPicker input:checked')].map(input=>input.value));showProfileToast('Option set saved successfully.',true);}catch(error){alert(error.message);}
}
async function deleteOptionSet(){const id=document.getElementById('optionSetId').value;if(!id)return;const next=menuOptionSets.filter(set=>String(set.id)!==String(id));try{const result=await api('/menu-option-sets',{method:'PUT',body:JSON.stringify({optionSets:next})});menuOptionSets=result.optionSets||next;renderMenuOptionSetsOverview();renderOptionSetList();newOptionSet();renderMenuOptionSetPicker([...document.querySelectorAll('#menuOptionSetPicker input:checked')].map(input=>input.value));}catch(error){alert(error.message);}}
async function disableMenuItem(id){if(!confirm('Disable this menu item?'))return;try{await api(`/menu/${id}`,{method:'DELETE'});await loadMenuManagement();await loadMenu();}catch(e){alert(e.message);}}
async function enableMenuItem(id){try{await api(`/menu/${id}/enable`,{method:'PUT'});await loadMenuManagement();await loadMenu();}catch(e){alert(e.message);}}

let menuImportRows = [];

function openMenuImportModal() {
    menuImportRows = [];
    const file = document.getElementById("menuImportFile");
    if (file) file.value = "";
    document.getElementById("menuImportFileName").textContent = "No file selected";
    document.getElementById("menuImportStatus").textContent = "Required columns: Item Name, Category, Price. Optional columns include SKU, Description, channel prices, tax, unit and availability.";
    document.getElementById("menuImportPreview").innerHTML = "";
    document.getElementById("menuImportSubmit").disabled = true;
    document.getElementById("menuImportModal").style.display = "flex";
}

function closeMenuImportModal() {
    document.getElementById("menuImportModal").style.display = "none";
}

function downloadMenuImportTemplate() {
    const headers = ["Item Name", "SKU", "Description", "Category", "Price", ...POS_CHANNELS.map(channel=>`${channel.label} Price`), "Sale Channels", "Available", "Nature", "Unit", "Tax Rate", "Tax Mode"];
    const example = ["Masala Chai", "", "Freshly brewed spiced tea.", "Hot Drinks", "80", ...POS_CHANNELS.map(()=>"80"), POS_CHANNELS.map(channel=>channel.label).join("; "), "TRUE", "Goods", "cup", "5", "exclusive"];
    const csv = "\uFEFF" + [headers, example].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "cafe-pos-menu-template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
}

async function downloadExistingMenuSpreadsheet() {
    try {
        const items = await api("/menu");
        if (!Array.isArray(items) || !items.length) {
            alert("No existing menu items were found to export.");
            return;
        }
        const headers = ["Item Name", "SKU", "Description", "Category", "Price", ...POS_CHANNELS.map(channel=>`${channel.label} Price`), "Sale Channels", "Available", "Nature", "Unit", "Tax Rate", "Tax Mode"];
        const rows = items.map(item => {
            const channelPrices = item.channel_prices || {};
            return [
                item.name || "", item.sku || "", item.description || "", item.category || "", item.price ?? "",
                ...POS_CHANNELS.map(channel=>channelPrices[channel.key]??""),
                (Array.isArray(item.sales_channels)?item.sales_channels:POS_CHANNELS.map(channel=>channel.key)).map(key=>getSaleChannel(key)?.label||key).join("; "),
                item.available === false ? "FALSE" : "TRUE", item.nature || "Goods", item.unit || "ea",
                item.tax_rate ?? "", item.tax_mode || "exclusive"
            ];
        });
        const csvCell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const csv = String.fromCharCode(0xFEFF) + [headers, ...rows].map(row => row.map(csvCell).join(",")).join(String.fromCharCode(13, 10));
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `cafe-pos-existing-menu-${getPOSDateKey()}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        alert("Unable to export existing menu items: " + error.message);
    }
}

function parseMenuDelimited(text, delimiter) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const source = String(text || "").replace(/^\uFEFF/, "");
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '"') {
            if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
            else quoted = !quoted;
        } else if (char === delimiter && !quoted) {
            row.push(cell); cell = "";
        } else if ((char === "\n" || char === "\r") && !quoted) {
            if (char === "\r" && source[index + 1] === "\n") index += 1;
            row.push(cell); cell = "";
            if (row.some(value => String(value).trim())) rows.push(row);
            row = [];
        } else cell += char;
    }
    row.push(cell);
    if (row.some(value => String(value).trim())) rows.push(row);
    return rows;
}

function normalizeZipPath(value) {
    const stack = [];
    for (const part of String(value).replace(/^\//, "").split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
    }
    return stack.join("/");
}

async function readXlsxZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minEOCD = Math.max(0, bytes.length - 65558);
    let endRecord = -1;
    for (let offset = bytes.length - 22; offset >= minEOCD; offset -= 1) {
        if (view.getUint32(offset, true) === 0x06054b50) { endRecord = offset; break; }
    }
    if (endRecord < 0) throw new Error("This file is not a supported .xlsx workbook.");
    const entryCount = view.getUint16(endRecord + 10, true);
    let cursor = view.getUint32(endRecord + 16, true);
    const entries = new Map();
    const decoder = new TextDecoder("utf-8");
    for (let index = 0; index < entryCount; index += 1) {
        if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("The workbook has an invalid ZIP directory.");
        const method = view.getUint16(cursor + 10, true);
        const compressedSize = view.getUint32(cursor + 20, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const localOffset = view.getUint32(cursor + 42, true);
        const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
        if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("The workbook contains an invalid file entry.");
        const dataOffset = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
        let content;
        if (method === 0) content = compressed;
        else if (method === 8 && window.DecompressionStream) {
            content = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
        } else throw new Error("This browser cannot read the workbook compression format.");
        entries.set(name, decoder.decode(content));
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

async function parseMenuXlsx(file) {
    const entries = await readXlsxZip(file);
    const parseXML = source => {
        if (!source) return null;
        const xml = new DOMParser().parseFromString(source, "application/xml");
        if (xml.querySelector("parsererror")) throw new Error("The Excel workbook contains invalid XML.");
        return xml;
    };
    const sharedXML = parseXML(entries.get("xl/sharedStrings.xml"));
    const shared = sharedXML ? [...sharedXML.getElementsByTagName("si")].map(item => item.textContent || "") : [];
    const workbook = parseXML(entries.get("xl/workbook.xml"));
    const firstSheet = workbook?.getElementsByTagName("sheet")[0];
    let sheetPath = "xl/worksheets/sheet1.xml";
    if (firstSheet) {
        const relationId = firstSheet.getAttribute("r:id");
        const rels = parseXML(entries.get("xl/_rels/workbook.xml.rels"));
        const rel = rels && [...rels.getElementsByTagName("Relationship")].find(item => item.getAttribute("Id") === relationId);
        if (rel?.getAttribute("Target")) {
            const target = rel.getAttribute("Target");
            sheetPath = normalizeZipPath(target.startsWith("/") || target.startsWith("xl/") ? target : `xl/${target}`);
        }
    }
    const sheet = parseXML(entries.get(sheetPath));
    if (!sheet) throw new Error("The workbook has no readable first worksheet.");
    const columnIndex = ref => {
        const letters = String(ref || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
        let value = 0;
        for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
        return value - 1;
    };
    return [...sheet.getElementsByTagName("row")].map(rowNode => {
        const row = [];
        for (const cell of rowNode.getElementsByTagName("c")) {
            const type = cell.getAttribute("t");
            const valueNode = cell.getElementsByTagName("v")[0];
            let value = valueNode?.textContent || "";
            if (type === "s") value = shared[Number(value)] ?? "";
            else if (type === "inlineStr") value = cell.getElementsByTagName("is")[0]?.textContent || "";
            else if (type === "b") value = value === "1" ? "TRUE" : "FALSE";
            row[columnIndex(cell.getAttribute("r"))] = value;
        }
        return row;
    }).filter(row => row.some(value => String(value || "").trim()));
}

function mapMenuImportRows(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 2) throw new Error("The sheet needs a header row and at least one item row.");
    const normalize = text => String(text || "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    const headers = matrix[0].map(normalize);
    const findColumn = (...names) => headers.findIndex(header => names.map(normalize).includes(header));
    const columns = {
        name: findColumn("Item Name", "Name", "Item", "Product Name"),
        sku: findColumn("SKU", "SKU Code", "Product SKU"),
        description: findColumn("Description", "Item Description", "Product Description"),
        category: findColumn("Category", "Menu Category"),
        price: findColumn("Price", "Base Price", "Selling Price"),
        available: findColumn("Available", "Availability", "Active"),
        nature: findColumn("Nature", "Item Nature"),
        unit: findColumn("Unit", "UOM"),
        taxRate: findColumn("Tax Rate", "GST Rate", "Tax"),
        taxMode: findColumn("Tax Mode")
    };
    const channelPriceColumns=POS_CHANNELS.map(channel=>({key:channel.key,column:findColumn(`${channel.label} Price`,`${channel.key} Price`,channel.key==="online"?"Online Price":"")}));
    const salesChannelsColumn=findColumn("Sale Channels","Sales Channels","Available Channels");
    if (columns.name < 0 || columns.category < 0 || columns.price < 0) throw new Error("The sheet must include Item Name, Category and Price columns.");
    const valueAt = (row, column) => column < 0 ? "" : String(row[column] ?? "").trim();
    const optionalNumber = (row, column) => {
        const raw = valueAt(row, column);
        return raw === "" ? null : Number(raw);
    };
    return matrix.slice(1).map((row, index) => {
        const name = valueAt(row, columns.name);
        const sku = valueAt(row, columns.sku);
        const category = valueAt(row, columns.category);
        const price = optionalNumber(row, columns.price);
        const invalidSku = sku && (sku.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sku));
        let reason = !name ? "Item name is missing." : !category ? "Category is missing." : !Number.isFinite(price) || price < 0 ? "Price must be a non-negative number." : invalidSku ? "SKU must be up to 80 characters and use letters, numbers, dots, underscores, slashes or hyphens." : "";
        const channelPrices = {};
        for (const {key,column} of channelPriceColumns) {
            const amount = optionalNumber(row, column);
            if (amount !== null && Number.isFinite(amount) && amount >= 0) channelPrices[key] = amount;
        }
        const rawSalesChannels=valueAt(row,salesChannelsColumn);
        const salesChannels=rawSalesChannels?rawSalesChannels.split(/[;,|]/).map(value=>value.trim()).filter(Boolean).map(value=>POS_CHANNELS.find(channel=>channel.key===value||channel.label.toLocaleLowerCase()===value.toLocaleLowerCase())?.key||value):null;
        const unknownSalesChannels=salesChannels?.filter(key=>!POS_CHANNELS.some(channel=>channel.key===key))||[];
        if(!reason&&unknownSalesChannels.length)reason=`Unknown sale channel: ${unknownSalesChannels.join(", ")}.`;
        const rawTax = optionalNumber(row, columns.taxRate);
        const rawAvailable = valueAt(row, columns.available).toLocaleLowerCase();
        const rawNature = valueAt(row, columns.nature);
        const rawTaxMode = valueAt(row, columns.taxMode).toLocaleLowerCase();
        return {
            rowNumber: index + 2, name, sku, description: valueAt(row, columns.description), category, price,
            channelPrices, salesChannels,
            available: rawAvailable === "" ? null : !["false", "no", "0", "inactive", "disabled"].includes(rawAvailable),
            nature: ["goods", "service"].includes(rawNature.toLocaleLowerCase()) ? rawNature[0].toUpperCase() + rawNature.slice(1).toLowerCase() : null,
            unit: valueAt(row, columns.unit) || null,
            taxRate: rawTax === null ? null : Number.isFinite(rawTax) && rawTax >= 0 && rawTax <= 100 ? rawTax : null,
            taxMode: ["inclusive", "exclusive"].includes(rawTaxMode) ? rawTaxMode : null,
            error: reason || (rawTax !== null && (!Number.isFinite(rawTax) || rawTax < 0 || rawTax > 100) ? "Tax rate must be between 0 and 100." : "")
        };
    }).filter(item => item.name || item.category || item.price !== null);
}

async function readMenuImportFile(file) {
    const status = document.getElementById("menuImportStatus");
    const preview = document.getElementById("menuImportPreview");
    const submit = document.getElementById("menuImportSubmit");
    if (!file || !status || !preview || !submit) return;
    menuImportRows = [];
    submit.disabled = true;
    document.getElementById("menuImportFileName").textContent = file.name;
    status.textContent = "Reading spreadsheet…";
    preview.innerHTML = "";
    try {
        const extension = file.name.split(".").pop().toLocaleLowerCase();
        const matrix = extension === "xlsx"
            ? await parseMenuXlsx(file)
            : parseMenuDelimited(await file.text(), extension === "tsv" ? "\t" : ",");
        menuImportRows = mapMenuImportRows(matrix);
        const valid = menuImportRows.filter(row => !row.error);
        const invalid = menuImportRows.length - valid.length;
        const limited = menuImportRows.length > 500;
        status.textContent = `${menuImportRows.length} item row${menuImportRows.length === 1 ? "" : "s"} found · ${valid.length} ready${invalid ? ` · ${invalid} with errors` : ""}${limited ? " · Split this file into batches of 500 or fewer" : ""}. Blank optional columns keep current values on matching items; blank SKU creates one for new items.`;
        const sample = menuImportRows.slice(0, 8);
        preview.innerHTML = sample.length ? `<div class="table-container"><table><thead><tr><th>Item</th><th>SKU</th><th>Description</th><th>Category</th><th>Price</th><th>Check</th></tr></thead><tbody>${sample.map(row => `<tr><td>${esc(row.name || "-")}</td><td>${esc(row.sku || "Auto")}</td><td>${esc(row.description || "-")}</td><td>${esc(row.category || "-")}</td><td>${Number.isFinite(row.price) ? money(row.price) : "-"}</td><td>${row.error ? `<span class="menu-import-error">${esc(row.error)}</span>` : "Ready"}</td></tr>`).join("")}</tbody></table></div>${menuImportRows.length > sample.length ? `<small>Showing 8 of ${menuImportRows.length} rows.</small>` : ""}` : '<p class="access-muted">No menu rows found.</p>';
        submit.disabled = !valid.length || limited;
    } catch (error) {
        menuImportRows = [];
        status.textContent = error.message || "Unable to read this file.";
    }
}

async function submitMenuSpreadsheet() {
    const valid = menuImportRows.filter(row => !row.error);
    if (!valid.length || valid.length > 500) return;
    const button = document.getElementById("menuImportSubmit");
    const status = document.getElementById("menuImportStatus");
    button.disabled = true;
    button.textContent = "Importing…";
    try {
        const mode = document.getElementById("menuImportMode")?.value || "upsert";
        const result = await api("/menu/import", { method: "POST", body: JSON.stringify({ items: valid, mode }) });
        const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
        status.textContent = `${result.imported || 0} new items added · ${result.updated || 0} existing items updated · ${result.categoriesCreated || 0} new categor${result.categoriesCreated === 1 ? "y" : "ies"}${result.skipped?.length ? ` · ${result.skipped.length} rows skipped` : ""}${warnings ? ` · ${warnings} KOT station warning${warnings === 1 ? "" : "s"}` : ""}.`;
        await Promise.all([loadMenuManagement(), loadMenu(), loadMenuCategories()]);
        button.textContent = "Done";
        setTimeout(closeMenuImportModal, 900);
    } catch (error) {
        status.textContent = "Import failed: " + error.message;
        button.textContent = "Try import again";
        button.disabled = false;
    }
}

// ==========================================
// ACCESS MANAGEMENT

// ==========================================

const ACCESS_MODULES = [
    { key: "dashboard", label: "Dashboard" },
    { key: "orders", label: "Orders" },
    { key: "new_order", label: "New Orders" },
    { key: "reservations", label: "Reservations" },
    { key: "tables", label: "Tables" },
    { key: "kitchen", label: "Kitchen / KOT" },
    { key: "kot_groups", label: "KOT Groups" },
    { key: "menu", label: "Menu" },
    { key: "customers", label: "Customers" },
    { key: "payments", label: "Payments" },
    { key: "reports", label: "Reports" },
    { key: "settings", label: "Settings" },
    { key: "access", label: "Access" },
    { key: "expenses", label: "Expenses" },
    { key: "loyalty", label: "Loyalty" },
    { key: "marketing", label: "Marketing" },
    { key: "advanced_reports", label: "Advanced Reports" },
    { key: "printer", label: "Printer" }
];

const ACCESS_ACTIONS = ["view", "create", "edit", "delete", "export", "print"];

function accessPermissionKey(moduleKey, action) {
    return moduleKey + "." + action;
}

function defaultAccessPermissions() {
    const permissions = {};
    ACCESS_MODULES.forEach(function(mod) {
        ACCESS_ACTIONS.forEach(function(action) {
            permissions[accessPermissionKey(mod.key, action)] = false;
        });
    });
    permissions["orders.edit_open"] = true;
    permissions["orders.print_open"] = true;
    permissions["orders.edit_after_print"] = true;
    permissions["orders.edit_closed"] = false;
    permissions["orders.cancel_closed"] = false;
    permissions["dashboard.view"] = true;
    return permissions;
}

function normalizeAccessPermissions(permissions) {
    const result = defaultAccessPermissions();
    if (permissions && typeof permissions === "object") {
        Object.keys(result).forEach(function(key) {
            if (permissions[key] !== undefined) result[key] = Boolean(permissions[key]);
        });
    }
    if (permissions && permissions["orders.edit_closed"] !== undefined) result["orders.edit_closed"] = Boolean(permissions["orders.edit_closed"]);
    return result;
}

function profileBadge(profile) {
    return `<span class="access-profile-badge">${esc(profile?.name || "Unassigned")}</span>`;
}

async function loadAccess() {
    try {
        const result = await api("/access");
        accessUsers = Array.isArray(result.users) ? result.users : [];
        accessProfiles = Array.isArray(result.profiles) ? result.profiles : [];
        accessCanManageProfiles = result.canManageProfiles === true;
        accessCanCreateProfiles = result.canCreateProfiles === true;
        const profilesTab=document.getElementById("accessProfilesTab");
        const addProfileButton=document.querySelector("#accessProfilesPanel .access-toolbar .big-btn");
        if(profilesTab)profilesTab.hidden=!accessCanManageProfiles;
        if(addProfileButton)addProfileButton.hidden=!accessCanCreateProfiles;
        const scopeNote=document.getElementById("accessProfilesScopeNote");
        const roleName=String(result.currentProfileName||"").trim().toLocaleLowerCase();
        if(scopeNote){
            scopeNote.textContent=roleName==="admin"
                ? "You can view and change Manager and Cashier permissions."
                : roleName==="manager"
                    ? "You can view and change Cashier permissions."
                    : roleName==="slash ops"
                        ? "Manage access permissions across the business roles."
                        : "You can manage access profiles below your role.";
        }
        renderAccessUsers();
        renderAccessProfiles();
        populateAccessProfileSelect();
    } catch (error) {
        console.error("Access module failed:", error);
        alert("Failed to load Access module: " + error.message);
    }
}

function showAccessTab(tab) {
    const usersPanel = document.getElementById("accessUsersPanel");
    const profilesPanel = document.getElementById("accessProfilesPanel");
    const usersTab = document.getElementById("accessUsersTab");
    const profilesTab = document.getElementById("accessProfilesTab");
    const users = tab === "users" || !accessCanManageProfiles;
    if (usersPanel) usersPanel.style.display = users ? "block" : "none";
    if (profilesPanel) profilesPanel.style.display = users ? "none" : "block";
    if (usersTab) usersTab.classList.toggle("active", users);
    if (profilesTab) profilesTab.classList.toggle("active", !users);
}

function renderAccessUsers() {
    const body = document.getElementById("accessUsersBody");
    if (!body) return;
    body.innerHTML = "";
    if (!accessUsers.length) {
        body.innerHTML = '<tr><td colspan="7">No users found.</td></tr>';
        return;
    }
    accessUsers.forEach(function(user) {
        const tr = document.createElement("tr");
        const profileName = user.profile_name || "Unassigned";
        tr.innerHTML = `
            <td>${user.id}</td>
            <td>${esc(user.display_name)}</td>
            <td>${esc(user.username)}</td>
            <td>${profileBadge({name: profileName})}</td>
            <td><span class="access-status ${user.active ? "active" : "inactive"}">${user.active ? "Active" : "Inactive"}</span>${user.is_blocked ? '<br><span class="access-status blocked">Sign-in blocked</span>' : ""}</td>
            <td>${user.created_at ? formatPOSDateTime(user.created_at) : "-"}</td>
            <td>
                ${user.can_manage ? `
                <button onclick="editAccessUser(${user.id})">✏️ Edit</button>
                <button onclick="toggleAccessUser(${user.id}, ${user.active ? "false" : "true"})">${user.active ? "⏸️ Disable" : "▶️ Enable"}</button>
                <button onclick="toggleAccessUserBlock(${user.id}, ${user.is_blocked ? "false" : "true"})">${user.is_blocked ? "🔓 Unblock sign-in" : "🔒 Block sign-in"}</button>
                <button onclick="deleteAccessUser(${user.id})">🗑️ Delete</button>
                ` : '<span class="access-muted">You cannot manage users at your level or above.</span>'}
            </td>
        `;
        body.appendChild(tr);
    });
}

function renderAccessProfiles() {
    const container = document.getElementById("accessProfilesContainer");
    if (!container) return;
    container.innerHTML = "";
    if (!accessProfiles.length) {
        container.innerHTML = '<div class="settings-card">No access profiles found.</div>';
        return;
    }
    accessProfiles.forEach(function(profile) {
        const permissions = normalizeAccessPermissions(profile.permissions);
        const enabled = Object.keys(permissions).filter(k => permissions[k]).length;
        const card = document.createElement("div");
        card.className = "settings-card access-profile-card";
        card.innerHTML = `
            <div class="access-profile-card-head">
                <div>
                    <h3>${esc(profile.name)}</h3>
                    <p>${esc(profile.description || "")}</p>
                </div>
                <span class="access-count">${enabled} permissions</span>
            </div>
            <div class="access-summary-grid">
                ${ACCESS_MODULES.map(function(mod) {
                    const count = ACCESS_ACTIONS.filter(function(action) {
                        return Boolean(permissions[accessPermissionKey(mod.key, action)]);
                    }).length;
                    return `<div class="access-summary-item"><strong>${esc(mod.label)}</strong><span>${count}/${ACCESS_ACTIONS.length}</span></div>`;
                }).join("")}
            </div>
            ${profile.can_edit === true ? `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
                <button onclick="editAccessProfile(${profile.id})">✏️ Edit</button>
                ${profile.can_delete === true ? `<button onclick="deleteAccessProfile(${profile.id})">🗑️ Delete</button>` : ""}
            </div>` : ''}
        `;
        container.appendChild(card);
    });
}

function populateAccessProfileSelect(selectedId) {
    const select = document.getElementById("accessUserProfile");
    if (!select) return;
    const available=accessProfiles.filter(profile=>profile.can_assign===true);
    select.innerHTML = '<option value="">-- Choose access profile --</option>' + available.map(function(profile) {
        return `<option value="${profile.id}">${esc(profile.name)}</option>`;
    }).join("");
    if (selectedId !== undefined && selectedId !== null) select.value = String(selectedId);
}

function openAccessUserModal(user) {
    editingAccessUserId = user?.id || null;
    document.getElementById("accessUserModalTitle").textContent = editingAccessUserId ? "Edit User" : "Add User";
    document.getElementById("accessUserId").value = editingAccessUserId || "";
    document.getElementById("accessUserName").value = user?.display_name || "";
    document.getElementById("accessUsername").value = user?.username || "";
    document.getElementById("accessUserPassword").value = "";
    document.getElementById("accessUserActive").value = user?.active === false ? "false" : "true";
    populateAccessProfileSelect(user?.profile_id ?? "");
    document.getElementById("accessUserModal").style.display = "flex";
}

function closeAccessUserModal() {
    const modal = document.getElementById("accessUserModal");
    if (modal) modal.style.display = "none";
    editingAccessUserId = null;
}

async function saveAccessUser() {
    const displayName = document.getElementById("accessUserName").value.trim();
    const username = document.getElementById("accessUsername").value.trim();
    const profileIdValue = document.getElementById("accessUserProfile").value;
    const active = document.getElementById("accessUserActive").value === "true";
    const password = document.getElementById("accessUserPassword")?.value || "";
    if (!displayName || !username) return alert("Display name and username are required.");
    if (!editingAccessUserId && password.length < 6) return alert("Password must be at least 6 characters.");
    if (editingAccessUserId && password && password.length < 6) return alert("Password must be at least 6 characters.");
    try {
        const payload = {
            displayName,
            username,
            password,
            profileId: profileIdValue ? Number(profileIdValue) : null,
            active
        };
        if (editingAccessUserId) {
            await api(`/access/users/${editingAccessUserId}`, { method: "PUT", body: JSON.stringify(payload) });
        } else {
            await api("/access/users", { method: "POST", body: JSON.stringify(payload) });
        }
        closeAccessUserModal();
        await loadAccess();
    } catch (error) {
        alert(error.message);
    }
}

function editAccessUser(id) {
    const user = accessUsers.find(u => Number(u.id) === Number(id));
    if (user) openAccessUserModal(user);
}

async function toggleAccessUser(id, active) {
    try {
        await api(`/access/users/${id}`, { method: "PUT", body: JSON.stringify({ active: active === true || active === "true" }) });
        await loadAccess();
    } catch (error) {
        alert(error.message);
    }
}

async function toggleAccessUserBlock(id, blocked) {
    const nextBlocked = blocked === true || blocked === "true";
    try {
        await api(`/access/users/${id}/block`, { method: "PATCH", body: JSON.stringify({ blocked: nextBlocked }) });
        await loadAccess();
        showProfileToast(nextBlocked ? "User sign-in blocked." : "User sign-in unblocked.", true);
    } catch (error) {
        showProfileToast(error.message || "Could not update the user sign-in block.", true);
    }
}

async function deleteAccessUser(id) {
    if (!confirm("Delete this user?")) return;
    try {
        await api(`/access/users/${id}`, { method: "DELETE" });
        await loadAccess();
    } catch (error) {
        alert(error.message);
    }
}

function buildAccessPermissionEditor(permissions) {
    const container = document.getElementById("accessPermissionsEditor");
    if (!container) return;
    const normalized = normalizeAccessPermissions(permissions);
    container.innerHTML = ACCESS_MODULES.map(function(mod) {
        return `
            <div class="access-permission-row">
                <div class="access-module-name">${esc(mod.label)}</div>
                ${ACCESS_ACTIONS.map(function(action) {
                    const id = "perm_" + mod.key + "_" + action;
                    return `<label class="access-check"><input type="checkbox" id="${id}" data-permission-key="${accessPermissionKey(mod.key, action)}" ${normalized[accessPermissionKey(mod.key, action)] ? "checked" : ""}><span></span></label>`;
                }).join("")}
            </div>
        `;
    }).join("");
    const orderControls = document.getElementById("accessOrderPermissionEditor");
    if (orderControls) {
        const controls = [
            ["orders.edit_open", "Edit open orders"],
            ["orders.print_open", "Print open orders"],
            ["orders.edit_after_print", "Edit a bill after it has been printed"],
            ["orders.edit_closed", "Edit a closed bill"],
            ["orders.cancel_closed", "Cancel a closed order"]
        ];
        orderControls.innerHTML = controls.map(([key, label]) => `<label class="order-permission-check"><input type="checkbox" data-permission-key="${key}" ${normalized[key] ? "checked" : ""}><span>${label}</span></label>`).join("");
    }
}

function readAccessPermissionEditor() {
    const permissions = defaultAccessPermissions();
    document.querySelectorAll("#accessPermissionsEditor input[data-permission-key]").forEach(function(input) {
        permissions[input.dataset.permissionKey] = input.checked;
    });
    document.querySelectorAll("#accessOrderPermissionEditor input[data-permission-key]").forEach(function(input) {
        permissions[input.dataset.permissionKey] = input.checked;
    });
    return permissions;
}

function openAccessProfileModal(profile) {
    if (profile && profile.can_edit !== true) return;
    if (!profile && !accessCanCreateProfiles) return;
    editingAccessProfileId = profile?.id || null;
    document.getElementById("accessProfileModalTitle").textContent = editingAccessProfileId ? "Edit Access Profile" : "Add Access Profile";
    document.getElementById("accessProfileId").value = editingAccessProfileId || "";
    const nameInput = document.getElementById("accessProfileName");
    const descriptionInput = document.getElementById("accessProfileDescription");
    const identityNote = document.getElementById("accessProfileIdentityNote");
    nameInput.value = profile?.name || "";
    descriptionInput.value = profile?.description || "";
    const identityLocked = Boolean(profile) && profile.is_built_in === true;
    nameInput.readOnly = identityLocked || !accessCanCreateProfiles;
    descriptionInput.readOnly = identityLocked || !accessCanCreateProfiles;
    if (identityNote) identityNote.hidden = !identityLocked;
    buildAccessPermissionEditor(profile?.permissions || defaultAccessPermissions());
    document.getElementById("accessProfileModal").style.display = "flex";
}

function closeAccessProfileModal() {
    const modal = document.getElementById("accessProfileModal");
    if (modal) modal.style.display = "none";
    editingAccessProfileId = null;
}

async function saveAccessProfile() {
    if (editingAccessProfileId) {
        const profile = accessProfiles.find(item => Number(item.id) === Number(editingAccessProfileId));
        if (!profile || profile.can_edit !== true) return;
    } else if (!accessCanCreateProfiles) {
        return;
    }
    const name = document.getElementById("accessProfileName").value.trim();
    const description = document.getElementById("accessProfileDescription").value.trim();
    if (!name) return alert("Profile name is required.");
    try {
        const payload = { name, description, permissions: readAccessPermissionEditor() };
        if (editingAccessProfileId) {
            await api(`/access/profiles/${editingAccessProfileId}`, { method: "PUT", body: JSON.stringify(payload) });
        } else {
            await api("/access/profiles", { method: "POST", body: JSON.stringify(payload) });
        }
        closeAccessProfileModal();
        await loadAccess();
    } catch (error) {
        alert(error.message);
    }
}

function editAccessProfile(id) {
    const profile = accessProfiles.find(p => Number(p.id) === Number(id));
    if (profile?.can_edit === true) openAccessProfileModal(profile);
}

async function deleteAccessProfile(id) {
    const profile = accessProfiles.find(item => Number(item.id) === Number(id));
    if (!profile || profile.can_delete !== true) return;
    if (!confirm("Delete this access profile? Users assigned to it will become unassigned.")) return;
    try {
        await api(`/access/profiles/${id}`, { method: "DELETE" });
        await loadAccess();
    } catch (error) {
        alert(error.message);
    }
}

// ==========================================
// SETTINGS
// ==========================================

function setSettingValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = value ?? "";
}

function readSettingValue(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    return el.type === "checkbox" ? el.checked : el.value;
}

async function loadBillingAdjustments() {
    try {
        billingAdjustments = normalizeBillingAdjustments(await api("/billing-adjustments"));
        renderBillingAdjustmentSelectors();
    } catch (e) {
        console.warn("Billing adjustments unavailable:", e.message);
        billingAdjustments = [];
        renderBillingAdjustmentSelectors();
    }
}

function normalizeBillingAdjustments(items) {
    return (Array.isArray(items) ? items : []).map(item => ({
        ...item,
        kind: item.kind || item.type || "discount",
        calculation: item.calculation || (item.value_type === "percent" ? "percent" : "fixed"),
        applies_to: String(item.applies_to || "all").toLowerCase().replace(/[\s-]+/g, "_")
    }));
}

function renderBillingAdjustmentSelectors() {
    const discount = document.getElementById("billingDiscountSelect");
    const charge = document.getElementById("billingChargeSelect");
    const channel = currentSaleChannelKey();

    const visibleRule = x => {
        if (x.active === false) return false;
        const applies = String(x.applies_to || "all").toLowerCase();
        return applies === "all" || applies === channel;
    };

    if (discount) {
        const selected = discount.value;
        discount.innerHTML = `<option value="">No discount</option>` +
            marketingDeals.filter(deal => deal.active !== false).map(deal => {
                const unavailable = marketingDealUnavailableReason(deal);
                const offer = String(deal.type || "").trim().toLowerCase() === "discount"
                    ? (deal.valueType === "percentage" ? `${esc(deal.value)}%` : money(deal.value))
                    : esc(deal.type || "Marketing deal");
                const note = unavailable ? ` · ${esc(unavailable)}` : " · Marketing";
                return `<option value="marketing:${esc(deal.id)}" ${unavailable ? "disabled" : ""}>${esc(deal.name)} · ${offer}${note}</option>`;
            }).join("") +
            billingAdjustments.filter(x => x.kind === "discount" && visibleRule(x)).map(x =>
                `<option value="${x.id}">${esc(x.name)} · ${x.calculation === "percent" ? esc(x.value) + "%" : money(x.value)}</option>`
            ).join("");
        if ([...discount.options].some(o => o.value === selected)) discount.value = selected;
    }

    if (charge) {
        const selected = charge.value;
        charge.innerHTML = `<option value="">No charge</option>` +
            billingAdjustments.filter(x => x.kind === "charge" && visibleRule(x)).map(x =>
                `<option value="${x.id}">${esc(x.name)} · ${x.calculation === "percent" ? esc(x.value) + "%" : money(x.value)}</option>`
            ).join("");
        if ([...charge.options].some(o => o.value === selected)) charge.value = selected;
    }
    updateBill();
}

function openBillingAdjustmentsDialog(){
    updateBillingAdjustmentSummary();
    const dialog=document.getElementById("billingAdjustmentsDialog");
    if(dialog)dialog.style.display="flex";
}

function closeBillingAdjustmentsDialog(){document.getElementById("billingAdjustmentsDialog")?.style.setProperty("display","none");}

function clearBillingAdjustmentsDialog(){
    const discount=document.getElementById("billingDiscountSelect");
    const charge=document.getElementById("billingChargeSelect");
    if(discount)discount.value="";
    if(charge)charge.value="";
    updateCart();
    updateBillingAdjustmentSummary();
}

function updateBillingAdjustmentSummary(){
    const discountSelect=document.getElementById("billingDiscountSelect");
    const discountId=discountSelect?.value||"";
    const selectedDeal=discountId.startsWith("marketing:")
        ? marketingDeals.find(deal=>String(deal.id)===discountId.slice("marketing:".length))
        : null;
    const unavailableReason=selectedDeal?marketingDealUnavailableReason(selectedDeal):"";
    const eligibility=selectedDeal?marketingDealCartEligibility(selectedDeal):null;
    const discount=getSelectedBillingAdjustment(discountId);
    const charge=getSelectedBillingAdjustment(document.getElementById("billingChargeSelect")?.value||"");
    const dealSummary=selectedDeal
        ? (unavailableReason?`Unavailable: ${selectedDeal.name}`:eligibility?.eligible?`Discount: ${selectedDeal.name}`:`Deal criteria pending: ${selectedDeal.name}`)
        : discount?`Discount: ${discount.name}`:"";
    const summary=[dealSummary,charge?`Charge: ${charge.name}`:""].filter(Boolean).join(" · ")||"No adjustments selected";
    setText("billingAdjustmentsSummary",summary);
    const ruleText=rule=>rule?`${rule.name} · ${rule.calculation==="percent"||rule.valueType==="percentage"?`${Number(rule.value||0)}%`:money(rule.value)}`:"";
    const help=document.getElementById("billingDiscountRuleHelp");
    let helpText=discount?ruleText(discount):"No discount selected.";
    let helpState="";
    if(selectedDeal){
        if(unavailableReason){helpText=`Cannot apply this deal: ${unavailableReason}.`;helpState="is-warning";}
        else if(eligibility?.eligible){helpText="Eligible — all required items are in this order.";helpState="is-success";}
        else{helpText=`Not eligible yet. ${(eligibility?.messages||[]).join(" ")}`;helpState="is-warning";}
    }
    if(help){help.textContent=helpText;help.classList.toggle("is-warning",helpState==="is-warning");help.classList.toggle("is-success",helpState==="is-success");}
    setText("billingChargeRuleHelp",charge?ruleText(charge):"No charge selected.");
    const applyButton=document.getElementById("billingAdjustmentApplyButton");
    if(applyButton){
        const blocked=Boolean(selectedDeal&&(unavailableReason||!eligibility?.eligible));
        applyButton.disabled=blocked;
        applyButton.title=blocked?helpText:"";
        applyButton.textContent=blocked?"Add required items first":"Apply";
    }
    const breakdown=getBillingBreakdown();
    setText("billingAdjustmentDialogTotal",`Order total: ${money(breakdown.total)}`);
}


async function editOpenOrder(orderId) {
    try {
        const data = await api(`/orders/${orderId}`);
        try { data.paymentSummary = await api(`/orders/${orderId}/payment-summary`); }
        catch (_) { data.paymentSummary = null; }
        const status=String(data.order?.status||"").toLowerCase();
        const isClosed=status==='completed';
        const canEditClosed=isClosed&&(data.order?.bill_printed_at?hasPermission('orders','edit_after_print'):hasPermission('orders','edit_closed'));
        const canEditActive=!isClosed&&status!=='cancelled'&&(hasPermission('orders','edit_open')||hasPermission('orders','edit'));
        if(status==='cancelled'||(isClosed&&!canEditClosed)||(!isClosed&&!canEditActive))return alert(isClosed?'You do not have permission to edit this closed bill.':'You do not have permission to edit this open order.');
        currentOpenOrderId = orderId;
        currentOpenOrderData = data;
        cartItemCancellationReasons = [];
        cart = (data.items || []).map(item => ({
            id: item.menu_id || ("order-item-" + item.id),
            variantId: item.variant_id || null,
            cartKey: `${item.variant_id ? `${item.menu_id}:${item.variant_id}` : String(item.menu_id || item.id)}:${(item.options || []).flatMap(set => set.options || []).map(option => String(option.id)).sort().join(",")}`,
            name: item.item_name,
            price: Number(item.price),
            basePrice: Number(item.price)-((item.options||[]).flatMap(set=>set.options||[]).reduce((sum,option)=>sum+Number(option.price||0),0)),
            options: item.options || [],
            quantity: Number(item.quantity),
            orderItemId: Number(item.id),
            savedQuantity: Number(item.quantity),
            unit: item.unit || "ea",
            taxRate: Number(item.tax_rate ?? 5),
            taxMode: item.tax_mode === "inclusive" ? "inclusive" : "exclusive"
        }));
        orderType = data.order.order_type || "Dine-in";
        setOrderType(orderType);
        if (getSaleChannel(data.order.sales_channel_key)?.orderType === orderType) {
            selectedPOSChannelKey=data.order.sales_channel_key;
            renderBillingSaleChannelOptions();
            renderBillingAdjustmentSelectors();
            await loadMenu();
        }
        const table = document.getElementById("tableNumber");
        if (table) table.value = data.order.table_number || "";
        setBillingPaxForTable(data.order.table_number, data.order.pax || 1);
        const ds=document.getElementById("billingDiscountSelect");
        const cs=document.getElementById("billingChargeSelect");
        if(ds) ds.value=data.order.marketing_deal_id ? `marketing:${data.order.marketing_deal_id}` : data.order.discount_adjustment_id ? String(data.order.discount_adjustment_id) : "";
        if(cs) cs.value=data.order.charge_adjustment_id ? String(data.order.charge_adjustment_id) : "";
        const n=document.getElementById("billingCustomerNameQuick"); if(n)n.value=data.order.customer_name||"";
        const p=document.getElementById("billingCustomerPhoneQuick"); if(p)p.value=data.order.customer_phone||"";
        const e=document.getElementById("billingCustomerEmailQuick"); if(e)e.value=data.order.customer_email||"";
        fillBillingCustomerFields(data.order);
        const note=document.getElementById("billingOrderNotes"); if(note)note.value=data.order.notes||"";
        updateCart();
        const saveButton=document.getElementById('saveOrderBtn');if(saveButton)saveButton.textContent=status==='completed'?'💾 Save Bill Changes':'💾 Save Order';
        const orderBadge=document.getElementById('billingOrderState');if(orderBadge)orderBadge.textContent=status==='completed'?(data.order.bill_printed_at?'Editing printed bill':'Editing closed bill'):'Editing open order';
        showPage("new-order");
    } catch(e) {
        alert("Unable to edit open order: "+e.message);
    }
}

function openBillingAdjustmentModal(id=null) {
    const item=id?billingAdjustments.find(x=>Number(x.id)===Number(id)):null;
    document.getElementById("billingAdjustmentEditingId").value=item?.id||"";
    document.getElementById("billingAdjustmentName").value=item?.name||"";
    document.getElementById("billingAdjustmentKind").value=item?.kind||"discount";
    document.getElementById("billingAdjustmentCalculation").value=item?.calculation||"percent";
    document.getElementById("billingAdjustmentValue").value=item?.value??"";
    document.getElementById("billingAdjustmentModalTitle").textContent = item ? "Edit Discount / Charge" : "Create Discount / Charge";
    renderBillingAdjustmentAppliesOptions(item?.applies_to||"all");
    document.getElementById("billingAdjustmentDescription").value=item?.description||"";
    document.getElementById("billingAdjustmentModal").style.display="flex";
}

function closeBillingAdjustmentModal(){document.getElementById("billingAdjustmentModal")?.style.setProperty("display","none");}

function renderBillingAdjustmentAppliesOptions(selected="all"){
    const select=document.getElementById("billingAdjustmentApplies");
    if(!select)return;
    const key=String(selected||"all").toLowerCase().replace(/[\s-]+/g,"_");
    select.innerHTML='<option value="all">All Channels</option>'+POS_CHANNELS.map(channel=>`<option value="${esc(channel.key)}">${esc(channel.label)}</option>`).join("");
    select.value=[...select.options].some(option=>option.value===key)?key:"all";
}

async function saveBillingAdjustment(){
    const id=document.getElementById("billingAdjustmentEditingId")?.value;
    const payload={
        name:document.getElementById("billingAdjustmentName")?.value.trim(),
        type:document.getElementById("billingAdjustmentKind")?.value,
        valueType:document.getElementById("billingAdjustmentCalculation")?.value==="percent"?"percent":"amount",
        value:Number(document.getElementById("billingAdjustmentValue")?.value||0),
        appliesTo:document.getElementById("billingAdjustmentApplies")?.value||"all",
        description:document.getElementById("billingAdjustmentDescription")?.value.trim()||""
    };
    if(!payload.name||!Number.isFinite(payload.value)||payload.value<0)return alert("Enter a valid name and amount.");
    try{
        await api(id?`/billing-adjustments/${id}`:"/billing-adjustments",{method:id?"PUT":"POST",body:JSON.stringify(payload)});
        closeBillingAdjustmentModal();await loadBillingAdjustmentMaster();alert(id?"Adjustment updated successfully.":"Adjustment created successfully.");
    }catch(e){alert(e.message);}
}

async function loadBillingAdjustmentMaster() {
    try { billingAdjustments = normalizeBillingAdjustments(await api("/billing-adjustments")); renderBillingAdjustmentMaster(); renderBillingAdjustmentSelectors(); }
    catch (e) { console.error("Adjustment master load failed:", e); }
}

function renderBillingAdjustmentMaster() {
    const body=document.getElementById("billingAdjustmentsBody");
    if(!body)return;
    body.innerHTML=billingAdjustments.length ? billingAdjustments.map(x=>`
        <tr>
            <td><strong>${esc(x.name)}</strong><br><small>${esc(x.description||"")}</small></td>
            <td>${x.kind==="discount"?"Discount":"Charge"}</td>
            <td>${x.calculation==="percent"?esc(x.value)+"%":money(x.value)}</td>
            <td>${esc(x.applies_to==="all"?"All Channels":getSaleChannel(x.applies_to)?.label||x.applies_to)}</td>
            <td><span class="adjustment-status ${x.active?"active":"inactive"}">${x.active?"Active":"Inactive"}</span></td>
            <td class="table-actions">
                <button onclick="openBillingAdjustmentModal(${x.id})">✏️ Edit</button>
                <button onclick="toggleBillingAdjustment(${x.id})">${x.active?"Disable":"Enable"}</button>
                <button onclick="deleteBillingAdjustment(${x.id})">🗑️ Delete</button>
            </td>
        </tr>`).join("") : `<tr><td colspan="6" class="empty">No discounts or charges created yet.</td></tr>`;
}

async function toggleBillingAdjustment(id){try{await api(`/billing-adjustments/${id}/toggle`,{method:"PUT"});await loadBillingAdjustmentMaster();}catch(e){alert(e.message);}}

async function deleteBillingAdjustment(id){if(!confirm("Delete this discount/charge?"))return;try{await api(`/billing-adjustments/${id}`,{method:"DELETE"});await loadBillingAdjustmentMaster();}catch(e){alert(e.message);}}


function showMarketingSection(section) {
    const promotions = document.getElementById("marketingPromotionsPanel");
    const loyalty = document.getElementById("loyalty");
    const prompt = document.getElementById("marketingSectionPrompt");
    const promotionsCard = document.getElementById("marketingPromotionsFeatureCard");
    const loyaltyCard = document.getElementById("marketingLoyaltyFeatureCard");
    if (section === "loyalty" && (!hasPermission("loyalty", "view") || !loyalty || !loyaltyCard || loyaltyCard.hidden)) return;
    const showPromotions = section === "promotions";
    if (!showPromotions && section !== "loyalty") return;
    if (promotions) promotions.hidden = !showPromotions;
    if (loyalty) loyalty.hidden = showPromotions;
    if (prompt) prompt.hidden = true;
    if (promotionsCard) {
        promotionsCard.classList.toggle("is-active", showPromotions);
        promotionsCard.setAttribute("aria-expanded", String(showPromotions));
    }
    if (loyaltyCard) {
        loyaltyCard.classList.toggle("is-active", !showPromotions);
        loyaltyCard.setAttribute("aria-expanded", String(!showPromotions));
    }
    const panel = showPromotions ? promotions : loyalty;
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
}
let marketingPushCampaigns = [];
let marketingPushConfig = null;
async function loadMarketingPushCampaigns() {
    const list=document.getElementById("marketingPushCampaigns"), status=document.getElementById("marketingPushStatus"), create=document.getElementById("marketingPushCreateButton");
    if(!list||!status)return;
    try {
        const [settings,history]=await Promise.all([api("/marketing/push-settings"),api("/marketing/push-campaigns")]);
        marketingPushConfig=settings||{};marketingPushCampaigns=Array.isArray(history.campaigns)?history.campaigns:[];
        const subscriberCount=Number(settings.subscriberCount||0);
        const ready=settings.configured&&settings.menuEnabled;
        status.textContent=!settings.configured?"Push sending is unavailable because web push delivery is not configured on this POS server.":!settings.menuEnabled?"Publish the Table QR menu before collecting subscribers or sending messages.":subscriberCount===0?"The QR menu is published, but no guests have subscribed yet. Invite guests to tap Get offers on the QR menu.":subscriberCount+" guest device(s) subscribed. You can create a message.";
        if(create){create.disabled=!ready||subscriberCount===0;create.title=!settings.configured?"Web push delivery is not configured on this POS server.":!settings.menuEnabled?"Publish the Table QR menu first.":subscriberCount===0?"Invite guests to subscribe from the QR menu first.":"";}
        renderMarketingPushCampaigns();
    } catch(error) { marketingPushCampaigns=[];status.textContent="Could not load notification setup: "+error.message;if(create)create.disabled=true;list.innerHTML='<div class="marketing-empty-state">Notification setup is unavailable.</div>'; }
}
function renderMarketingPushCampaigns(){const list=document.getElementById("marketingPushCampaigns");if(!list)return;if(!marketingPushCampaigns.length){list.innerHTML='<div class="marketing-empty-state">No customer messages have been sent yet.</div>';return;}list.innerHTML=marketingPushCampaigns.map(c=>{const date=c.sent_at||c.created_at;return `<article class="marketing-push-card"><div class="marketing-push-card-top"><span>${esc(String(c.status||"sent").toUpperCase())}</span><span>${date?esc(formatPOSDateTime(date)):""}</span></div><h4>${esc(c.title||"Promotion")}</h4><p>${esc(c.message||"")}</p><small>Sent ${Number(c.sent_count||0)} - Failed ${Number(c.failed_count||0)} - Audience ${Number(c.subscriber_count||0)}</small><button type="button" class="table-action-btn" onclick="deleteMarketingPushCampaign(${Number(c.id)})">Delete message</button></article>`;}).join("");}
async function deleteMarketingPushCampaign(id){if(!Number.isInteger(Number(id))||!confirm("Delete this notification message from your history?"))return;try{await api(`/marketing/push-campaigns/${Number(id)}`,{method:"DELETE"});marketingPushCampaigns=marketingPushCampaigns.filter(c=>Number(c.id)!==Number(id));renderMarketingPushCampaigns();showProfileToast("Notification message deleted.");}catch(error){alert(error.message||"Could not delete the notification message.");}}
function openMarketingPushForm(){if(!marketingPushConfig?.configured){alert("Web push delivery is not configured on this POS server. Ask your POS administrator to enable it.");return;}if(!marketingPushConfig?.menuEnabled){alert("Publish the Table QR menu before sending a message.");return;}if(!Number(marketingPushConfig?.subscriberCount||0)){alert("No guests have subscribed yet. Invite guests to tap Get offers on the QR menu.");return;}document.getElementById("marketingPushTitle").value="";document.getElementById("marketingPushMessage").value="";document.getElementById("marketingPushFormStatus").textContent="";const button=document.getElementById("marketingPushSendButton");button.disabled=false;button.textContent="Send to subscribers";document.getElementById("marketingPushModal").style.display="flex";}
function closeMarketingPushForm(){document.getElementById("marketingPushModal")?.style.setProperty("display","none");}
async function sendMarketingPushCampaign(){const title=document.getElementById("marketingPushTitle").value.trim(),message=document.getElementById("marketingPushMessage").value.trim(),button=document.getElementById("marketingPushSendButton"),status=document.getElementById("marketingPushFormStatus");if(!title||!message){status.textContent="Add a title and message first.";return;}button.disabled=true;button.textContent="Sending...";status.textContent="Sending to subscribed devices...";try{const result=await api("/marketing/push-campaigns",{method:"POST",body:JSON.stringify({title,message})});status.textContent=result.message||"Message sent.";await loadMarketingPushCampaigns();button.textContent="Sent";setTimeout(closeMarketingPushForm,900);}catch(error){status.textContent=error.message||"Could not send this message.";button.disabled=false;button.textContent="Try again";}}

let marketingDeals = [];
let editingMarketingDealId = null;
const MARKETING_DEAL_TYPES = ["Discount", "Buy X", "Buy X Get X", "Buy X Get Y", "Voucher", "Payment Deals", "Meal Deals", "Slab-Based Discount"];
const MARKETING_WEEKDAYS = [
    { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
    { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" }
];

async function loadMarketingDeals() {
    const grid = document.getElementById("marketingDealsGrid");
    if (grid) grid.innerHTML = '<div class="marketing-empty-state">Loading deals…</div>';
    try {
        const result = await api("/marketing/deals");
        marketingDeals = Array.isArray(result.deals) ? result.deals : [];
        renderMarketingDeals();
        renderBillingAdjustmentSelectors();
    } catch (error) {
        marketingDeals = [];
        renderBillingAdjustmentSelectors();
        if (grid) grid.innerHTML = `<div class="marketing-empty-state">Unable to load deals: ${esc(error.message)}</div>`;
    }
}
function renderMarketingDeals() {
    const grid = document.getElementById("marketingDealsGrid");
    if (!grid) return;
    const term = String(document.getElementById("marketingDealSearch")?.value || "").trim().toLowerCase();
    const type = document.getElementById("marketingDealTypeFilter")?.value || "";
    const shown = marketingDeals.filter(deal => (!term || `${deal.name || ""} ${deal.type || ""} ${deal.category || ""}`.toLowerCase().includes(term)) && (!type || deal.type === type));
    const activeCount = document.getElementById("marketingActiveCount");
    if (activeCount) activeCount.textContent = String(marketingDeals.filter(deal => deal.active !== false).length);
    const channelCount = document.getElementById("marketingChannelCount");
    if (channelCount) channelCount.textContent = String(new Set(marketingDeals.flatMap(deal => deal.channels || [])).size || POS_CHANNELS.length);
    if (!shown.length) {
        grid.innerHTML = `<div class="marketing-empty-state">${marketingDeals.length ? "No deals match those filters." : "No deals created yet. Create a deal to get started."}</div>`;
        return;
    }
    grid.innerHTML = shown.map(deal => {
        const schedule = [deal.startDate, deal.endDate].filter(Boolean).join(" – ") || "No date limit";
        const dealDays = Array.isArray(deal.days) && deal.days.length ? deal.days : MARKETING_WEEKDAYS.map(day => day.key);
        const daySummary = dealDays.length === 7 ? "Every day" : MARKETING_WEEKDAYS.filter(day => dealDays.includes(day.key)).map(day => day.label).join(", ");
        const hourSummary = deal.startTime && deal.endTime ? deal.startTime + "–" + deal.endTime : "All day";
        const offer = deal.type && deal.type.startsWith("Buy") ? `Buy ${Number(deal.buyQuantity || 1)} · Get ${Number(deal.getQuantity || 1)}` : deal.value ? `${deal.valueType === "percentage" ? `${deal.value}% off` : money(deal.value)}` : "Custom offer";
        const channels = (deal.channels || []).map(key => POS_CHANNELS.find(channel => channel.key === key)?.label).filter(Boolean).join(", ") || "All channels";
        const itemSummary=deal.itemName||(deal.itemNames||[]).join(", ");
        const safeDealId = esc(JSON.stringify(String(deal.id || "")));
        return `<article class="marketing-deal-card ${deal.active === false ? "inactive" : ""}"><div class="marketing-deal-card-top"><span class="marketing-deal-type">${esc(deal.type || "Deal")}</span><span class="marketing-deal-status">${deal.active === false ? "Inactive" : "Active"}</span></div><h3>${esc(deal.name || "Untitled deal")}</h3><p>${esc(deal.category || "All categories")}${itemSummary ? ` · ${esc(itemSummary)}` : ""}</p><div class="marketing-deal-offer">${esc(offer)}</div><div class="marketing-deal-meta"><span>📅 ${esc(schedule)}</span><span>🗓️ ${esc(daySummary)} · ${esc(hourSummary)}</span><span>🛒 ${esc(channels)}</span></div><div class="marketing-deal-actions"><button type="button" onclick="openMarketingDealForm(${safeDealId})">Edit</button><button type="button" onclick="toggleMarketingDeal(${safeDealId})">${deal.active === false ? "Enable" : "Disable"}</button><button type="button" onclick="deleteMarketingDeal(${safeDealId})">Delete</button></div></article>`;
    }).join("");
}
function populateMarketingDealOptions(selected = {}) {
    const categories = [...new Set(currentMenu.map(item => String(item.category || "").trim()).filter(Boolean))].sort();
    const categorySelect = document.getElementById("marketingDealCategory");
    if (categorySelect) categorySelect.innerHTML = '<option value="">All categories</option>' + categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join("");
    const itemSelect = document.getElementById("marketingDealItem");
    const rewardSelect = document.getElementById("marketingRewardItem");
    const previouslySelected = new Set([...((itemSelect?.selectedOptions)||[])].map(option=>option.value));
    const category = Object.prototype.hasOwnProperty.call(selected,"category")
        ? String(selected.category || "")
        : String(categorySelect?.value || "");
    const eligibleItems = category
        ? currentMenu.filter(item => String(item.category || "").trim().toLowerCase() === category.trim().toLowerCase())
        : currentMenu;
    const selectedIds = selected.itemIds || (selected.itemId ? [selected.itemId] : null) || [...previouslySelected];
    const chosen = new Set(selectedIds.map(String));
    if (itemSelect) {
        itemSelect.innerHTML = eligibleItems.map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.category||"Uncategorized")}</option>`).join("");
        [...itemSelect.options].forEach(option=>option.selected=chosen.has(option.value));
    }
    if (rewardSelect) {
        const previousReward = selected.rewardItemId || rewardSelect.value || "";
        rewardSelect.innerHTML = '<option value="">Same item</option>' + eligibleItems.map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.category||"Uncategorized")}</option>`).join("");
        rewardSelect.value = eligibleItems.some(item => String(item.id) === String(previousReward)) ? String(previousReward) : "";
    }
    if (categorySelect) categorySelect.value = category;
}
async function openMarketingDealForm(id = null) {
    if (!currentMenu.length) {
        try { currentMenu = await api("/menu"); }
        catch (error) { alert("Could not load menu items for this deal: " + error.message); return; }
    }
    editingMarketingDealId = id;
    const deal = id === null ? null : marketingDeals.find(item => String(item.id) === String(id));
    document.getElementById("marketingDealModalTitle").textContent = deal ? "Edit Deal" : "Create Deal";
    document.getElementById("marketingDealName").value = deal?.name || "";
    document.getElementById("marketingDealDescription").value = deal?.description || "";
    document.getElementById("marketingDealType").value = deal?.type || "Discount";
    populateMarketingDealOptions(deal || {category:"",itemIds:[]});
    document.getElementById("marketingBuyQuantity").value = deal?.buyQuantity || 1;
    document.getElementById("marketingGetQuantity").value = deal?.getQuantity || 1;
    document.getElementById("marketingValueType").value = deal?.valueType || "amount";
    document.getElementById("marketingDealValue").value = deal?.value ?? "";
    document.getElementById("marketingDealStart").value = deal?.startDate || "";
    document.getElementById("marketingDealEnd").value = deal?.endDate || "";
    document.getElementById("marketingDealStartTime").value = deal?.startTime || "";
    document.getElementById("marketingDealEndTime").value = deal?.endTime || "";
    const selectedDays = new Set(Array.isArray(deal?.days) && deal.days.length ? deal.days : MARKETING_WEEKDAYS.map(day => day.key));
    const daysBox = document.getElementById("marketingDealDays");
    if (daysBox) daysBox.innerHTML = MARKETING_WEEKDAYS.map(day => `<label><input type="checkbox" value="${day.key}" ${selectedDays.has(day.key) ? "checked" : ""}>${day.label}</label>`).join("");
    document.getElementById("marketingMaxOccurrences").value = deal?.maxOccurrences ?? "";
    document.getElementById("marketingMinGroupSize").value = deal?.minGroupSize ?? "";
    document.getElementById("marketingRecurringPeriod").value = deal?.recurringPeriod || "None";
    const selectedChannels = new Set(deal?.channels || POS_CHANNELS.map(channel => channel.key));
    const channelBox = document.getElementById("marketingDealChannels");
    if (channelBox) channelBox.innerHTML = POS_CHANNELS.map(channel => `<label><input type="checkbox" value="${channel.key}" ${selectedChannels.has(channel.key) ? "checked" : ""}>${esc(channel.label)}</label>`).join("");
    document.getElementById("marketingForNewCustomers").checked = Boolean(deal?.forNewCustomers);
    document.getElementById("marketingUseMembership").checked = Boolean(deal?.useMembership);
    document.getElementById("marketingRequireAuthentication").checked = Boolean(deal?.requireAuthentication);
    document.getElementById("marketingEnforceAtCheckout").checked = Boolean(deal?.enforceAtCheckout);
    updateMarketingDealFields();
    document.getElementById("marketingDealModal").style.display = "flex";
}
function closeMarketingDealForm() { document.getElementById("marketingDealModal")?.style.setProperty("display", "none"); }
function updateMarketingDealFields() {
    const type = document.getElementById("marketingDealType")?.value || "Discount";
    const buy = type.startsWith("Buy");
    const get = type.includes("Get") || type === "Meal Deals";
    document.getElementById("marketingBuyQuantityField").style.display = buy ? "" : "none";
    document.getElementById("marketingGetQuantityField").style.display = get ? "" : "none";
    document.getElementById("marketingRewardItemField").style.display = (type === "Buy X Get Y" || type === "Meal Deals") ? "" : "none";
}
async function saveMarketingDeal() {
    const name = document.getElementById("marketingDealName").value.trim();
    if (!name) return alert("Enter a name for this deal.");
    const type = document.getElementById("marketingDealType").value;
    if (!MARKETING_DEAL_TYPES.includes(type)) return alert("Choose a valid deal type.");
    const selectedDays = [...document.querySelectorAll("#marketingDealDays input:checked")].map(input => input.value);
    if (!selectedDays.length) return alert("Choose at least one deal day.");
    const startTime = document.getElementById("marketingDealStartTime").value || null;
    const endTime = document.getElementById("marketingDealEndTime").value || null;
    if (Boolean(startTime) !== Boolean(endTime)) return alert("Set both the start and end time, or leave both empty for all-day deals.");
    if (startTime && startTime === endTime) return alert("Deal start and end times must be different.");
    const prior = editingMarketingDealId === null ? null : marketingDeals.find(item => String(item.id) === String(editingMarketingDealId));
    const selectedItemIds=[...document.getElementById("marketingDealItem").selectedOptions].map(option=>option.value).filter(Boolean);
    const selectedItems=currentMenu.filter(item=>selectedItemIds.includes(String(item.id)));
    const deal = {
        id: prior?.id || String(Date.now()), name, description: document.getElementById("marketingDealDescription").value.trim().slice(0, 240), type,
        category: document.getElementById("marketingDealCategory").value,
        itemIds: selectedItemIds,
        itemNames: selectedItems.map(item=>item.name),
        itemId: selectedItemIds[0] || null,
        itemName: selectedItems.map(item=>item.name).join(", "),
        buyQuantity: Math.max(1, Number(document.getElementById("marketingBuyQuantity").value || 1)),
        getQuantity: Math.max(1, Number(document.getElementById("marketingGetQuantity").value || 1)),
        rewardItemId: document.getElementById("marketingRewardItem").value || null,
        valueType: document.getElementById("marketingValueType").value,
        value: Math.max(0, Number(document.getElementById("marketingDealValue").value || 0)),
        startDate: document.getElementById("marketingDealStart").value || null,
        endDate: document.getElementById("marketingDealEnd").value || null,
        days: selectedDays,
        startTime,
        endTime,
        maxOccurrences: Number(document.getElementById("marketingMaxOccurrences").value || 0) || null,
        minGroupSize: Number(document.getElementById("marketingMinGroupSize").value || 0) || null,
        recurringPeriod: document.getElementById("marketingRecurringPeriod").value,
        channels: [...document.querySelectorAll("#marketingDealChannels input:checked")].map(input => input.value),
        forNewCustomers: document.getElementById("marketingForNewCustomers").checked,
        useMembership: document.getElementById("marketingUseMembership").checked,
        requireAuthentication: document.getElementById("marketingRequireAuthentication").checked,
        enforceAtCheckout: document.getElementById("marketingEnforceAtCheckout").checked,
        active: prior?.active !== false
    };
    const next = marketingDeals.filter(item => String(item.id) !== String(deal.id)).concat(deal);
    try {
        await api("/marketing/deals", { method: "PUT", body: JSON.stringify({ deals: next }) });
        marketingDeals = next;
        closeMarketingDealForm();
        renderMarketingDeals();
        renderBillingAdjustmentSelectors();
        showProfileToast("Deal saved.");
    } catch (error) { alert("Could not save deal: " + error.message); }
}
async function toggleMarketingDeal(id) {
    const next = marketingDeals.map(deal => String(deal.id) === String(id) ? { ...deal, active: deal.active === false } : deal);
    try { await api("/marketing/deals", { method: "PUT", body: JSON.stringify({ deals: next }) }); marketingDeals = next; renderMarketingDeals(); renderBillingAdjustmentSelectors(); }
    catch (error) { alert(error.message); }
}
async function deleteMarketingDeal(id) {
    if (!confirm("Delete this deal?")) return;
    const next = marketingDeals.filter(deal => String(deal.id) !== String(id));
    try { await api("/marketing/deals", { method: "PUT", body: JSON.stringify({ deals: next }) }); marketingDeals = next; renderMarketingDeals(); renderBillingAdjustmentSelectors(); }
    catch (error) { alert(error.message); }
}
async function selectBillingTable(tableNumber, status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized !== "available" && normalized !== "occupied") return;
    const input = document.getElementById("tableNumber");
    if (input) input.value = tableNumber;

    if (normalized === "occupied") {
        try {
            const orders = await api("/orders");
            const active = orders
                .filter(order => String(order.table_number) === String(tableNumber))
                .filter(order => !["completed", "cancelled"].includes(String(order.status || "").toLowerCase()))
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
            if (!active) return alert("Table " + tableNumber + " is occupied, but no active order was found.");
            if (hasPermission("orders", "edit_open") || hasPermission("orders", "edit")) {
                await editOpenOrder(active.id);
                return;
            }
            if (!hasPermission("orders", "view")) return alert("You do not have permission to open this table order.");
            showPage("orders");
            window.currentOrdersTab = "open";
            const statusFilter = document.getElementById("ordersStatusFilter");
            if (statusFilter) statusFilter.value = "";
            await updateOrdersTable(true, false);
            await viewOrder(active.id);
            return;
        } catch (error) {
            return alert("Unable to open the table order: " + error.message);
        }
    }

    selectedPOSChannelKey = getPOSChannelPreferences().tableView.defaultChannel;
    setOrderType("Dine-in", true);
    setBillingPaxForTable(tableNumber, document.getElementById("billingPax")?.value || 1);
    updateBillingTableSelection();
    showPage("new-order");
    await loadMenu();
}
function updateBillingTableSelection() {
    const selected = document.getElementById("tableNumber")?.value || "";
    document.querySelectorAll(".billing-table-card").forEach(btn => {
        btn.classList.toggle("selected", btn.querySelector(".billing-table-number")?.textContent === selected);
    });
}

function renderPOSPreferences() {
    const container = document.getElementById("posPreferencesRows");
    if (!container) return;
    const preferences = getPOSChannelPreferences();
    const modules = [{ key: "newOrder", label: "Take New Order" }, { key: "tableView", label: "Table View" }];
    container.innerHTML = modules.map(module => {
        const settings = preferences[module.key];
        const checks = POS_CHANNELS.map(channel => {
            const id = "posChannel_" + module.key + "_" + channel.key;
            return "<label class=\"pos-channel-check\" for=\"" + id + "\"><input id=\"" + id + "\" data-pos-module=\"" + module.key + "\" data-pos-channel=\"" + channel.key + "\" type=\"checkbox\" " + (settings.channels.includes(channel.key) ? "checked" : "") + " onchange=\"updatePOSDefaultOptions('" + module.key + "')\"><span>" + esc(channel.label) + "</span></label>";
        }).join("");
        const options = settings.channels.map(key => {
            const channel = POS_CHANNELS.find(entry => entry.key === key);
            return channel ? "<option value=\"" + esc(key) + "\">" + esc(channel.label) + "</option>" : "";
        }).join("");
        return "<div class=\"pos-preferences-row\"><strong>" + esc(module.label) + "</strong><div class=\"pos-channel-checks\">" + checks + "</div><select id=\"posDefault_" + module.key + "\" aria-label=\"" + esc(module.label) + " default channel\">" + options + "</select></div>";
    }).join("");
}
function renderCustomerInfoRequirements() {
    const container = document.getElementById("customerInfoRequirementsRows");
    if (!container) return;
    const requirements = normalizeCustomerInfoRequirements();
    container.innerHTML = POS_CHANNELS.map(channel => `
        <div class="customer-info-requirement-row">
            <div class="customer-info-requirement-channel"><span class="customer-info-channel-icon" aria-hidden="true">${channel.qrMenu ? "⌁" : channel.orderType === "Dine-in" ? "⌂" : "↗"}</span><div><strong>${esc(channel.label)}</strong><small>${channel.qrMenu ? "Guest QR orders" : channel.orderType === "Dine-in" ? "Dine-in billing" : "Takeaway / delivery billing"}</small></div></div>
            <label class="customer-info-requirement-control" for="customerInfoRequirement_${esc(channel.key)}"><span>Customer details</span><select id="customerInfoRequirement_${esc(channel.key)}" aria-label="Customer information requirement for ${esc(channel.label)}"><option value="optional" ${requirements[channel.key] === "optional" ? "selected" : ""}>Optional</option><option value="required" ${requirements[channel.key] === "required" ? "selected" : ""}>Required</option></select></label>
        </div>`).join("") || '<p class="access-muted">Add a sale channel to configure its customer information requirement.</p>';
}
function readCustomerInfoRequirementsFromForm() {
    return Object.fromEntries(POS_CHANNELS.map(channel => [
        channel.key,
        document.getElementById("customerInfoRequirement_" + channel.key)?.value === "required" ? "required" : "optional"
    ]));
}
function renderSalesChannels() {
    const list = document.getElementById("salesChannelsList");
    if (!list) return;
    list.innerHTML = POS_CHANNELS.map(channel => {const isBuiltIn=BUILT_IN_POS_CHANNEL_KEYS.has(channel.key);return `<article class="sales-channel-card">
        <div class="sales-channel-card-top"><div><h4>${esc(channel.label)}</h4><p>${channel.orderType === "Dine-in" ? "Dine-in / table flow" : "Takeaway / delivery flow"}</p></div><span class="sales-channel-badge">${channel.qrMenu ? "QR Menu" : "POS channel"}</span></div>
        ${isBuiltIn?'<div class="sales-channel-protected">Built-in channel · name and settings are protected</div>':`<div class="sales-channel-actions"><button type="button" onclick="openSalesChannelModal('${esc(channel.key)}')">Edit</button><button type="button" onclick="deleteSalesChannel('${esc(channel.key)}')">Delete</button></div>`}
    </article>`;}).join("");
}
function openSalesChannelModal(key = "") {
    const channel = getSaleChannel(key);
    if(channel&&BUILT_IN_POS_CHANNEL_KEYS.has(channel.key)){showProfileToast("Built-in sale channels are protected.");return;}
    document.getElementById("salesChannelEditingKey").value = channel?.key || "";
    document.getElementById("salesChannelModalTitle").textContent = channel ? "Edit sale channel" : "Create sale channel";
    const nameInput = document.getElementById("salesChannelName");
    nameInput.value = channel?.label || "";
    const isBuiltInChannel = ["dine_in", "takeaway", "delivery", "online"].includes(channel?.key);
    nameInput.readOnly = isBuiltInChannel;
    nameInput.title = isBuiltInChannel ? "Built-in channel names are fixed." : "";
    const type = document.getElementById("salesChannelOrderType");
    type.value = channel?.orderType || "Takeaway";
    type.disabled = false;
    document.getElementById("salesChannelQrMenu").checked = channel?.qrMenu === true;
    document.getElementById("salesChannelModal").style.display = "flex";
}
function closeSalesChannelModal() { document.getElementById("salesChannelModal")?.style.setProperty("display", "none"); }
function salesChannelKeyFromLabel(label) {
    let key = String(label || "").trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!/^[a-z]/.test(key)) key = "channel_" + key;
    return key.slice(0, 20);
}
async function persistSalesChannels(nextChannels) {
    const response = await api("/settings/sales-channels", { method: "PUT", body: JSON.stringify({ channels: nextChannels }) });
    if (response.settings) appSettings = { ...appSettings, ...response.settings };
    else appSettings.posSalesChannels = response.channels || nextChannels;
    delete appSettings.publicMenuHeroImages;
    syncPOSChannelsFromSettings();
    appSettings.posChannelPreferences = normalizePOSChannelPreferences(appSettings.posChannelPreferences);
    if (!getSaleChannel(selectedPOSChannelKey) || getSaleChannel(selectedPOSChannelKey).orderType !== orderType) {
        selectedPOSChannelKey = getPOSChannelPreferences()[orderType === "Dine-in" ? "tableView" : "newOrder"].defaultChannel;
    }
    renderSalesChannels();
    renderPOSPreferences();
    renderCustomerInfoRequirements();
    renderBillingSaleChannelOptions();
    renderBillingAdjustmentAppliesOptions();
    renderBillingAdjustmentSelectors();
    if (response.marketingDeals) marketingDeals = response.marketingDeals;
    await loadMenu();
    await loadMenuManagement();
    renderMarketingDeals();
    localStorage.setItem(settingsLocalStorageKey(), JSON.stringify(appSettings));
}
async function saveSalesChannel() {
    const editingKey = document.getElementById("salesChannelEditingKey").value;
    if(editingKey&&BUILT_IN_POS_CHANNEL_KEYS.has(editingKey)){showProfileToast("Built-in sale channels are protected.");return;}
    const label = document.getElementById("salesChannelName").value.trim();
    const orderType = document.getElementById("salesChannelOrderType").value;
    const qrMenu = document.getElementById("salesChannelQrMenu").checked;
    if (!label || !["Dine-in", "Takeaway"].includes(orderType)) return alert("Enter a channel name and choose its order flow.");
    let key = editingKey || salesChannelKeyFromLabel(label);
    if (!editingKey) {
        if (!key) return alert("Enter a channel name that includes letters or numbers.");
        if (POS_CHANNELS.some(channel => channel.key === key)) key = `${key.slice(0, 14)}_${Date.now().toString(36).slice(-5)}`;
    }
    const next = editingKey
        ? POS_CHANNELS.map(channel => channel.key === editingKey ? { ...channel, label, orderType, qrMenu } : channel)
        : [...POS_CHANNELS, { key, label, orderType, qrMenu }];
    if (!next.some(channel => channel.orderType === "Dine-in") || !next.some(channel => channel.orderType === "Takeaway")) return alert("Keep at least one Dine-in channel and one Takeaway / delivery channel active.");
    if (!next.some(channel => channel.qrMenu)) return alert("Keep at least one channel connected to the QR Menu.");
    try { closeSalesChannelModal(); await persistSalesChannels(next); showProfileToast("Sale channel saved and applied."); }
    catch (error) { alert(error.message || "Could not save the sale channel."); }
}
async function deleteSalesChannel(key) {
    const channel = getSaleChannel(key);
    if (!channel) return;
    if(BUILT_IN_POS_CHANNEL_KEYS.has(channel.key)){showProfileToast("Built-in sale channels cannot be deleted.");return;}
    if (!confirm(`Remove ${channel.label}? Items, discounts and deals assigned only to this channel will no longer be available there.`)) return;
    const next = POS_CHANNELS.filter(entry => entry.key !== key);
    if (!next.some(entry => entry.orderType === "Dine-in") || !next.some(entry => entry.orderType === "Takeaway")) return alert("Keep at least one Dine-in channel and one Takeaway / delivery channel active.");
    if (!next.some(entry => entry.qrMenu)) return alert("Connect another sale channel to the QR Menu before deleting this one.");
    try { await persistSalesChannels(next); showProfileToast("Sale channel removed."); }
    catch (error) { alert(error.message || "Could not remove the sale channel."); }
}
function updatePOSDefaultOptions(moduleKey) {
    const selected = [...document.querySelectorAll("[data-pos-module=\"" + moduleKey + "\"]:checked")].map(input => input.dataset.posChannel);
    if (moduleKey === "newOrder" && !selected.some(key => getSaleChannel(key)?.orderType === "Takeaway")) {
        const fallbackKey = POS_CHANNELS.find(channel => channel.orderType === "Takeaway")?.key;
        const fallback = document.getElementById("posChannel_newOrder_" + fallbackKey);
        if (fallback) fallback.checked = true;
        if (fallbackKey && !selected.includes(fallbackKey)) selected.push(fallbackKey);
    }
    if (!selected.length) {
        const fallbackType = moduleKey === "tableView" ? "Dine-in" : "Takeaway";
        const fallback = POS_CHANNELS.find(channel => channel.orderType === fallbackType)?.key;
        const input = document.getElementById("posChannel_" + moduleKey + "_" + fallback);
        if (input) input.checked = true;
        selected.push(input?.dataset.posChannel || "dine_in");
    }
    const select = document.getElementById("posDefault_" + moduleKey);
    if (!select) return;
    const prior = select.value;
    select.innerHTML = selected.map(key => {
        const channel = getSaleChannel(key);
        return channel ? "<option value=\"" + esc(key) + "\">" + esc(channel.label) + "</option>" : "";
    }).join("");
    select.value = selected.includes(prior) ? prior : selected[0];
}
function readPOSPreferencesFromForm() {
    const result = {};
    ["newOrder", "tableView"].forEach(moduleKey => {
        const channels = [...document.querySelectorAll("[data-pos-module=\"" + moduleKey + "\"]:checked")].map(input => input.dataset.posChannel);
        const fallback = POS_CHANNELS.find(channel => channel.orderType === (moduleKey === "tableView" ? "Dine-in" : "Takeaway"))?.key;
        const selectedChannels = channels.length ? channels : fallback ? [fallback] : [];
        const select = document.getElementById("posDefault_" + moduleKey);
        result[moduleKey] = { channels: selectedChannels, defaultChannel: selectedChannels.includes(select?.value) ? select.value : selectedChannels[0] };
    });
    return normalizePOSChannelPreferences(result);
}
async function loadSettings() {
    appSettings = {
        ...DEFAULT_APP_SETTINGS,
        restaurantName: currentUser?.business_name || DEFAULT_APP_SETTINGS.restaurantName,
        address: currentUser?.business_address || "",
        phone: currentUser?.business_phone || "",
        gstin: currentUser?.gstin || "",
        currency: currentUser?.currency || DEFAULT_APP_SETTINGS.currency
    };
    if (!currentUser?.business_id) {
        appSettings.paymentModes = normalizePaymentModes(appSettings.paymentModes);
        renderPaymentModeManager();
        return;
    }
    try {
        const local = JSON.parse(localStorage.getItem(settingsLocalStorageKey()) || "null");
        if (local && typeof local === "object") {
            delete local.publicMenuHeroImages;
            appSettings = { ...appSettings, ...local };
            if (!Object.prototype.hasOwnProperty.call(local, "totalRoundingMode")) appSettings.totalRoundingMode = local.roundTotals ? "nearest" : "none";
        }
    } catch (_) {}

    try {
        const saved = await api("/settings");
        if (saved && typeof saved === "object") {
            delete saved.publicMenuHeroImages;
            appSettings = { ...appSettings, ...saved };
            if (!Object.prototype.hasOwnProperty.call(saved, "totalRoundingMode")) appSettings.totalRoundingMode = saved.roundTotals ? "nearest" : "none";
        }
    } catch (error) {
        console.warn("Settings API unavailable:", error.message);
    }

    // Migrate older local caches that kept QR hero data in general POS settings.
    delete appSettings.publicMenuHeroImages;
    try { localStorage.setItem(settingsLocalStorageKey(), JSON.stringify(appSettings)); } catch (_) {}

    syncPOSChannelsFromSettings();
    appSettings.posChannelPreferences=normalizePOSChannelPreferences(appSettings.posChannelPreferences);
    appSettings.customerInfoRequirements=normalizeCustomerInfoRequirements(appSettings.customerInfoRequirements);
    appSettings.paymentModes = normalizePaymentModes(appSettings.paymentModes);
    appSettings.defaultPayment = preferredPaymentMethod();

    setSettingValue("settingRestaurantName", appSettings.restaurantName);
    setSettingValue("settingBusinessLegalName", appSettings.businessLegalName || "");
    setSettingValue("settingAddress", appSettings.address);
    setSettingValue("settingPhone", appSettings.phone);
    setSettingValue("settingGstin", appSettings.gstin);
    setSettingValue("settingFssai", appSettings.fssai || "");
    pendingBusinessLogoUrl = null;
    businessLogoChanged = false;
    setRestaurantLogoPreview(currentUser?.logo_url || "");
    setSettingValue("settingHeader", appSettings.header);
    setSettingValue("settingFooter", appSettings.footer);
    setSettingValue("settingShowInvoice", appSettings.showInvoice);
    setSettingValue("settingShowCustomer", appSettings.showCustomer);
    setSettingValue("settingShowCustomerPhone", appSettings.showCustomerPhone);
    setSettingValue("settingShowOrder", appSettings.showOrder);
    setSettingValue("settingShowOrderType", appSettings.showOrderType);
    setSettingValue("settingShowTable", appSettings.showTable);
    setSettingValue("settingShowTimestamp", appSettings.showTimestamp);
    setSettingValue("settingShowGST", appSettings.showGST);
    setSettingValue("settingGstCalculationEnabled", appSettings.gstCalculationEnabled !== false);
    setSettingValue("settingShowPayment", appSettings.showPayment);
    setSettingValue("settingShowQR", appSettings.showQR);
    setSettingValue("settingUppercaseItems", appSettings.uppercaseItems);
    setSettingValue("settingWrapItems", appSettings.wrapItems);
    setSettingValue("settingPaperWidth", appSettings.paperWidth);
    setSettingValue("settingAutoPrint", appSettings.autoPrint);
    setSettingValue("settingAutoClose", appSettings.autoClose);
    setSettingValue("settingCurrency", appSettings.currency);
    setSettingValue("settingGstRate", appSettings.gstRate);
    setSettingValue("settingDefaultPayment", appSettings.defaultPayment);
    setSettingValue("settingOrderPrefix", appSettings.orderPrefix); setSettingValue("settingInvoicePrefix", appSettings.invoicePrefix);
    setSettingValue("settingNonChargeableReasons", normalizeNonChargeableReasons(appSettings.nonChargeableReasons || DEFAULT_NON_CHARGEABLE_REASONS).join("\n"));
    setSettingValue("settingCancellationReasons", normalizeCancellationReasons(appSettings.cancellationReasons || DEFAULT_CANCELLATION_REASONS).join("\n"));
    setSettingValue("settingAllowZeroAmount", appSettings.allowZeroAmount);
    setSettingValue("settingTotalRoundingMode", ["none", "nearest", "up", "down"].includes(appSettings.totalRoundingMode) ? appSettings.totalRoundingMode : appSettings.roundTotals ? "nearest" : "none");
    setSettingValue("settingLogoUrl", appSettings.logoUrl); setSettingValue("settingUpiId", appSettings.upiId); setSettingValue("settingReceiptFont", appSettings.receiptFont);
    setSettingValue("settingKotPrintMode", ["never", "save", "checkout"].includes(appSettings.kotPrintMode) ? appSettings.kotPrintMode : appSettings.printKitchenOnOrder ? "checkout" : "never");
    setSettingValue("settingBillCopies", Math.min(20, Math.max(0, Number(appSettings.billCopies) || 0)));
    setSettingValue("settingEnableReceiptSound", appSettings.enableReceiptSound);
    setSettingValue("settingOpeningTime", appSettings.openingTime); setSettingValue("settingClosingTime", appSettings.closingTime); setSettingValue("settingDefaultOrderType", appSettings.defaultOrderType);
    setSettingValue("settingAllowOrderNotes", appSettings.allowOrderNotes); setSettingValue("settingShowItemNotes", appSettings.showItemNotes);
    setSettingValue("settingLowStockThreshold", appSettings.lowStockThreshold); setSettingValue("settingCustomerMessage", appSettings.customerMessage);
    setSettingValue("settingEnableNotifications", appSettings.enableNotifications); setSettingValue("settingEnableKOTSound", appSettings.enableKOTSound); setSettingValue("settingKOTAlertInterval", appSettings.kotAlertInterval);
    setSettingValue("settingQrCleanTableNotification", appSettings.qrCleanTableNotification !== false);
    setSettingValue("settingQrCleanTableSound", appSettings.qrCleanTableSound !== false);
    setSettingValue("settingQrCleanTableBuzzer", appSettings.qrCleanTableBuzzer === true);
    setSettingValue("settingQrCallWaiterNotification", appSettings.qrCallWaiterNotification !== false);
    setSettingValue("settingQrCallWaiterSound", appSettings.qrCallWaiterSound !== false);
    setSettingValue("settingQrCallWaiterBuzzer", appSettings.qrCallWaiterBuzzer === true);
    setSettingValue("settingSessionTimeout", appSettings.sessionTimeout);
    setSettingValue("settingAuditLog", appSettings.auditLog);
    setSettingValue("settingUiDensity", appSettings.uiDensity); setSettingValue("settingAccentLabel", appSettings.accentLabel); setSettingValue("settingLargeBilling", appSettings.largeBilling);
    setSettingValue("settingKOTEnabled", appSettings.kotEnabled !== false); setSettingValue("settingKOTDisabledBehavior", appSettings.kotDisabledBehavior || "hide");
    renderPaymentModeManager();
    renderPOSPreferences();
    renderCustomerInfoRequirements();
    renderSalesChannels();
    renderBillingSaleChannelOptions();
    renderBillingAdjustmentAppliesOptions();
    applyPermissionsToUI();
}

function setRestaurantLogoPreview(logoUrl) {
    const wrap = document.getElementById("settingRestaurantLogoPreviewWrap");
    const image = document.getElementById("settingRestaurantLogoPreview");
    const hasLogo = Boolean(String(logoUrl || "").trim());
    if (image) image.src = hasLogo ? String(logoUrl) : "";
    if (wrap) wrap.hidden = !hasLogo;
}

async function handleRestaurantLogoUpload(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) {
        input.value = "";
        return alert("Choose a PNG, JPG or WebP image.");
    }
    if (file.size > 200 * 1024) {
        input.value = "";
        return alert("Choose a logo image that is 200 KB or smaller.");
    }
    try {
        const bitmap = await createImageBitmap(file);
        if (bitmap.width * bitmap.height > 40000000) {
            bitmap.close?.();
            throw new Error("Choose a logo image with dimensions below 40 megapixels.");
        }
        const canvas = document.createElement("canvas");
        let result = "";
        for (const size of [600, 480, 360]) {
            const scale = Math.min(1, size / bitmap.width, size / bitmap.height);
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext("2d");
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            for (const quality of [0.84, 0.72, 0.6]) {
                result = canvas.toDataURL("image/webp", quality);
                if (atob(result.slice(result.indexOf(",") + 1)).length <= 200 * 1024) break;
            }
            if (atob(result.slice(result.indexOf(",") + 1)).length <= 200 * 1024) break;
        }
        bitmap.close?.();
        if (!result.startsWith("data:image/webp;base64,") || atob(result.slice(result.indexOf(",") + 1)).length > 200 * 1024) {
            throw new Error("This logo could not be compressed below 200 KB. Choose a smaller or simpler image.");
        }
        pendingBusinessLogoUrl = result;
        businessLogoChanged = true;
        setRestaurantLogoPreview(result);
    } catch (error) {
        input.value = "";
        alert(error.message || "Could not read this logo image.");
    }
}

function removeRestaurantLogo() {
    pendingBusinessLogoUrl = "";
    businessLogoChanged = true;
    const input = document.getElementById("settingRestaurantLogoFile");
    if (input) input.value = "";
    setRestaurantLogoPreview("");
}

function businessLogoUrl() {
    return String(currentUser?.logo_url || "");
}

async function saveSettings() {
    const next = {
        restaurantName: readSettingValue("settingRestaurantName") || "SLASH POS",
        businessLegalName: readSettingValue("settingBusinessLegalName") || "",
        address: readSettingValue("settingAddress") || "",
        phone: readSettingValue("settingPhone") || "",
        gstin: readSettingValue("settingGstin") || "",
        fssai: readSettingValue("settingFssai") || "",
        header: readSettingValue("settingHeader") || "",
        footer: readSettingValue("settingFooter") || "Visit Again!\nThank you.",
        showInvoice: readSettingValue("settingShowInvoice"),
        showCustomer: readSettingValue("settingShowCustomer"),
        showCustomerPhone: readSettingValue("settingShowCustomerPhone"),
        showOrder: readSettingValue("settingShowOrder"),
        showOrderType: readSettingValue("settingShowOrderType"),
        showTable: readSettingValue("settingShowTable"),
        showTimestamp: readSettingValue("settingShowTimestamp"),
        showGST: readSettingValue("settingShowGST"),
        gstCalculationEnabled: readSettingValue("settingGstCalculationEnabled"),
        showPayment: readSettingValue("settingShowPayment"),
        showQR: readSettingValue("settingShowQR"),
        uppercaseItems: readSettingValue("settingUppercaseItems"),
        wrapItems: readSettingValue("settingWrapItems"),
        paperWidth: readSettingValue("settingPaperWidth") || "80",
        autoPrint: readSettingValue("settingAutoPrint"),
        autoClose: readSettingValue("settingAutoClose"),
        currency: readSettingValue("settingCurrency") || "₹",
        gstRate: Number(readSettingValue("settingGstRate")) || 0,
        defaultPayment: readSettingValue("settingDefaultPayment") || preferredPaymentMethod(),
        paymentModes: normalizePaymentModes(appSettings.paymentModes),
        orderPrefix: readSettingValue("settingOrderPrefix") || "ORD-", invoicePrefix: readSettingValue("settingInvoicePrefix") || "INV-",
        nonChargeableReasons: normalizeNonChargeableReasons(String(readSettingValue("settingNonChargeableReasons") || "").split(/\r?\n/)),
        cancellationReasons: normalizeCancellationReasons(String(readSettingValue("settingCancellationReasons") || "").split(/\r?\n/)),
        allowZeroAmount: readSettingValue("settingAllowZeroAmount"),
        totalRoundingMode: readSettingValue("settingTotalRoundingMode") || "none",
        roundTotals: (readSettingValue("settingTotalRoundingMode") || "none") !== "none",
        logoUrl: readSettingValue("settingLogoUrl") || "", upiId: readSettingValue("settingUpiId") || "", receiptFont: readSettingValue("settingReceiptFont") || "Arial",
        kotPrintMode: ["never", "save", "checkout"].includes(readSettingValue("settingKotPrintMode")) ? readSettingValue("settingKotPrintMode") : "never",
        printKitchenOnOrder: readSettingValue("settingKotPrintMode") === "checkout",
        billCopies: Math.min(20, Math.max(0, Math.floor(Number(readSettingValue("settingBillCopies")) || 0))),
        enableReceiptSound: readSettingValue("settingEnableReceiptSound"),
        openingTime: readSettingValue("settingOpeningTime") || "09:00", closingTime: readSettingValue("settingClosingTime") || "23:00", defaultOrderType: readSettingValue("settingDefaultOrderType") || "Takeaway",
        allowOrderNotes: readSettingValue("settingAllowOrderNotes"), showItemNotes: readSettingValue("settingShowItemNotes"), lowStockThreshold: Number(readSettingValue("settingLowStockThreshold")) || 0,
        customerMessage: readSettingValue("settingCustomerMessage") || "Thank you for visiting!", enableNotifications: readSettingValue("settingEnableNotifications"), enableKOTSound: readSettingValue("settingEnableKOTSound"), kotAlertInterval: Math.min(60, Math.max(3, Number(readSettingValue("settingKOTAlertInterval")) || 5)),
        qrCleanTableNotification: readSettingValue("settingQrCleanTableNotification") !== false,
        qrCleanTableSound: readSettingValue("settingQrCleanTableSound") !== false,
        qrCleanTableBuzzer: readSettingValue("settingQrCleanTableBuzzer") === true,
        qrCallWaiterNotification: readSettingValue("settingQrCallWaiterNotification") !== false,
        qrCallWaiterSound: readSettingValue("settingQrCallWaiterSound") !== false,
        qrCallWaiterBuzzer: readSettingValue("settingQrCallWaiterBuzzer") === true,
        sessionTimeout: Number(readSettingValue("settingSessionTimeout")) || 12, auditLog: readSettingValue("settingAuditLog"),
        uiDensity: readSettingValue("settingUiDensity") || "comfortable", accentLabel: readSettingValue("settingAccentLabel") || "", largeBilling: readSettingValue("settingLargeBilling"),
        kotEnabled: readSettingValue("settingKOTEnabled"), kotDisabledBehavior: readSettingValue("settingKOTDisabledBehavior") || "hide", posChannelPreferences: readPOSPreferencesFromForm(), customerInfoRequirements: readCustomerInfoRequirementsFromForm(), posSalesChannels: POS_CHANNELS.map(channel=>({...channel}))
    };

    appSettings = { ...appSettings, ...next };
    delete appSettings.publicMenuHeroImages;
    if (!currentOpenOrderId) {
        setOrderType(orderType === "Dine-in" ? "Dine-in" : "Takeaway");
    } else {
        renderBillingSaleChannelOptions();
    }
    updateCart();
    localStorage.setItem(settingsLocalStorageKey(), JSON.stringify(appSettings));
    localStorage.setItem("cafeThermalPaperWidth", appSettings.paperWidth);

    let logoSaveError = "";
    if (businessLogoChanged) {
        try {
            const savedLogo = await api("/business/profile/logo", { method: "PUT", body: JSON.stringify({ logoUrl: pendingBusinessLogoUrl }) });
            currentUser.logo_url = savedLogo.logoUrl || "";
            pendingBusinessLogoUrl = null;
            businessLogoChanged = false;
            setRestaurantLogoPreview(currentUser.logo_url);
        } catch (error) {
            logoSaveError = error.message || "The business logo could not be saved.";
        }
    }
    try {
        await api("/settings", { method: "PUT", body: JSON.stringify(appSettings) });
        showProfileToast(logoSaveError ? `Settings saved, but the logo was not updated: ${logoSaveError}` : "✓ Settings saved successfully.", true);
    } catch (error) {
        showProfileToast(logoSaveError ? `Settings saved locally, but the logo was not updated: ${logoSaveError}` : `Settings saved on this device, but server sync failed: ${error.message || "Please try again."}`, true);
    }
}

function resetSettings() {
    if (!confirm("Reset all settings to defaults?")) return;
    appSettings = {
        restaurantName: "SLASH POS", businessLegalName: "", address: "", phone: "", gstin: "", fssai: "",
        header: "Cafe Management System", footer: "Visit Again!\nThank you.",
        showInvoice: true, showCustomer: true, showCustomerPhone: true,
        showOrder: true, showOrderType: true, showTable: true, showTimestamp: true,
        showGST: true, showPayment: true, showQR: true, uppercaseItems: false, wrapItems: true,
        gstCalculationEnabled: true,
        paperWidth: "80", autoPrint: false, autoClose: true, currency: "₹", gstRate: 5,
        defaultPayment: STARTER_PAYMENT_MODES[0].name, paymentModes: normalizePaymentModes(STARTER_PAYMENT_MODES), orderPrefix: "ORD-", invoicePrefix: "INV-",
        nonChargeableReasons: DEFAULT_NON_CHARGEABLE_REASONS.slice(),
        cancellationReasons: DEFAULT_CANCELLATION_REASONS.slice(),
        allowZeroAmount: false, roundTotals: false, totalRoundingMode: "none", logoUrl: "", upiId: "", receiptFont: "Arial",
        printKitchenOnOrder: false, kotPrintMode: "never", billCopies: 1, enableReceiptSound: false, openingTime: "09:00", closingTime: "23:00",
        defaultOrderType: "Takeaway", allowOrderNotes: true, showItemNotes: true, lowStockThreshold: 5, customerInfoRequirements: {},
        customerMessage: "Thank you for visiting!", enableNotifications: true, enableKOTSound: true, kotAlertInterval: 5,
        qrCleanTableNotification: true, qrCleanTableSound: true, qrCleanTableBuzzer: false,
        qrCallWaiterNotification: true, qrCallWaiterSound: true, qrCallWaiterBuzzer: false,
        sessionTimeout: 12, auditLog: false,
        uiDensity: "comfortable", accentLabel: "", largeBilling: false, kotEnabled: true, kotDisabledBehavior: "hide"
    };
    localStorage.setItem(settingsLocalStorageKey(), JSON.stringify(appSettings));
    applyPermissionsToUI();
    loadSettings();
}

// ==========================================
// CUSTOMERS
// ==========================================

async function loadCustomers() {
    try {
        currentCustomers = await api("/customers");
        filterCustomers(document.getElementById("customerSearch")?.value || "");
    } catch (error) {
        console.error("Customers failed:", error);
    }
}

function filterCustomers(query) {
    const tbody = document.getElementById("customersTableBody");
    if (!tbody) return;
    const term = String(query || "").trim().toLocaleLowerCase();
    const customers = Array.isArray(currentCustomers) ? currentCustomers : [];
    const matches = customers.filter(customer =>
        !term || String(customer.id || "").toLocaleLowerCase().includes(term) || String(customer.name || "").toLocaleLowerCase().includes(term)
    );
    if (!matches.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="customer-search-empty">' +
            (term ? "No customers match that name or ID." : "No customers found.") + '</td></tr>';
        return;
    }
    tbody.innerHTML = matches.map(customer => {
        const customerId = Number(customer.id);
        return "<tr>" +
            "<td>" + esc(customer.id) + "</td>" +
            "<td>" + esc(customer.name || "-") + "</td>" +
            "<td>" + esc(customer.phone || "-") + "</td>" +
            "<td>" + esc(customer.email || "-") + "</td>" +
            "<td>" + esc(formatPOSDateTime(customer.created_at)) + "</td>" +
            '<td><button type="button" class="customer-order-activity-btn" onclick="viewCustomerOrderActivity(' + customerId + ')">Customer activity</button> ' +
            '<button type="button" onclick="editCustomer(' + customerId + ')">✏️ Edit</button> ' +
            '<button type="button" onclick="deleteCustomer(' + customerId + ')">🗑️ Delete</button></td>' +
            "</tr>";
    }).join("");
}

async function viewCustomerOrderActivity(customerId) {
    if (!hasPermission("customers", "view")) return showProfileToast("You don’t have permission to view customers.");
    const modal = document.getElementById("customerOrderActivityModal");
    const list = document.getElementById("customerOrderActivityList");
    const title = document.getElementById("customerOrderActivityTitle");
    if (!modal || !list) return;
    modal.style.display = "flex";
    if (title) title.textContent = "Customer orders";
    list.innerHTML = '<p class="access-muted">Loading orders…</p>';
    try {
        const result = await api("/customers/" + Number(customerId) + "/order-activity");
        const customer = result.customer || {};
        const orders = Array.isArray(result.orders) ? result.orders : [];
        const totalOrders = Number.isFinite(Number(result.totalOrders)) ? Number(result.totalOrders) : orders.length;
        if (title) title.textContent = customer.name ? customer.name + " · Orders" : "Customer orders";
        const orderRows = orders.map(order =>
            '<article class="customer-order-simple-row"><span class="customer-order-simple-number">' +
            esc(order.order_number || (order.id ? "#" + order.id : "Order")) +
            '</span><strong class="customer-order-simple-amount">' + money(order.order_total || 0) + '</strong></article>'
        ).join("");
        list.innerHTML = '<div class="customer-order-summary"><span>Total orders</span><strong>' + totalOrders + '</strong></div>' +
            (orders.length
                ? '<div class="customer-order-simple-list" aria-label="Customer orders">' + orderRows + '</div>'
                : '<div class="orders-empty-state"><strong>No orders yet</strong><small>This customer has no orders on record.</small></div>');
    } catch (error) {
        list.innerHTML = '<p class="access-muted">Unable to load customer orders: ' + esc(error.message || "Please try again.") + '</p>';
    }
}

function closeCustomerOrderActivity() {
    const modal = document.getElementById("customerOrderActivityModal");
    if (modal) modal.style.display = "none";
}

function csvSafeCell(value){
    let text=String(value??"");
    if(typeof value!=="number"&&/^[\t\r ]*[=+\-@]/.test(text))text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
}
function downloadCsvRows(filename,rows){
    const content="\uFEFF"+rows.map(row=>row.map(csvSafeCell).join(",")).join("\r\n");
    const url=URL.createObjectURL(new Blob([content],{type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a");link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function downloadCustomersCSV(){
    if(!hasPermission("customers","export"))return showProfileToast("You don’t have permission to export customers.");
    try{
        const customers=await api("/customers?export=1");
        const columns=[
            ["Customer ID","id"],["Name","name"],["Phone","phone"],["Email","email"],["GSTIN","gstin"],
            ["Birth date","birth_date"],["Address","address"],["City","city"],["State","state"],["Created at","created_at"]
        ];
        downloadCsvRows(`cafe-pos-customers-${getPOSDateKey()}.csv`,[
            columns.map(([label])=>label),
            ...((Array.isArray(customers)?customers:[]).map(customer=>columns.map(([,key])=>customer?.[key]??"")))
        ]);
        showProfileToast(`${customers.length} customer record${customers.length===1?"":"s"} downloaded.`);
    }catch(error){alert(error.message||"Could not download customer data.");}
}
function downloadReportTableCSV(bodyId,filename,label){
    if(!hasPermission("reports","export"))return showProfileToast("You don’t have permission to export reports.");
    const body=document.getElementById(bodyId),table=body?.closest("table");
    const headers=[...(table?.querySelectorAll("thead tr:last-child th")||[])].map(cell=>cell.innerText.replace(/\s+/g," ").trim());
    if(!body||!headers.length)return alert("This report table is not available yet.");
    const rows=[...body.querySelectorAll("tr")].map(row=>[...row.cells].map(cell=>cell.innerText.replace(/\s+/g," ").trim())).filter(row=>row.length===headers.length);
    downloadCsvRows(`${filename}-${getPOSDateKey()}.csv`,[headers,...rows]);
    showProfileToast(`${label} report downloaded.`);
}

function cacheBillingCustomer(customer) {
    if (!customer?.id) return;
    const current = Array.isArray(currentCustomers) ? currentCustomers : [];
    currentCustomers = [customer, ...current.filter(entry => Number(entry.id) !== Number(customer.id))];
}


function openCustomerForm() {

    const form =
        document.getElementById(
            "customerForm"
        );


    if (form) form.hidden = !form.hidden;

}


async function addCustomer() {

    const name =
        document.getElementById(
            "customerName"
        ).value.trim();


    const phone =
        document.getElementById(
            "customerPhone"
        ).value.trim();


    const email =
        document.getElementById(
            "customerEmail"
        ).value.trim();


    if (!name || !phone) {

        return alert(
            "Name and phone are required."
        );

    }


    try {

        await api(
            "/customers",
            {

                method: "POST",

                body: JSON.stringify({

                    name,
                    phone,
                    email

                })

            }
        );


        [
            "customerName",
            "customerPhone",
            "customerEmail"
        ]
        .forEach(function(id) {

            document.getElementById(
                id
            ).value = "";

        });


        document.getElementById("customerForm").hidden = true;


        await loadCustomers();

        await updateDashboard();


        showProfileToast("Customer added successfully.", true);


    } catch (error) {

        alert(error.message);

    }

}


async function editCustomer(id) {

    const customer =
        currentCustomers.find(
            function(item) {

                return item.id == id;

            }
        );


    if (!customer) {

        return;

    }


    const name =
        prompt(
            "Customer name:",
            customer.name
        );


    if (name === null) {

        return;

    }


    const phone =
        prompt(
            "Phone:",
            customer.phone
        );


    if (phone === null) {

        return;

    }


    const email =
        prompt(
            "Email:",
            customer.email || ""
        );


    if (email === null) {

        return;

    }


    try {

        await api(
            `/customers/${id}`,
            {

                method: "PUT",

                body: JSON.stringify({

                    name:
                        name.trim(),

                    phone:
                        phone.trim(),

                    email:
                        email.trim()

                })

            }
        );


        await loadCustomers();


        alert(
            "Customer updated! ✅"
        );


    } catch (error) {

        alert(error.message);

    }

}


async function deleteCustomer(id) {

    if (
        !confirm(
            "Delete this customer?"
        )
    ) {

        return;

    }


    try {

        await api(
            `/customers/${id}`,
            {
                method: "DELETE"
            }
        );


        await loadCustomers();

        await updateDashboard();


    } catch (error) {

        alert(error.message);

    }

}


// ==========================================
// PAYMENTS
// ==========================================

async function loadPayments() {

    try {

        currentPayments =
            await api("/payments");


        const tbody =
            document.getElementById(
                "paymentsTableBody"
            );


        if (!tbody) {

            return;

        }


        tbody.innerHTML = "";


        currentPayments.forEach(
            function(payment) {

                const tr =
                    document.createElement(
                        "tr"
                    );


                tr.innerHTML = `

                    <td>
                        ${payment.id}
                    </td>

                    <td>
                        ${esc(
                            payment.order_number
                        )}
                    </td>

                    <td>
                        ${money(
                            payment.amount
                        )}
                    </td>

                    <td>
                        ${esc(
                            payment.payment_method
                        )}
                    </td>

                    <td>
                        ${esc(
                            payment.payment_status
                        )}
                    </td>

                    <td>
                        ${esc(
                            payment.transaction_id ||
                            "-"
                        )}
                    </td>

                    <td>
                        ${formatPOSDateTime(
                            payment.created_at
                        )}
                    </td>

                `;


                tbody.appendChild(tr);

            }
        );


    } catch (error) {

        console.error(
            "Payments failed:",
            error
        );

    }

}


// ==========================================
// DASHBOARD
// ==========================================

async function updateDashboard() {

    try {

        const stats =
            await api(
                "/dashboard/stats"
            );


        console.log(
            "📊 Dashboard data:",
            stats
        );


        const todaySales =
            getNumberValue(
                stats.todaySales,
                [
                    "today_sales",
                    "total_sales",
                    "sum"
                ]
            );


        const todayOrders =
            getNumberValue(
                stats.todayOrders,
                [
                    "today_orders",
                    "total_orders",
                    "count"
                ]
            );


        const customers =
            getNumberValue(
                stats.customers,
                [
                    "customers",
                    "customer_count",
                    "count"
                ]
            );


        const pendingOrders =
            getNumberValue(
                stats.pendingOrders,
                [
                    "pending_orders",
                    "count"
                ]
            );


        setText(
            "todaySales",
            money(todaySales)
        );


        setText(
            "todayOrders",
            todayOrders
        );


        setText(
            "customerCount",
            customers
        );


        setText(
            "pendingOrders",
            pendingOrders
        );


    } catch (error) {

        console.error(
            "❌ Dashboard failed:",
            error
        );

    }

}


// ==========================================
// SALES & REPORTS
// ==========================================

// ==========================================
// CUSTOM REPORT DATE TOGGLE
// ==========================================

let salesAuditTransactions = [];
const SALES_AUDIT_EXPORT_COLUMNS = [
    "Branch Name", "Branch Code", "BranchLabels", "Business Brand", "Business Date", "Invoice Number", "Customer TIN number/PAN no.", "Statement Number", "Invoice Date", "Sale Status", "Advance Order", "E-Invoice IRN Status", "E-Invoice IRN Number", "E-Invoice Remarks", "E-Invoice Customer TIN", "Amount Returned", "Return Payment Mode", "Fulfillment Status", "Invoice Type", "Order Number", "Offline Order Number", "Order Source", "Source Order Number", "Source Outlet Id", "Open Order Amount", "Gross Amount", "Discounts", "Direct Charge Amount", "Net Amount", "Other Charge Amount", "Taxes", "Rounding", "Tip", "Total", "Paid Amount", "Balance Due", "% Discount", "Tax paid by Aggregator", "Payment Modes", "Materials Cost", "Supplies Cost", "Channel", "Channel Label", "Session", "Label", "Tags", "Order Notes", "Resource Group Name", "Number of Items", "Total Quantity", "By Reservation", "Reservation Source", "Reservation Reference", "Number Of People", "Duration (Minutes)", "Number of Tickets", "Number of Modified Tickets", "Number of Cancelled Tickets", "Number of Bill Prints", "Modified After Print", "Modified After Close", "Change Logs After Print", "Bill Print Log", "Created Date", "Created By", "Closed By", "Sale By", "Delivery Mode", "Delivery By", "Delivery User ID", "Time to Accept", "Time to Prepare", "Time to Process", "Time to Assign", "Time to Rider Arrive", "Time to Dispatch", "Time to Deliver", "Time to Settle", "Time to Cancel", "Cancel/Void Date", "Cancel/Void By", "Reason For Cancel/Void/Non Chargeable", "Remarks for Cancel/Void/Non Chargeable", "Source Reason for Cancel/Void", "Customer Id", "Customer Name", "Company Name", "Customer Phone", "Phone Prefix", "Deliver To Contact", "Deliver To Phone", "Deliver To Phone Prefix", "Deliver To Address", "Delivery To Latitude", "Delivery To Longitude", "Last Update from Device", "Target Order Number", "Bill Link", "Warnings", "Source Customer Id", "Charges Amount (Initial)", "Charges Amount (Removed)", "Average Kitchen Prep Time (Minutes)", "Longest Kitchen Prep Time (Minutes)", "Kitchen Stations"
];

async function loadSalesAuditReport() {
    const status = document.getElementById("salesAuditStatus");
    const body = document.getElementById("salesAuditBody");
    const range = document.getElementById("reportDateFilter")?.value || "today";
    const from = document.getElementById("reportFromDate")?.value || "";
    const to = document.getElementById("reportToDate")?.value || "";
    if (range === "custom" && (!from || !to || from > to)) {
        if (status) status.textContent = "Choose a valid From and To date before loading the audit.";
        return;
    }
    const params = new URLSearchParams({ range });
    if (range === "custom") { params.set("from", from); params.set("to", to); }
    if (status) status.textContent = "Loading sale transactions…";
    if (body) body.innerHTML = '<tr><td colspan="18">Loading sales…</td></tr>';
    try {
        const result = await api(`/reports/sales-audit?${params.toString()}`);
        salesAuditTransactions = Array.isArray(result.transactions) ? result.transactions : [];
        if (!body) return;
        body.innerHTML = salesAuditTransactions.length ? salesAuditTransactions.map(row => `
            <tr>
                <td>${esc(row.business_date ? formatPOSDateTime(row.business_date) : "-")}</td>
                <td>${esc(row.invoice_date ? formatPOSDateTime(row.invoice_date) : "-")}</td>
                <td>${esc(row.invoice_number || "-")}</td>
                <td><strong>${esc(row.order_number || `#${row.order_id}`)}</strong></td>
                <td>${esc(row.channel_label || row.order_type || "-")}${row.table_number ? ` · ${esc(row.table_number)}` : ""}</td>
                <td>${esc(row.customer_name || "-")}</td>
                <td>${esc(row.payment_modes || "-")}</td>
                <td>${money(row.subtotal)}</td>
                <td>${money(row.discount)}</td>
                <td>${money(row.service_charge)}</td>
                <td>${money(row.gst)}</td>
                <td>${money(row.bill_total)}</td>
                <td>${money(row.amount_collected)}</td>
                <td>${money(row.amount_due)}</td>
                <td>${row.average_prep_minutes == null ? "—" : `${Number(row.average_prep_minutes).toFixed(1)} min`}</td>
                <td>${row.longest_prep_minutes == null ? "—" : `${Number(row.longest_prep_minutes).toFixed(1)} min`}</td>
                <td>${esc(row.kitchen_stations || "—")}</td>
                <td>${esc(row.order_status || "-")}</td>
            </tr>`).join("") : '<tr><td colspan="18">No sale transactions found for this period.</td></tr>';
        if (status) status.textContent = `${salesAuditTransactions.length} completed sale${salesAuditTransactions.length === 1 ? "" : "s"} loaded. Each order is one row; split payment methods are combined.`;
        await loadKitchenPrepTimesReport({ range, from, to });
    } catch (error) {
        salesAuditTransactions = [];
        if (body) body.innerHTML = `<tr><td colspan="18">Unable to load audit: ${esc(error.message)}</td></tr>`;
        if (status) status.textContent = "The transaction audit could not be loaded.";
    }
}

let kitchenPrepTimes = [];
function getSelectedSalesReportRange() {
    const range = document.getElementById("reportDateFilter")?.value || "today";
    const from = document.getElementById("reportFromDate")?.value || "";
    const to = document.getElementById("reportToDate")?.value || "";
    return { range, from, to };
}

async function loadKitchenPrepTimesReport(selection = getSelectedSalesReportRange()) {
    const status = document.getElementById("kitchenPrepTimesStatus");
    const body = document.getElementById("kitchenPrepTimesBody");
    const exportButton = document.querySelector(".sales-audit-prep [data-export-module='reports']");
    if (selection.range === "custom" && (!selection.from || !selection.to || selection.from > selection.to)) {
        if (status) status.textContent = "Choose a valid From and To date before loading kitchen prep times.";
        return;
    }
    const params = new URLSearchParams({ range: selection.range });
    if (selection.range === "custom") { params.set("from", selection.from); params.set("to", selection.to); }
    if (status) status.textContent = "Loading kitchen ticket timing…";
    if (body) body.innerHTML = '<tr><td colspan="11">Loading kitchen prep times…</td></tr>';
    try {
        const result = await api(`/reports/kitchen-prep-times?${params.toString()}`);
        kitchenPrepTimes = Array.isArray(result.tickets) ? result.tickets : [];
        if (exportButton) exportButton.hidden = !hasPermission("reports", "export");
        const stationFilter = document.getElementById("kitchenPrepStationFilter");
        if (stationFilter) {
            const selectedStation = stationFilter.value;
            const stations = [...new Set(kitchenPrepTimes.map(ticket => ticket.station_name || ticket.station || "Kitchen"))].sort((a, b) => a.localeCompare(b));
            stationFilter.innerHTML = '<option value="">All stations</option>' + stations.map(station => `<option value="${esc(station)}">${esc(station)}</option>`).join("");
            if (stations.includes(selectedStation)) stationFilter.value = selectedStation;
        }
        renderKitchenPrepTimesTable();
        if (status) status.textContent = `${kitchenPrepTimes.length} kitchen ticket item${kitchenPrepTimes.length === 1 ? "" : "s"} loaded by routed station.`;
    } catch (error) {
        kitchenPrepTimes = [];
        if (body) body.innerHTML = `<tr><td colspan="11">Unable to load prep times: ${esc(error.message || "Please try again.")}</td></tr>`;
        if (status) status.textContent = "Kitchen prep-time data could not be loaded.";
    }
}

function renderKitchenPrepTimesTable() {
    const body = document.getElementById("kitchenPrepTimesBody");
    if (!body) return;
    const query = String(document.getElementById("kitchenPrepItemFilter")?.value || "").trim().toLocaleLowerCase();
    const selectedStation = document.getElementById("kitchenPrepStationFilter")?.value || "";
    const visibleTickets = kitchenPrepTimes.filter(ticket => {
        const station = ticket.station_name || ticket.station || "Kitchen";
        const searchable = [ticket.order_number, ticket.order_id, ticket.item_name, station].some(value => String(value || "").toLocaleLowerCase().includes(query));
        return searchable && (!selectedStation || station === selectedStation);
    });
    body.innerHTML = visibleTickets.length ? visibleTickets.map(ticket => {
        const quantity = Number(ticket.quantity || 0);
        const cancelled = Number(ticket.cancelled_quantity || 0);
        const prepMinutes = ticket.prep_minutes == null ? "—" : `${Number(ticket.prep_minutes).toFixed(1)} min`;
        const elapsed = ticket.elapsed_minutes == null ? "—" : `${Number(ticket.elapsed_minutes).toFixed(1)} min`;
        return `<tr>
            <td><strong>${esc(ticket.order_number || `#${ticket.order_id}`)}</strong>${ticket.table_number ? `<small class="audit-order-status">${esc(ticket.order_type || "")} · ${esc(ticket.table_number)}</small>` : ""}</td>
            <td>#${Number(ticket.ticket_number || 1)}</td>
            <td>${esc(ticket.item_name || "Item")}${cancelled ? `<small class="audit-order-status">${cancelled} cancelled</small>` : ""}</td>
            <td>${esc(ticket.station_name || ticket.station || "Kitchen")}</td>
            <td>${quantity}</td>
            <td><span class="kitchen-prep-status is-${String(ticket.ticket_status || "pending").toLowerCase()}">${esc(ticket.ticket_status || "Pending")}</span></td>
            <td>${ticket.ticket_received_at ? esc(formatPOSDateTime(ticket.ticket_received_at)) : "—"}</td>
            <td>${ticket.prep_started_at ? esc(formatPOSDateTime(ticket.prep_started_at)) : "—"}</td>
            <td>${ticket.prep_completed_at ? esc(formatPOSDateTime(ticket.prep_completed_at)) : "—"}</td>
            <td><strong>${prepMinutes}</strong></td>
            <td>${elapsed}</td>
        </tr>`;
    }).join("") : `<tr><td colspan="11">${kitchenPrepTimes.length ? "No kitchen tickets match these filters." : "No kitchen tickets found in this period."}</td></tr>`;
}

function downloadKitchenPrepTimesCSV() {
    if (!hasPermission("reports", "export")) return showProfileToast("You don’t have permission to export reports.");
    if (!kitchenPrepTimes.length) return showProfileToast("Load kitchen prep times before downloading the CSV.");
    const columns = ["Order Number", "Ticket Number", "Item", "Station", "Quantity", "Cancelled Quantity", "Status", "Ticket Received (IST)", "Prep Started (IST)", "Ready (IST)", "Prep Time (Minutes)", "Elapsed Since Ticket (Minutes)"];
    const rows = kitchenPrepTimes.map(ticket => [
        ticket.order_number || `#${ticket.order_id}`, Number(ticket.ticket_number || 1), ticket.item_name || "Item",
        ticket.station_name || ticket.station || "Kitchen", Number(ticket.quantity || 0), Number(ticket.cancelled_quantity || 0),
        ticket.ticket_status || "Pending", formatPOSDateTime(ticket.ticket_received_at), formatPOSDateTime(ticket.prep_started_at),
        formatPOSDateTime(ticket.prep_completed_at), ticket.prep_minutes ?? "", ticket.elapsed_minutes ?? ""
    ]);
    downloadCsvRows(`kitchen-prep-time-${getPOSDateKey()}.csv`, [columns, ...rows]);
    showProfileToast("Kitchen prep-time report downloaded.");
}

let saleItemsByTransaction = [];
async function loadSaleItemsByTransactionReport() {
    const status = document.getElementById("saleItemsTransactionStatus");
    const body = document.getElementById("saleItemsTransactionBody");
    const exportButton = document.querySelector(".sale-items-transaction-box [data-export-module='reports']");
    const range = document.getElementById("reportDateFilter")?.value || "today";
    const from = document.getElementById("reportFromDate")?.value || "";
    const to = document.getElementById("reportToDate")?.value || "";
    if (range === "custom" && (!from || !to || from > to)) {
        if (status) status.textContent = "Choose a valid From and To date before loading item sales.";
        return;
    }
    const params = new URLSearchParams({ range });
    if (range === "custom") { params.set("from", from); params.set("to", to); }
    if (status) status.textContent = "Loading sold items…";
    if (body) body.innerHTML = '<tr><td colspan="12">Loading item sales…</td></tr>';
    try {
        const result = await api(`/reports/sale-items-by-transaction?${params.toString()}`);
        saleItemsByTransaction = Array.isArray(result.items) ? result.items : [];
        if (exportButton) exportButton.hidden = !hasPermission("reports", "export");
        if (!body) return;
        body.innerHTML = saleItemsByTransaction.length ? saleItemsByTransaction.map(row => `
            <tr>
                <td>${esc(row.transaction_date ? formatPOSDateTime(row.transaction_date) : "-")}</td>
                <td>${esc(row.invoice_number || "-")}</td>
                <td><strong>${esc(row.order_number || `#${row.order_id}`)}</strong></td>
                <td>${esc(row.channel_label || row.order_type || "-")}${row.table_number ? ` · ${esc(row.table_number)}` : ""}</td>
                <td>${esc(row.customer_name || "-")}</td>
                <td>${esc(row.item_name || "Item")}</td>
                <td>${esc(row.category || "-")}</td>
                <td>${Number(row.quantity || 0)}</td>
                <td>${money(row.unit_price)}</td>
                <td>${money(row.line_total)}</td>
                <td>${money(row.transaction_total)}</td>
                <td>${esc(row.payment_modes || "-")}</td>
            </tr>`).join("") : '<tr><td colspan="12">No completed item sales found for this period.</td></tr>';
        if (status) status.textContent = `${saleItemsByTransaction.length} sold item line${saleItemsByTransaction.length === 1 ? "" : "s"} loaded from completed transactions.`;
    } catch (error) {
        saleItemsByTransaction = [];
        if (body) body.innerHTML = `<tr><td colspan="12">Unable to load item sales: ${esc(error.message)}</td></tr>`;
        if (status) status.textContent = "The item-by-transaction report could not be loaded.";
    }
}

function downloadSaleItemsByTransactionCSV() {
    if (!hasPermission("reports", "export")) return showProfileToast("You don’t have permission to export reports.");
    if (!saleItemsByTransaction.length) return showProfileToast("Load item sales before downloading the CSV.");
    const columns = ["Transaction Date", "Invoice Number", "Order Number", "Channel", "Table", "Customer", "Item", "Category", "Quantity", "Unit Price", "Line Total", "Transaction Total", "Payment Modes"];
    const dateText = value => value ? formatPOSDateTime(value) : "";
    const rows = saleItemsByTransaction.map(row => [
        dateText(row.transaction_date), row.invoice_number || "", row.order_number || `#${row.order_id}`,
        row.channel_label || row.order_type || "", row.table_number || "", row.customer_name || "",
        row.item_name || "", row.category || "", Number(row.quantity || 0), Number(row.unit_price || 0),
        Number(row.line_total || 0), Number(row.transaction_total || 0), row.payment_modes || ""
    ]);
    const content = "\uFEFF" + [columns, ...rows].map(row => row.map(csvSafeCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `sale-items-by-transaction-${getPOSDateKey()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSalesAuditCSV() {
    if(!hasPermission("reports","export"))return showProfileToast("You don’t have permission to export reports.");
    if (!salesAuditTransactions.length) return alert("Load sale transactions before downloading the audit.");
    const auditDate = value => value ? formatPOSDateTime(value) : "";
    const content = "\uFEFF" + [SALES_AUDIT_EXPORT_COLUMNS, ...salesAuditTransactions.map(row => {
        const values = {
            "Branch Name": row.business_name, "Branch Code": row.business_code, "Business Brand": row.business_name,
            "Business Date": auditDate(row.business_date), "Invoice Number": row.invoice_number, "Invoice Date": auditDate(row.invoice_date),
            "Customer TIN number/PAN no.": row.customer_gstin, "E-Invoice Customer TIN": row.customer_gstin,
            "Sale Status": row.order_status, "Fulfillment Status": row.order_status, "Order Number": row.order_number,
            "Order Source": row.public_tracking_token ? "QR Menu" : "POS", "Open Order Amount": 0,
            "Gross Amount": row.subtotal, "Discounts": row.discount, "Net Amount": row.net_amount,
            "Other Charge Amount": row.service_charge, "Taxes": row.gst, "Rounding": row.rounding_amount,
            "Total": row.bill_total, "Paid Amount": row.amount_collected, "Balance Due": row.amount_due,
            "% Discount": row.discount_percent, "Payment Modes": row.payment_modes,
            "Channel": row.sales_channel_key || row.order_type, "Channel Label": row.channel_label,
            "Tags": row.marketing_deal_name || row.discount_adjustment_name, "Order Notes": row.notes,
            "Resource Group Name": row.resource_group_names, "Number of Items": row.item_count,
            "Total Quantity": row.total_quantity, "Number Of People": row.pax,
            "Duration (Minutes)": row.duration_minutes, "Number of Tickets": row.number_of_tickets,
            "Modified After Print": row.modified_after_print, "Modified After Close": row.modified_after_close,
            "Change Logs After Print": row.changes_after_print, "Bill Print Log": auditDate(row.bill_printed_at),
            "Created Date": auditDate(row.created_at), "Created By": row.created_by, "Closed By": row.closed_by,
            "Sale By": row.created_by, "Delivery Mode": /deliver/i.test(String(row.order_type || "")) ? row.order_type : "",
            "Time to Accept": row.time_to_accept, "Time to Prepare": row.average_prep_minutes ?? row.time_to_prepare,
            "Customer Id": row.customer_id, "Customer Name": row.customer_name, "Customer Phone": row.customer_phone,
            "Deliver To Address": /deliver/i.test(String(row.order_type || "")) ? row.customer_address : "",
            "Reason For Cancel/Void/Non Chargeable": row.non_chargeable_reason || row.cancellation_reason,
            "Average Kitchen Prep Time (Minutes)": row.average_prep_minutes,
            "Longest Kitchen Prep Time (Minutes)": row.longest_prep_minutes,
            "Kitchen Stations": row.kitchen_stations
        };
        return SALES_AUDIT_EXPORT_COLUMNS.map(column => values[column] ?? "");
    })].map(row => row.map(csvSafeCell).join(",")).join("\r\n");
    const blobUrl = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `sale-transaction-audit-${getPOSDateKey()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function toggleCustomReportDates() {

    const filter =
        document.getElementById("reportDateFilter");

    const fromDate =
        document.getElementById("reportFromDate");

    const toDate =
        document.getElementById("reportToDate");


    if (!filter || !fromDate || !toDate) {
        return;
    }


    if (filter.value === "custom") {

        fromDate.style.display = "inline-block";

        toDate.style.display = "inline-block";

    } else {

        fromDate.style.display = "none";

        toDate.style.display = "none";

    }

}

async function loadReports() {

    try {

        console.log("📊 Loading reports...");


        // ======================================
        // GET REPORT FILTER
        // ======================================

        const filterElement =
            document.getElementById("reportDateFilter");


        const filter =
            filterElement
                ? filterElement.value
                : "today";


        console.log(
            "📅 Report filter:",
            filter
        );


        // ======================================
        // GET CUSTOM DATES
        // ======================================

        const fromDateElement =
            document.getElementById("reportFromDate");


        const toDateElement =
            document.getElementById("reportToDate");


        const fromDate =
            fromDateElement
                ? fromDateElement.value
                : "";


        const toDate =
            toDateElement
                ? toDateElement.value
                : "";

        let queryString = "?range=" + encodeURIComponent(filter);

if (filter === "custom") {
    if (!fromDate || !toDate) {
        alert("Please select both From Date and To Date.");
        return;
    }

    queryString +=
        "&from=" + encodeURIComponent(fromDate) +
        "&to=" + encodeURIComponent(toDate);
}


  


        // ======================================
        // UPDATE REPORT LABELS
        // ======================================

        const salesLabel =
            document.getElementById(
                "reportSalesLabel"
            );


        const ordersLabel =
            document.getElementById(
                "reportOrdersLabel"
            );


        const paymentLabel =
            document.getElementById(
                "reportPaymentLabel"
            );


        const bestItemsLabel =
            document.getElementById(
                "reportBestItemsLabel"
            );
        
        const orderTypeLabel =
    document.getElementById(
        "reportOrderTypeLabel"
    );


        let periodText = "Today";


        if (filter === "yesterday") {

            periodText = "Yesterday";

        }


        else if (filter === "week") {

            periodText = "This Week";

        }


        else if (filter === "month") {

            periodText = "This Month";

        }


        else if (filter === "custom") {

            periodText =
                fromDate +
                " to " +
                toDate;

        }


        if (salesLabel) {

            salesLabel.textContent =
                "💰 " +
                periodText +
                " Sales";

        }


        if (ordersLabel) {

            ordersLabel.textContent =
                "🧾 " +
                periodText +
                " Orders";

        }


        if (paymentLabel) {

            paymentLabel.textContent =
                periodText +
                " payment collection";

        }


        if (bestItemsLabel) {

            bestItemsLabel.textContent =
                "Top 10 items sold - " +
                periodText;

        }

        if (orderTypeLabel) {
    orderTypeLabel.textContent =
        "Sales by order type - " +
        periodText;
}


        // ======================================
        // REPORT SUMMARY
        // ======================================

        const summary =
            await api(
                "/reports/summary" +
                queryString
            );

    

        console.log(
            "📊 Report summary:",
            summary
        );


        const totalSales =
            getNumberValue(
                summary.totalSales,
                [
                    "total_sales",
                    "today_sales",
                    "sum"
                ]
            );


        const totalOrders =
            getNumberValue(
                summary.totalOrders,
                [
                    "total_orders",
                    "today_orders",
                    "count"
                ]
            );


        const averageOrder =
            getNumberValue(
                summary.averageOrder,
                [
                    "average_order",
                    "avg_order"
                ]
            );


        const itemsSold =
            getNumberValue(
                summary.itemsSold,
                [
                    "items_sold",
                    "total_items",
                    "sum"
                ]
            );


        // ======================================
        // UPDATE SUMMARY CARDS
        // ======================================

        setText(
            "reportTodaySales",
            money(totalSales)
        );


        setText(
            "reportTodayOrders",
            totalOrders
        );


        setText(
            "reportAverageOrder",
            money(averageOrder)
        );


        setText(
            "reportItemsSold",
            itemsSold
        );


        // ======================================
        // SALES BY PAYMENT METHOD
        // ======================================

        const payments =
            await api(
                "/reports/payments" +
                queryString
            );


        console.log(
            "💳 Payment report:",
            payments
        );

        try{
            const salesSummaryReport=await api("/reports/sales-summary"+queryString);
            renderSalesSummaryReport(salesSummaryReport);
        }catch(summaryError){
            console.warn("Sales summary report failed:",summaryError.message);
            const salesSummaryBody=document.getElementById("reportSalesSummaryBody");
            if(salesSummaryBody)salesSummaryBody.innerHTML=`<tr><td colspan="2">Unable to load sales summary: ${esc(summaryError.message)}</td></tr>`;
        }


        const paymentBody =
            document.getElementById(
                "reportPaymentBody"
            );


        if (paymentBody) {

            paymentBody.innerHTML = "";


            if (
                !Array.isArray(payments) ||
                payments.length === 0
            ) {

                paymentBody.innerHTML = `
                    <tr>
                        <td colspan="3">
                            No sales for this period.
                        </td>
                    </tr>
                `;

            }

            else {

                payments.forEach(
                    function(payment) {

                        const row =
                            document.createElement(
                                "tr"
                            );


                        const paymentMethod =
                            payment.payment_method ??
                            payment.method ??
                            "Unknown";


                        const orders =
                            getNumberValue(
                                payment.orders,
                                [
                                    "count",
                                    "total_orders"
                                ]
                            );


                        const amount =
                            getNumberValue(
                                payment.amount,
                                [
                                    "total_amount",
                                    "sum"
                                ]
                            );


                        row.innerHTML = `

                            <td>
                                ${esc(paymentMethod)}
                            </td>

                            <td>
                                ${orders}
                            </td>

                            <td>
                                ${money(amount)}
                            </td>

                        `;


                        paymentBody.appendChild(
                            row
                        );

                    }
                );

            }

        }


        // ======================================
        // BEST SELLING ITEMS
        // ======================================

        const bestItems =
            await api(
                "/reports/best-items" +
                queryString
            );


        console.log(
            "🔥 Best selling items:",
            bestItems
        );


        const bestItemsBody =
            document.getElementById(
                "reportBestItemsBody"
            );


        if (bestItemsBody) {

            bestItemsBody.innerHTML = "";


            if (
                !Array.isArray(bestItems) ||
                bestItems.length === 0
            ) {

                bestItemsBody.innerHTML = `
                    <tr>
                        <td colspan="3">
                            No sales for this period.
                        </td>
                    </tr>
                `;

            }

            else {

                bestItems.forEach(
                    function(item) {

                        const row =
                            document.createElement(
                                "tr"
                            );


                        const itemName =
                            item.item_name ??
                            item.name ??
                            "Unknown";


                        const quantity =
                            getNumberValue(
                                item.quantity_sold,
                                [
                                    "quantity",
                                    "total_quantity",
                                    "sum"
                                ]
                            );


                        const revenue =
                            getNumberValue(
                                item.revenue,
                                [
                                    "total_revenue",
                                    "total_amount",
                                    "sum"
                                ]
                            );


                        row.innerHTML = `

                            <td>
                                ${esc(itemName)}
                            </td>

                            <td>
                                ${quantity}
                            </td>

                            <td>
                                ${money(revenue)}
                            </td>

                        `;


                        bestItemsBody.appendChild(
                            row
                        );

                    }
                );

            }

        }

                // ======================================
        // SALES BY CATEGORY
        // ======================================

        const categories =
            await api(
                "/reports/category" +
                queryString
            );


        console.log(
            "📊 Category report:",
            categories
        );


        const categoryBody =
            document.getElementById(
                "reportCategoryBody"
            );


        if (categoryBody) {

            categoryBody.innerHTML = "";


            if (
                !Array.isArray(categories) ||
                categories.length === 0
            ) {

                categoryBody.innerHTML = `
                    <tr>
                        <td colspan="3">
                            No sales for this period.
                        </td>
                    </tr>
                `;

            } else {

                categories.forEach(
                    function(category) {

                        const row =
                            document.createElement(
                                "tr"
                            );


                        const categoryName =
                            category.category ||
                            "Uncategorized";


                        const quantity =
                            getNumberValue(
                                category.quantity_sold,
                                [
                                    "quantity",
                                    "quantitySold",
                                    "total_quantity"
                                ]
                            );


                        const revenue =
                            getNumberValue(
                                category.revenue,
                                [
                                    "total_revenue",
                                    "amount",
                                    "sum"
                                ]
                            );


                        row.innerHTML = `
                            <td>
                                ${esc(categoryName)}
                            </td>

                            <td>
                                ${quantity}
                            </td>

                            <td>
                                ${money(revenue)}
                            </td>
                        `;


                        categoryBody.appendChild(
                            row
                        );

                    }
                );

            }

        }

                // ======================================
        // SALES BY ORDER TYPE
        // ======================================

        const orderTypes =
            await api(
                "/reports/order-type" +
                queryString
            );


        console.log(
            "🍽️ Order type report:",
            orderTypes
        );


        const orderTypeBody =
            document.getElementById(
                "reportOrderTypeBody"
            );


        if (orderTypeBody) {

            orderTypeBody.innerHTML = "";


            if (
                !Array.isArray(orderTypes) ||
                orderTypes.length === 0
            ) {

                orderTypeBody.innerHTML = `
                    <tr>
                        <td colspan="3">
                            No sales for this period.
                        </td>
                    </tr>
                `;

            } else {

                orderTypes.forEach(
                    function(orderType) {

                        const row =
                            document.createElement(
                                "tr"
                            );


                        const type =
                            orderType.order_type ||
                            "Unknown";


                        const orders =
                            Number(
                                orderType.orders || 0
                            );


                        const sales =
                            Number(
                                orderType.sales || 0
                            );


                        row.innerHTML = `
                            <td>
                                ${esc(type)}
                            </td>

                            <td>
                                ${orders}
                            </td>

                            <td>
                                ${money(sales)}
                            </td>
                        `;


                        orderTypeBody.appendChild(
                            row
                        );

                    }
                );

            }

        }

        // DAILY SALES

const dailySales =
    await api(
        "/reports/daily" +
        queryString
    );

console.log(
    "📅 Daily sales report:",
    dailySales
);

const dailyBody =
    document.getElementById(
        "reportDailyBody"
    );

if (dailyBody) {

    dailyBody.innerHTML = "";

    if (
        !Array.isArray(dailySales) ||
        dailySales.length === 0
    ) {

        dailyBody.innerHTML =
            `<tr>
                <td colspan="3">
                    No sales for this period.
                </td>
            </tr>`;

    } else {

        dailySales.forEach(
            function(day) {

                const row =
                    document.createElement(
                        "tr"
                    );

                const date =
                    day.sale_date || "-";

                const orders =
                    Number(
                        day.orders || 0
                    );

                const sales =
                    Number(
                        day.sales || 0
                    );

                row.innerHTML =
                    `<td>${esc(date)}</td>
                     <td>${orders}</td>
                     <td>${money(sales)}</td>`;

                dailyBody.appendChild(
                    row
                );

            }
        );

    }

}

// GST / TAX REPORT

const gstReport =
    await api(
        "/reports/gst" +
        queryString
    );

console.log(
    "🧾 GST report:",
    gstReport
);

const gstBody =
    document.getElementById(
        "reportGstBody"
    );

if (gstBody) {

    gstBody.innerHTML = "";

    if (!gstReport) {

        gstBody.innerHTML =
            `<tr>
                <td colspan="4">
                    No GST data for this period.
                </td>
            </tr>`;

    } else {

        const orders =
            Number(
                gstReport.orders || 0
            );

        const taxableSales =
            Number(
                gstReport.taxable_sales || 0
            );

        const gst =
            Number(
                gstReport.gst || 0
            );

        const totalSales =
            Number(
                gstReport.total_sales || 0
            );

        const row =
            document.createElement(
                "tr"
            );

        row.innerHTML =
            `<td>${orders}</td>
             <td>${money(taxableSales)}</td>
             <td>${money(gst)}</td>
             <td>${money(totalSales)}</td>`;

        gstBody.appendChild(row);

    }

}


    } catch (error) {

        console.error(
            "❌ Reports failed:",
            error
        );

        alert(
            "Failed to load reports: " +
            error.message
        );

    }

}



function salesSummaryReportRows(data){
    const summary=data?.summary||{},payments=Array.isArray(data?.payments)?data.payments:[],charges=Array.isArray(data?.chargeBreakdown)?data.chargeBreakdown:[];
    const notTracked="Not tracked";
    const paidTotal=payments.reduce((sum,payment)=>sum+Number(payment.amount||0),0);
    return [
        ["Gross Sales (Net Sales - Direct Charges + Discounts + Sales Return)",Number(summary.gross_sales||0)],
        ["Sales Return",notTracked],
        ["Discounts",-Number(summary.discounts||0)],
        ["Packaging charges (Direct Charges)",notTracked],
        ["Net Sales",Number(summary.net_sales||0)],
        ["Service charges (Indirect Charges)",Number(summary.service_charges||0)],
        ["Taxes",Number(summary.taxes||0)],
        ["Rounding",Number(summary.rounding||0)],
        ["Tip",notTracked],
        ["No. of people (PAX)",Number(summary.pax||0)],
        ["Total Gross Revenue",Number(summary.total_gross_revenue||0)],
        ["Payment Balance",Number(summary.payment_balance||0)],
        ["", ""],
        ["Cost of Goods Sold",notTracked],
        ["Materials",notTracked],
        ["Materials Audit",notTracked],
        ["Materials Voided",notTracked],
        ["Margin on Net Sales",notTracked],
        ["", ""],
        ["Payment Summary",paidTotal],
        ...payments.map(payment=>[String(payment.payment_method||"Unknown"),Number(payment.amount||0)]),
        ["", ""],
        ["Charge Total",Number(summary.service_charges||0)],
        ["", ""],
        ...charges.map(charge=>[String(charge.name||"Service charges (Indirect Charges)"),Number(charge.amount||0)])
    ];
}
function renderSalesSummaryReport(data){
    const body=document.getElementById("reportSalesSummaryBody");if(!body)return;
    body.innerHTML=salesSummaryReportRows(data).map(([description,total])=>description
        ?`<tr><td>${esc(description)}</td><td>${typeof total==="number"?money(total):esc(total)}</td></tr>`
        :'<tr class="sales-summary-spacer"><td></td><td></td></tr>').join("");
}
async function downloadSalesSummaryCSV(){
    if(!hasPermission("reports","export"))return showProfileToast("You don’t have permission to export reports.");
    try{
        const query=orderCategoryReportQuery(true,true);if(!query)return;
        const data=await api(`/reports/sales-summary?${query}`);
        downloadCsvRows(`cafe-pos-sales-summary-${getPOSDateKey()}.csv`,[["Description","Total"],...salesSummaryReportRows(data)]);
        showProfileToast("Sales summary report downloaded.");
    }catch(error){alert(error.message||"Could not download the sales summary.");}
}

window.exportCompleteReportCSV = function() {

    if(!hasPermission("reports","export"))return showProfileToast("You don’t have permission to export reports.");

    console.log("📊 Complete report export started.");

    function csvEscape(value) {
        return csvSafeCell(value);
    }

    function appendTable(title, headers, bodyId) {

        csv += title + "\r\n";
        csv += headers.map(csvEscape).join(",") + "\r\n";

        const body = document.getElementById(bodyId);

        if (!body) {
            csv += csvEscape("No data available") + "\r\n\r\n";
            return;
        }

        const rows = body.querySelectorAll("tr");
        let count = 0;

        rows.forEach(function(row) {

            const cells = row.querySelectorAll("td");

            if (cells.length >= headers.length) {

                const values = Array.from(cells)
                    .slice(0, headers.length)
                    .map(function(cell) {
                        return cell.textContent.replace(/\s+/g, " ").trim();
                    });

                csv += values.map(csvEscape).join(",") + "\r\n";
                count++;
            }
        });

        if (!count) {
            csv += csvEscape("No data available") + "\r\n";
        }

        csv += "\r\n";
    }

    let csv = "";

    const filter =
        document.getElementById("reportDateFilter")?.value || "today";

    const from =
        document.getElementById("reportFromDate")?.value || "";

    const to =
        document.getElementById("reportToDate")?.value || "";

    csv += csvEscape("SLASH POS COMPLETE REPORT") + "\r\n";
    csv += csvEscape("Report Range") + "," + csvEscape(filter) + "\r\n";

    if (from) {
        csv += csvEscape("From") + "," + csvEscape(from) + "\r\n";
    }

    if (to) {
        csv += csvEscape("To") + "," + csvEscape(to) + "\r\n";
    }

    csv += "\r\n";

    csv += "SALES SUMMARY\r\n";
    csv += "Metric,Value\r\n";

    const summary = [
        ["Total Sales", document.getElementById("reportTodaySales")?.innerText?.trim() || "0"],
        ["Total Orders", document.getElementById("reportTodayOrders")?.innerText?.trim() || "0"],
        ["Average Order", document.getElementById("reportAverageOrder")?.innerText?.trim() || "0"],
        ["Items Sold", document.getElementById("reportItemsSold")?.innerText?.trim() || "0"]
    ];

    summary.forEach(function(row) {
        csv += csvEscape(row[0]) + "," + csvEscape(row[1]) + "\r\n";
    });

    csv += "\r\n";

    appendTable(
        "SALES SUMMARY",
        ["Description", "Total"],
        "reportSalesSummaryBody"
    );

    appendTable(
        "PAYMENT BREAKDOWN",
        ["Payment Method", "Orders", "Amount"],
        "reportPaymentBody"
    );

    appendTable(
        "BEST SELLING ITEMS",
        ["Item", "Quantity Sold", "Revenue"],
        "reportBestItemsBody"
    );

    appendTable(
        "SALES BY CATEGORY",
        ["Category", "Quantity Sold", "Revenue"],
        "reportCategoryBody"
    );

    appendTable(
        "SALES BY ORDER TYPE",
        ["Order Type", "Orders", "Sales"],
        "reportOrderTypeBody"
    );

    appendTable(
        "DAILY SALES",
        ["Date", "Orders", "Sales"],
        "reportDailyBody"
    );

    appendTable(
        "GST / TAX REPORT",
        ["Orders", "Taxable Sales", "GST Collected", "Total Sales"],
        "reportGstBody"
    );

    appendTable(
        "SALE TRANSACTION AUDIT",
        ["Business date", "Invoice date", "Invoice number", "Order number", "Channel / table", "Customer", "Payment modes", "Gross", "Discount", "Other charges", "Taxes", "Total", "Paid", "Balance due", "Sale status"],
        "salesAuditBody"
    );

    appendTable(
        "DISCOUNTED ORDERS",
        ["Order", "Date", "Type", "Table", "Discount", "Discount Rule", "Payment", "Total"],
        "reportDiscountOrdersBody"
    );

    appendTable(
        "NON-CHARGEABLE ORDERS",
        ["Order", "Date", "Type", "Table", "Reason", "Order Value", "Payment"],
        "reportNonChargeableOrdersBody"
    );

    const blob = new Blob(
        ["\uFEFF", csv],
        { type: "text/csv;charset=utf-8;" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
        "cafe-pos-complete-report.csv";

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(function() {
        URL.revokeObjectURL(url);
    }, 500);

    console.log("✅ Complete report exported successfully.");
};


// ==========================================
// EXPORT DAILY SALES CSV
// ==========================================

window.exportReportsCSV = function () {

    if(!hasPermission("reports","export"))return showProfileToast("You don’t have permission to export reports.");

    console.log("Export CSV clicked");

    const table = document.getElementById("reportDailyBody");

    if (!table) {
        alert("Daily sales report not found.");
        return;
    }

    const rows = table.querySelectorAll("tr");

    if (rows.length === 0) {
        alert("No report data available.");
        return;
    }

    let csv = "Date,Orders,Sales\r\n";

    rows.forEach(function (row) {

        const cells = row.querySelectorAll("td");

        if (cells.length !== 3) {
            return;
        }

        const date = cells[0].innerText.trim();
        const orders = cells[1].innerText.trim();
        const sales = cells[2].innerText.trim();

        const safeDate = date.replace(/"/g, '""');
        const safeOrders = orders.replace(/"/g, '""');
        const safeSales = sales.replace(/"/g, '""');

        csv +=
            '"' +
            safeDate +
            '","' +
            safeOrders +
            '","' +
            safeSales +
            '"\r\n';
    });

    const blob = new Blob(
        ["\uFEFF", csv],
        {
            type: "text/csv;charset=utf-8;"
        }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = "cafe-pos-daily-sales.csv";

    document.body.appendChild(link);

    link.click();

    document.body.removeChild(link);

    setTimeout(function () {
        URL.revokeObjectURL(url);
    }, 100);

    console.log("CSV exported successfully.");
};



// ==========================================
// STEP 15-19 FEATURE MODULES
// ==========================================

function focusBillingSearch(){document.getElementById('billingMenuSearch')?.focus();}
function clearBillingCart(){if(confirm('Clear all items from this bill?')){cart=[];updateCart();}}
function filterBillingMenu(value){const q=String(value||'').toLowerCase().trim();document.querySelectorAll('#new-order .food-card').forEach(card=>{card.style.display=(!q||card.textContent.toLowerCase().includes(q))?'':'none';});}

async function loadExpenses(){
  try{const q=new URLSearchParams();const f=document.getElementById('expenseFrom')?.value,t=document.getElementById('expenseTo')?.value;if(f)q.set('from',f);if(t)q.set('to',t);const [rows,sum,cats]=await Promise.all([api('/expenses?'+q.toString()),api('/expenses/summary?'+q.toString()),api('/expenses/categories')]);
    setText('expenseTotal',money(sum?.total?.total ?? sum?.total ?? 0));setText('expenseCount',sum?.count||0);window._expenseCategories=cats;const body=document.getElementById('expensesBody');if(!body)return;body.innerHTML=rows.length?rows.map(e=>`<tr><td>${esc(e.expense_date)}</td><td>${esc(e.category_name||'Uncategorised')}</td><td>${money(e.amount)}</td><td>${esc(e.payment_method)}</td><td>${esc(e.note||'')}</td><td>${esc(e.created_by_name||'-')}</td><td><button class="table-action-btn" onclick="deleteExpense(${e.id})">Delete</button></td></tr>`).join(''):'<tr><td colspan="7">No expenses found.</td></tr>';
  }catch(e){console.error(e);const b=document.getElementById('expensesBody');if(b)b.innerHTML=`<tr><td colspan="7">${esc(e.message)}</td></tr>`;}
}
function openExpenseModal(){renderPaymentModeOptions();const m=document.getElementById('expenseModal');if(m)m.style.display='flex';const d=document.getElementById('expenseDate');if(d&&!d.value)d.value=getPOSDateKey();loadExpenseCategories();}
function closeExpenseModal(){document.getElementById('expenseModal')?.style.setProperty('display','none');}
async function loadExpenseCategories(){try{const cats=await api('/expenses/categories');const s=document.getElementById('expenseCategory');if(s)s.innerHTML=cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');}catch(e){}}
async function saveExpense(){try{const amount=Number(document.getElementById('expenseAmount')?.value||0);if(amount<=0)return alert('Enter a valid expense amount.');await api('/expenses',{method:'POST',body:JSON.stringify({categoryId:Number(document.getElementById('expenseCategory')?.value||0)||null,amount,paymentMethod:document.getElementById('expensePayment')?.value||preferredPaymentMethod(),expenseDate:document.getElementById('expenseDate')?.value||null,note:document.getElementById('expenseNote')?.value||''})});closeExpenseModal();document.getElementById('expenseAmount').value='';document.getElementById('expenseNote').value='';await loadExpenses();alert('Expense saved.');}catch(e){alert(e.message);}}
async function deleteExpense(id){if(!confirm('Delete this expense?'))return;try{await api('/expenses/'+id,{method:'DELETE'});await loadExpenses();}catch(e){alert(e.message);}}

async function loadLoyaltySettings(){try{const s=await api('/loyalty/settings');setSettingValue('loyaltyPointsPerCurrency',s.points_per_currency);setSettingValue('loyaltyCurrencyPerPoint',s.currency_per_point);setSettingValue('loyaltyMinRedeem',s.min_redeem_points);setSettingValue('loyaltyWelcome',s.welcome_points);setSettingValue('loyaltyEnabled',s.enabled);await loadLoyaltyCustomers();}catch(e){console.error(e);}}
async function saveLoyaltySettings(){try{await api('/loyalty/settings',{method:'PUT',body:JSON.stringify({pointsPerCurrency:Number(document.getElementById('loyaltyPointsPerCurrency')?.value||0),currencyPerPoint:Number(document.getElementById('loyaltyCurrencyPerPoint')?.value||1),minRedeemPoints:Number(document.getElementById('loyaltyMinRedeem')?.value||100),welcomePoints:Number(document.getElementById('loyaltyWelcome')?.value||0),enabled:document.getElementById('loyaltyEnabled')?.checked!==false})});alert('Loyalty settings saved.');}catch(e){alert(e.message);}}
async function loadLoyaltyCustomers(){try{const rows=await api('/customers');const s=document.getElementById('loyaltyCustomerSelect');if(s)s.innerHTML='<option value="">Select customer…</option>'+rows.map(c=>`<option value="${c.id}">${esc(c.name)} · ${esc(c.phone||'')}</option>`).join('');}catch(e){}}
async function loadSelectedLoyaltyCustomer(){const id=document.getElementById('loyaltyCustomerSelect')?.value;if(!id)return;try{const r=await api('/loyalty/customers/'+id);setText('loyaltyBalance',r.balance);const b=document.getElementById('loyaltyHistoryBody');if(b)b.innerHTML=r.history.length?r.history.map(h=>`<tr><td>${esc(formatPOSDateTime(h.created_at))}</td><td>${esc(h.transaction_type)}</td><td>${h.points>0?'+':''}${h.points}</td><td>${esc(h.note||'')}</td></tr>`).join(''):'<tr><td colspan="4">No loyalty transactions.</td></tr>';}catch(e){alert(e.message);}}


function saveInvoiceDesigner(){appSettings.accentLabel=document.getElementById('designerAccent')?.value||'';appSettings.logoUrl=document.getElementById('designerLogo')?.value||'';appSettings.receiptFont=document.getElementById('designerFontSize')?.value||'13';appSettings.designerShowNotes=document.getElementById('designerShowNotes')?.checked!==false;appSettings.designerShowInvoiceMeta=document.getElementById('designerShowInvoiceMeta')?.checked!==false;appSettings.designerCompact=document.getElementById('designerCompact')?.checked===true;localStorage.setItem(settingsLocalStorageKey(),JSON.stringify(appSettings));renderInvoiceDesignerPreview();api('/settings',{method:'PUT',body:JSON.stringify(appSettings)}).then(()=>alert('Invoice design saved.')).catch(()=>alert('Saved locally; server settings unavailable.'));}
function renderInvoiceDesignerPreview(){const p=document.getElementById('invoiceDesignerPreview');if(!p)return;const font=document.getElementById('designerFontSize')?.value||'13';const logo=businessLogoUrl()||document.getElementById('designerLogo')?.value||appSettings.logoUrl;const name=appSettings.restaurantName||'SLASH POS';p.innerHTML=`${logo?`<img src="${esc(logo)}" alt="logo" class="invoice-preview-logo">`:''}<div class="invoice-preview-name">${esc(name)}</div><div>${esc(document.getElementById('designerAccent')?.value||'Cafe Receipt')}</div><hr><div class="preview-row"><span>Invoice</span><b>INV-000123</b></div><div class="preview-row"><span>Order</span><b>ORD-00123</b></div><hr><div class="preview-line"><span>☕ Cappuccino ×2</span><b>₹240.00</b></div><div class="preview-line"><span>🥪 Sandwich ×1</span><b>₹180.00</b></div><hr><div class="preview-row"><span>Subtotal</span><span>₹420.00</span></div><div class="preview-row"><span>GST</span><span>₹21.00</span></div><div class="preview-row preview-total"><span>Total</span><b>₹441.00</b></div><p style="margin-top:12px">${esc(appSettings.customerMessage||'Thank you for visiting!')}</p>`;p.style.fontSize=font+'px';}

async function discoverWindowsPrinters(){
    const serviceUrl = window.CAFE_PRINT_SERVICE_URL || "http://127.0.0.1:18181";
    const select = document.getElementById("windowsPrinterSelect");
    const status = document.getElementById("windowsPrinterStatus");
    if(status) status.textContent = "Detecting Windows printers…";
    try {
        const response = await fetch(serviceUrl + "/printers", { cache: "no-store" });
        const result = await response.json();
        if(!response.ok) throw new Error(result.error || "Could not read Windows printers.");
        window.cafeWindowsPrinters = Array.isArray(result.printers) ? result.printers : [];
        if(select){
            select.innerHTML = '<option value="">Select a Windows printer…</option>' +
                window.cafeWindowsPrinters.map(function(p){
                    return '<option value="'+esc(p.name)+'">'+esc(p.name)+(p.status ? ' — '+esc(p.status) : '')+'</option>';
                }).join('');
        }
        if(status) status.textContent = window.cafeWindowsPrinters.length + " Windows printer(s) found.";
    } catch(e) {
        window.cafeWindowsPrinters = [];
        if(select) select.innerHTML = '<option value="">Printer service not connected</option>';
        if(status) status.textContent = "Can't reach the local printer service. Reopen the desktop POS app, or start the printer helper if you use the web version.";
    }
}

function useSelectedWindowsPrinter(){
    const select = document.getElementById("windowsPrinterSelect");
    const name = select?.value || "";
    if(!name) return;
    document.getElementById("printerName").value = name;
    showPrinterMessage("Selected Windows printer: " + name + ". Click Save Printer.");
}

function printerFormValue(id){return document.getElementById(id)?.value||""}
function showPrinterMessage(text,error=false){const el=document.getElementById("printerMessage");if(!el)return;el.textContent=text;el.classList.toggle("error",error)}
function togglePrinterFields(){const type=printerFormValue("printerType");document.getElementById("localPrinterFields").style.display=type==="local"?"block":"none";document.getElementById("networkPrinterFields").style.display=type==="network"?"grid":"none";document.getElementById("bluetoothPrinterFields").style.display=type==="bluetooth"?"block":"none";if(type==="local")discoverWindowsPrinters()}
function resetPrinterForm(){document.getElementById("printerForm")?.reset();document.getElementById("printerId").value="";document.getElementById("printerType").value="local";document.getElementById("printerPort").value="9100";document.getElementById("printerServiceUuid").value="000018f0-0000-1000-8000-00805f9b34fb";document.getElementById("printerCharacteristicUuid").value="00002af1-0000-1000-8000-00805f9b34fb";document.getElementById("printerFormTitle").textContent="Add Printer";togglePrinterFields()}
function renderPrinters(){const body=document.getElementById("printersBody");if(!body)return;const rows=window.cafePrinters||[];body.innerHTML=rows.map(function(p){const type=p.connection_type||"local";const address=type==="network"?esc(p.host)+":"+esc(p.port):type==="bluetooth"?esc(p.bluetooth_name||p.name):"Windows direct printing";const label=type==="network"?"Network / IP":type==="bluetooth"?"Bluetooth":"Local computer";return '<tr><td>'+esc(p.name)+'</td><td>'+label+'</td><td>'+address+'</td><td>'+esc(p.paper_width)+'mm</td><td>'+(p.is_default?'<span class="access-status active">Default</span>':'—')+'</td><td><div class="action-row"><button type="button" onclick="testPrinter('+Number(p.id)+')">Test</button><button type="button" class="cancel-btn" onclick="editPrinter('+Number(p.id)+')">Edit</button><button type="button" class="danger-btn" onclick="deletePrinter('+Number(p.id)+')">Delete</button></div></td></tr>'}).join("")||'<tr><td colspan="6">No printers saved for this business.</td></tr>'}
async function loadPrinters(){try{window.cafePrinters=await api("/printers");setText("printerCount",window.cafePrinters.length);renderPrinters();showPrinterMessage("");await discoverWindowsPrinters()}catch(e){window.cafePrinters=[];setText("printerCount",0);renderPrinters();showPrinterMessage(e.message,true);await discoverWindowsPrinters()}}
function editPrinter(id){const p=(window.cafePrinters||[]).find(function(x){return Number(x.id)===Number(id)});if(!p)return;document.getElementById("printerId").value=p.id;document.getElementById("printerName").value=p.name||"";document.getElementById("printerType").value=p.connection_type||"local";document.getElementById("printerHost").value=p.host||"";document.getElementById("printerPort").value=p.port||9100;document.getElementById("printerBluetoothName").value=p.bluetooth_name||"";document.getElementById("printerServiceUuid").value=p.service_uuid||"000018f0-0000-1000-8000-00805f9b34fb";document.getElementById("printerCharacteristicUuid").value=p.characteristic_uuid||"00002af1-0000-1000-8000-00805f9b34fb";document.getElementById("printerPaperWidth").value=p.paper_width||"80";document.getElementById("printerIsDefault").checked=Boolean(p.is_default);document.getElementById("printerFormTitle").textContent="Edit Printer";togglePrinterFields();document.getElementById("kot-groups").scrollIntoView({behavior:"smooth",block:"start"})}
async function savePrinter(){try{const id=printerFormValue("printerId");const type=printerFormValue("printerType");const selectedWindowsPrinter=type==="local"?(document.getElementById("windowsPrinterSelect")?.value||""):"";const printerName=(type==="local"&&selectedWindowsPrinter)?selectedWindowsPrinter:printerFormValue("printerName").trim();const body={name:printerName,connectionType:type,host:printerFormValue("printerHost").trim(),port:Number(printerFormValue("printerPort")||9100),bluetoothName:printerFormValue("printerBluetoothName").trim(),serviceUuid:printerFormValue("printerServiceUuid").trim(),characteristicUuid:printerFormValue("printerCharacteristicUuid").trim(),paperWidth:printerFormValue("printerPaperWidth")||"80",isDefault:document.getElementById("printerIsDefault").checked};const saved=await api(id?"/printers/"+id:"/printers",{method:id?"PUT":"POST",body:JSON.stringify(body)});showPrinterMessage("Printer saved.");resetPrinterForm();await loadPrinters();if(saved.printer)showPrinterMessage("Saved "+saved.printer.name+".")}catch(e){showPrinterMessage(e.message,true)}}
async function deletePrinter(id){if(!confirm("Delete this saved printer?"))return;try{await api("/printers/"+id,{method:"DELETE"});await loadPrinters();showPrinterMessage("Printer deleted.")}catch(e){showPrinterMessage(e.message,true)}}
function printerReceiptText(data,paperWidth="80"){
    const width=paperWidth==="58"?32:48;
    const currency=appSettings.currency||"₹";
    const moneyValue=value=>currency+Number(value||0).toFixed(2);
    const clean=value=>String(value??"").replace(/[\u0000-\u001f\u007f]/g," ").trim();
    const items=Array.isArray(data.items)?data.items:[];
    const allocations=Array.isArray(data.paymentAllocations)?data.paymentAllocations:[];
    const taxBreakdown=Array.isArray(data.taxBreakdown)?data.taxBreakdown:buildBillTaxBreakdown(data.items,data.discount,data.gst);
    const amountCollected=data.amountCollected===undefined?allocations.reduce((sum,payment)=>sum+Number(payment.amount||0),0):Number(data.amountCollected||0);
    const amountDue=data.amountDue===undefined?Math.max(0,Number(data.total||0)-amountCollected):Number(data.amountDue||0);
    const wrap=(value,limit=width)=>{const words=clean(value).split(/\s+/);const result=[];let line="";for(let word of words){while(word.length>limit){if(line)result.push(line);result.push(word.slice(0,limit));word=word.slice(limit);line="";}if(!word)continue;const next=line?line+" "+word:word;if(next.length>limit){if(line)result.push(line);line=word;}else line=next;}if(line)result.push(line);return result;};
    const pair=(label,value)=>{const right=String(value??"");const left=String(label||"");if(left.length+right.length+1<=width)return[left.padEnd(width-right.length)+right];return[...wrap(left),...wrap(right).map((line,index)=>index===0?line.padStart(width):line)];};
    const divider="-".repeat(width),lines=[];
    const add=(value)=>lines.push(...wrap(value));
    const center=(value)=>wrap(value).map(line=>line.padStart(Math.floor((width+line.length)/2)));
    const legalName=clean(appSettings.businessLegalName||"");
    center(appSettings.restaurantName||"SLASH POS").forEach(line=>lines.push(line));
    if(legalName)center(legalName).forEach(line=>lines.push(line));
    wrap(appSettings.address||"").forEach(line=>lines.push(...center(line)));
    if(appSettings.phone)center("Phone: "+appSettings.phone).forEach(line=>lines.push(line));
    if(appSettings.gstin)center("GST#: "+appSettings.gstin).forEach(line=>lines.push(line));
    if(appSettings.fssai)center("FSSAI#: "+appSettings.fssai).forEach(line=>lines.push(line));
    const customHeader=clean(appSettings.header||"");
    if(customHeader&&customHeader!=="Cafe Management System")customHeader.split(/\r?\n/).forEach(value=>center(value).forEach(line=>lines.push(line)));
    center(data.isOpenOrder?"Order":"Invoice").forEach(line=>lines.push(line));
    if(data.tokenNumber)add("Token No: "+data.tokenNumber);
    add(data.customerName||"Guest");
    const customerCode=data.customerCode||(data.customerId?"#"+data.customerId:"");
    if(customerCode)add(customerCode);
    lines.push(divider);
    const totalQty=items.reduce((sum,item)=>sum+Math.max(0,Number(item.quantity||0)),0);
    const invoiceLabel=data.isOpenOrder?(data.orderNumber||"-"):(data.invoiceNumber||data.orderNumber||"-");
    lines.push(...pair((data.isOpenOrder?"Order ":"Invoice ")+invoiceLabel,`${items.length} ${items.length===1?"item":"items"} (${totalQty} Qty)`));
    lines.push(...pair(data.date||formatPOSDateTime(),data.cashierName||""));
    const orderContext=[data.orderType,data.tableNumber?"Table "+data.tableNumber:"",Number(data.pax)>0?Number(data.pax)+" PAX":""].filter(Boolean).join(" · ");
    if(orderContext)add(orderContext);
    lines.push(divider);
    items.forEach((item,index)=>{
        const name=appSettings.uppercaseItems?clean(item.name||"-").toUpperCase():clean(item.name||"-");
        add((index+1)+". "+name);
        const qty=Number(item.quantity||0),price=Number(item.price||0),unit=clean(item.unit||"ea");
        const lineTotal=Number(item.lineTotal)>0||price===0?Number(item.lineTotal||0):qty*price;
        lines.push(...pair("  "+qty+" @ "+moneyValue(price)+"/"+unit,moneyValue(lineTotal)));
        const options=formatItemOptionNames(item.options);if(options)add("  "+options);
    });
    lines.push(divider,...pair("Sub Total",moneyValue(data.subtotal||0)));
    if(Number(data.discount||0)>0)lines.push(...pair(data.discountName?"Discount · "+data.discountName:"Discount","-"+moneyValue(data.discount)));
    if(Number(data.serviceCharge||0)>0)lines.push(...pair(data.chargeName?"Charges · "+data.chargeName:"Charges",moneyValue(data.serviceCharge)));
    if(taxBreakdown.length){
        taxBreakdown.forEach(row=>lines.push(...pair(`${clean(row.component||"Tax")} ${formatBillTaxRate(row.rate)}% on ${moneyValue(row.taxableBase||0)}`,moneyValue(row.taxAmount))));
    }else if(Number(data.gst||0)>0)lines.push(...pair("GST",moneyValue(data.gst)));
    const roundedTotal=Number(data.total||0),rounding=Number(data.roundingAdjustment||0);
    lines.push(...pair("Bill Total",moneyValue(roundedTotal-rounding)),...pair("Bill Total (rounded)",moneyValue(roundedTotal)));
    if(!data.isOpenOrder){
        lines.push("Payment Summary");
        if(allocations.length)allocations.forEach(payment=>lines.push(...pair(String(payment.method||"Payment"),moneyValue(payment.amount||0))));
        else lines.push(...pair(data.paymentMethod||"Payment",moneyValue(amountCollected)));
        lines.push(...pair("Balance",moneyValue(amountDue)));
    }
    lines.push(divider,...center("RCM applicable: NO"));
    const footer=String(appSettings.footer||appSettings.customerMessage||"Visit Again!\nThank you.").replace("Thank You!\nVisit Again 😊","Visit Again!\nThank you.");
    footer.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).forEach(value=>center(value).forEach(line=>lines.push(line)));
    return lines.filter(Boolean).join("\n")+"\n\n\n";
}
function isBluetoothSelectionCancelled(error){return /user cancell?ed the requestdevice\(\) chooser|bluetooth.*selection.*cancell?ed/i.test(String(error?.message||error||""))}
function bluetoothSelectionMessage(error){return isBluetoothSelectionCancelled(error)?"Bluetooth selection was cancelled. Try again and choose the powered-on printer from the device list.":String(error?.message||error||"Bluetooth device selection failed.")}
function renderDesktopBluetoothDevices(payload={}){
    const picker=document.getElementById("desktopBluetoothPicker");
    const list=document.getElementById("desktopBluetoothDeviceList");
    const status=document.getElementById("desktopBluetoothStatus");
    if(!picker||!list||!status)return;
    picker.hidden=false;
    const devices=Array.isArray(payload.devices)?payload.devices:[];
    status.textContent=devices.length?`Found ${devices.length} nearby device${devices.length===1?"":"s"}. Select your printer.`:"Searching for nearby Bluetooth printers…";
    list.innerHTML=devices.length?devices.map(device=>`<button type="button" class="desktop-bluetooth-device" data-device-id="${esc(device.deviceId)}"><span class="desktop-bluetooth-device-mark" aria-hidden="true">ᛒ</span><span class="desktop-bluetooth-device-copy"><strong>${esc(device.deviceName||"Unnamed Bluetooth device")}</strong><small>Bluetooth device</small></span></button>`).join(""):'<div class="desktop-bluetooth-empty"><span aria-hidden="true">⌕</span><span>No devices found yet. Keep the printer on and in pairing mode.</span></div>';
    list.querySelectorAll(".desktop-bluetooth-device").forEach(button=>button.addEventListener("click",()=>{
        const deviceId=button.getAttribute("data-device-id")||"";
        if(!deviceId)return;
        window.cafePOSDesktop?.selectBluetoothDevice(deviceId);
        picker.hidden=true;
    }));
}
function setupDesktopBluetoothPicker(){
    const desktop=window.cafePOSDesktop;
    if(!desktop?.onBluetoothDevices)return;
    const picker=document.getElementById("desktopBluetoothPicker");
    const cancel=document.getElementById("desktopBluetoothCancel");
    const stopDevices=desktop.onBluetoothDevices(renderDesktopBluetoothDevices);
    const stopFinished=desktop.onBluetoothSelectionFinished(()=>{if(picker)picker.hidden=true;});
    cancel?.addEventListener("click",()=>{
        if(picker)picker.hidden=true;
        desktop.cancelBluetoothSelection();
    });
    picker?.addEventListener("keydown",event=>{
        if(event.key!=="Escape")return;
        event.preventDefault();
        if(picker)picker.hidden=true;
        desktop.cancelBluetoothSelection();
    });
    window.addEventListener("beforeunload",()=>{stopDevices?.();stopFinished?.();},{once:true});
}
async function sendBluetoothPrinterText(printer,text,center=true){
    if(!navigator.bluetooth)throw new Error("Bluetooth printing is unavailable. Use a Windows Bluetooth printer or a browser with Bluetooth support.");
    const serviceUuid=printer.service_uuid||printer.serviceUuid||"000018f0-0000-1000-8000-00805f9b34fb";
    const characteristicUuid=printer.characteristic_uuid||printer.characteristicUuid||"00002af1-0000-1000-8000-00805f9b34fb";
    const name=String(printer.bluetooth_name||printer.bluetoothName||printer.name||"").trim();
    const requestOptions=name?{filters:[{namePrefix:name}],optionalServices:[serviceUuid]}:{acceptAllDevices:true,optionalServices:[serviceUuid]};
    const device=await navigator.bluetooth.requestDevice(requestOptions);
    const server=await device.gatt.connect();
    try{
        const service=await server.getPrimaryService(serviceUuid);
        const characteristic=await service.getCharacteristic(characteristicUuid);
        const bytes=new TextEncoder().encode(text);
        const payload=new Uint8Array(bytes.length+11);
        payload.set(center?[0x1b,0x40,0x1b,0x61,0x01]:[0x1b,0x40,0x1b,0x61,0x00],0);
        payload.set(bytes,5);
        payload.set([0x0a,0x0a,0x0a,0x1d,0x56,0x00],5+bytes.length);
        const writeChunk=chunk=>characteristic.writeValueWithoutResponse?characteristic.writeValueWithoutResponse(chunk):characteristic.writeValue(chunk);
        for(let i=0;i<payload.length;i+=20)await writeChunk(payload.slice(i,i+20));
    }finally{if(device.gatt.connected)device.gatt.disconnect();}
}
async function pairBluetoothFromForm(){
    try{
        if(!navigator.bluetooth)throw new Error("Bluetooth setup is unavailable in this desktop app. Update Slash and try again.");
        const serviceUuid=printerFormValue("printerServiceUuid")||"000018f0-0000-1000-8000-00805f9b34fb";
        const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[serviceUuid]});
        const name=device.name||"Bluetooth Printer";
        document.getElementById("printerBluetoothName").value=name;
        if(!printerFormValue("printerName"))document.getElementById("printerName").value=name;
        showPrinterMessage("Selected "+name+". Save the printer to finish setup.");
    }catch(error){showPrinterMessage(bluetoothSelectionMessage(error),!isBluetoothSelectionCancelled(error));}
}
async function printLocalPrinterTest(name){
    try {
        if (window.cafePOSDesktop?.saveReceiptPdf && /microsoft print to pdf/i.test(name)) {
            const result = await window.cafePOSDesktop.saveReceiptPdf({
                kind: "test",
                receipt: "SLASH POS\nPRINTER TEST\n" + name + "\n" + formatPOSDateTime() + "\n\n\n"
            });
            if (!result?.success || !result.outputFile) throw new Error(result?.error || "Could not create the test PDF.");
            showPrinterMessage("Test PDF saved to " + result.outputFile);
            return;
        }
        const serviceUrl = window.CAFE_PRINT_SERVICE_URL || "http://127.0.0.1:18181";
        const response = await fetch(serviceUrl + "/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ printerName: name })
        });
        const result = await response.json().catch(function(){ return {}; });
        if (!response.ok) throw new Error(result.error || "Windows print service error.");
        showPrinterMessage(result.outputFile ? "Test PDF saved to " + result.outputFile : "Test print sent to " + name + ".");
    } catch(e) {
        const serviceUnavailable = e instanceof TypeError || /failed to fetch|econnrefused/i.test(String(e.message || ""));
        showPrinterMessage(serviceUnavailable
            ? "Can't connect to the local printer service. Reopen the desktop POS app and try again."
            : "Windows printer test failed: " + e.message, true);
    }
}
async function testPrinter(id){const printer=(window.cafePrinters||[]).find(function(p){return Number(p.id)===Number(id)});if(!printer)return;try{if(printer.connection_type==="local"){printLocalPrinterTest(printer.name);return}if(printer.connection_type==="bluetooth"){await sendBluetoothPrinterText(printer,"SLASH POS PRINTER TEST\n"+printer.name+"\nConnection successful.\n\n\n");showPrinterMessage("Bluetooth test sent to "+printer.name+".");return}await api("/printers/"+id+"/test",{method:"POST"});showPrinterMessage("Network printer test sent.")}catch(e){showPrinterMessage(bluetoothSelectionMessage(e),!isBluetoothSelectionCancelled(e))}}
function orderCategoryReportQuery(includeExport = false, notify = false) {
    const range = document.getElementById("reportDateFilter")?.value || "today";
    const params = new URLSearchParams({ range });
    if (range === "custom") {
        const from = document.getElementById("reportFromDate")?.value || "";
        const to = document.getElementById("reportToDate")?.value || "";
        if (!from || !to) {
            if (notify) alert("Choose both the start and end dates for this report.");
            return null;
        }
        if (from > to) {
            if (notify) alert("The report start date must be before the end date.");
            return null;
        }
        params.set("from", from);
        params.set("to", to);
    }
    if (includeExport) params.set("export", "1");
    return params.toString();
}

async function loadOrderCategoryReports() {
    try {
        const query = orderCategoryReportQuery();
        if (!query) return;
        const data = await api("/reports/order-categories?" + query);
        const discounts = Array.isArray(data.discountOrders) ? data.discountOrders : [];
        const nonChargeable = Array.isArray(data.nonChargeableOrders) ? data.nonChargeableOrders : [];
        const discountBody = document.getElementById("reportDiscountOrdersBody");
        const nonChargeableBody = document.getElementById("reportNonChargeableOrdersBody");
        if (discountBody) discountBody.innerHTML = discounts.length
            ? discounts.map(order => '<tr><td>' + esc(order.order_number || ("#" + order.order_id)) + '</td><td>' + esc(order.created_at ? formatPOSDateTime(order.created_at) : "—") + '</td><td>' + esc(order.order_type || "—") + '</td><td>' + esc(order.table_number || "—") + '</td><td>' + money(order.discount) + '</td><td>' + esc(order.discount_name || "Discount") + '</td><td>' + esc(order.payment_method || "—") + '</td><td>' + money(order.total) + '</td></tr>').join("")
            : '<tr><td colspan="8">No discounted orders in this period.</td></tr>';
        if (nonChargeableBody) nonChargeableBody.innerHTML = nonChargeable.length
            ? nonChargeable.map(order => '<tr><td>' + esc(order.order_number || ("#" + order.order_id)) + '</td><td>' + esc(order.created_at ? formatPOSDateTime(order.created_at) : "—") + '</td><td>' + esc(order.order_type || "—") + '</td><td>' + esc(order.table_number || "—") + '</td><td>' + esc(order.reason || "Not recorded") + '</td><td>' + money(order.total) + '</td><td>' + esc(order.payment_method || "Non-chargeable") + '</td></tr>').join("")
            : '<tr><td colspan="7">No non-chargeable orders in this period.</td></tr>';
        const canExport = hasPermission("reports", "export");
        ["reportDiscountOrdersDownload", "reportNonChargeableOrdersDownload"].forEach(id => {
            const button = document.getElementById(id);
            if (button) button.hidden = !canExport;
        });
    } catch (error) {
        console.warn("Could not load discount and non-chargeable reports:", error.message);
        const discountBody = document.getElementById("reportDiscountOrdersBody");
        const nonChargeableBody = document.getElementById("reportNonChargeableOrdersBody");
        if (discountBody) discountBody.innerHTML = '<tr><td colspan="8">Could not load discounted orders.</td></tr>';
        if (nonChargeableBody) nonChargeableBody.innerHTML = '<tr><td colspan="7">Could not load non-chargeable orders.</td></tr>';
    }
}

async function downloadOrderCategoryReport(reportType) {
    if(!hasPermission("reports","export"))return showProfileToast("You don’t have permission to export reports.");
    try {
        const query = orderCategoryReportQuery(true, true);
        if (!query) return;
        const data = await api("/reports/order-categories?" + query);
        const reports = {
            discounts: {
                title: "Discounted Orders",
                rows: Array.isArray(data.discountOrders) ? data.discountOrders : [],
                columns: [["Order", order => order.order_number || ("#" + order.order_id)], ["Order ID", order => order.order_id], ["Date", order => order.created_at], ["Order Type", order => order.order_type], ["Table", order => order.table_number], ["Discount", order => order.discount], ["Discount Rule", order => order.discount_name], ["Payment", order => order.payment_method], ["Total", order => order.total]]
            },
            "non-chargeable": {
                title: "Non-chargeable Orders",
                rows: Array.isArray(data.nonChargeableOrders) ? data.nonChargeableOrders : [],
                columns: [["Order", order => order.order_number || ("#" + order.order_id)], ["Order ID", order => order.order_id], ["Date", order => order.created_at], ["Order Type", order => order.order_type], ["Table", order => order.table_number], ["Reason", order => order.reason || "Not recorded"], ["Order Value", order => order.total], ["Payment", order => order.payment_method]]
            }
        };
        const report = reports[reportType];
        if (!report) return;
        const csvValue = value => {
            let text = String(value ?? "");
            if (/^[=+@\-]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
        };
        const csv = ["\uFEFF" + report.columns.map(column => csvValue(column[0])).join(","), ...report.rows.map(row => report.columns.map(column => csvValue(column[1](row))).join(","))].join("\r\n");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        link.download = "cafe-pos-" + reportType + "-orders-" + getPOSDateKey() + ".csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        showProfileToast(report.title + " report downloaded.");
    } catch (error) {
        alert(error.message || "Could not download this report.");
    }
}

let advancedReportData = null;
function toggleAdvancedReportCustomDates(){
    const range=document.getElementById("advancedReportRange")?.value;
    const fields=document.getElementById("advancedReportCustomDates");
    if(fields)fields.hidden=range!=="custom";
}
function advancedReportQuery(includeExport=false){
    const range=document.getElementById("advancedReportRange")?.value||"month";
    const params=new URLSearchParams({range});
    if(range==="custom"){
        const from=document.getElementById("advancedReportFrom")?.value||"";
        const to=document.getElementById("advancedReportTo")?.value||"";
        if(!from||!to)return alert("Choose both the start and end dates for this report."),null;
        if(from>to)return alert("The report start date must be before the end date."),null;
        params.set("from",from);params.set("to",to);
    }
    if(includeExport)params.set("export","1");
    return params.toString();
}
async function loadAdvancedReports(){
    try{
        const query=advancedReportQuery();
        if(!query)return;
        const r=await api('/reports/advanced?'+query);
        advancedReportData=r;
        const hourly=Array.isArray(r.hourly)?r.hourly:[], weekday=Array.isArray(r.weekday)?r.weekday:[], dayparts=Array.isArray(r.dayparts)?r.dayparts:[], customers=Array.isArray(r.customers)?r.customers:[], cancelled=Array.isArray(r.cancelled)?r.cancelled:[];
        const discounts=Array.isArray(r.discountOrders)?r.discountOrders:[], nonChargeable=Array.isArray(r.nonChargeableOrders)?r.nonChargeableOrders:[];
        setText('advancedExpenseTotal',money(r.expenseTotal));
        setText('advancedCancelledValue',money(cancelled.reduce((a,x)=>a+Number(x.value||0),0)));
        const hourlyBody=document.getElementById('advancedHourlyBody');
        const weekdayBody=document.getElementById('advancedWeekdayBody');
        const daypartBody=document.getElementById('advancedDaypartBody');
        const customersBody=document.getElementById('advancedCustomersBody');
        const cancelledBody=document.getElementById('advancedCancelledBody');
        const discountBody=document.getElementById('advancedDiscountBody');
        const nonChargeableBody=document.getElementById('advancedNonChargeableBody');
        if(hourlyBody)hourlyBody.innerHTML=hourly.length?hourly.map(x=>`<tr><td>${String(x.hour).padStart(2,'0')}:00</td><td>${x.orders}</td><td>${money(x.sales)}</td></tr>`).join(''):'<tr><td colspan="3">No data.</td></tr>';
        if(weekdayBody)weekdayBody.innerHTML=weekday.length?weekday.map(x=>`<tr><td>${esc(String(x.day||'').trim())}</td><td>${x.orders}</td><td>${money(x.sales)}</td></tr>`).join(''):'<tr><td colspan="3">No data.</td></tr>';
        if(daypartBody)daypartBody.innerHTML=dayparts.length?dayparts.map(x=>`<tr><td>${esc(x.daypart)}</td><td>${x.orders}</td><td>${money(x.sales)}</td></tr>`).join(''):'<tr><td colspan="3">No data.</td></tr>';
        if(customersBody)customersBody.innerHTML=customers.length?customers.map(x=>`<tr><td>${esc(x.customer)}</td><td>${x.orders}</td><td>${money(x.sales)}</td></tr>`).join(''):'<tr><td colspan="3">No data.</td></tr>';
        if(cancelledBody)cancelledBody.innerHTML=cancelled.length?cancelled.map(x=>`<tr><td>${esc(x.order_number||`#${x.order_id}`)}</td><td>${esc(x.cancelled_at?formatPOSDateTime(x.cancelled_at):'—')}</td><td>${esc(x.reason||'Not recorded')}</td><td>${esc(x.cancelled_by_user_name||'Unknown user')}</td><td>${money(x.value)}</td></tr>`).join(''):'<tr><td colspan="5">No cancelled orders in this period.</td></tr>';
        if(discountBody)discountBody.innerHTML=discounts.length?discounts.map(x=>`<tr><td>${esc(x.order_number||`#${x.order_id}`)}</td><td>${esc(x.created_at?formatPOSDateTime(x.created_at):'—')}</td><td>${esc(x.order_type||'—')}</td><td>${money(x.discount)}</td><td>${esc(x.discount_name||'Discount')}</td><td>${money(x.total)}</td><td>${esc(x.payment_method||'—')}</td></tr>`).join(''):'<tr><td colspan="7">No discounted orders in this period.</td></tr>';
        if(nonChargeableBody)nonChargeableBody.innerHTML=nonChargeable.length?nonChargeable.map(x=>`<tr><td>${esc(x.order_number||`#${x.order_id}`)}</td><td>${esc(x.created_at?formatPOSDateTime(x.created_at):'—')}</td><td>${esc(x.order_type||'—')}</td><td>${esc(x.reason||'Not recorded')}</td><td>${money(x.total)}</td><td>${esc(x.payment_method||'Non-chargeable')}</td></tr>`).join(''):'<tr><td colspan="6">No non-chargeable orders in this period.</td></tr>';
        const canExport=hasPermission('advanced_reports','export');
        ['downloadCancelledReport','downloadDiscountReport','downloadNonChargeableReport'].forEach(id=>{const button=document.getElementById(id);if(button)button.hidden=!canExport;});
        const warningBox=document.getElementById('advancedReportWarnings');
        if(warningBox) warningBox.textContent=(r.warnings||[]).length?`Some datasets were unavailable: ${(r.warnings||[]).join(' | ')}`:'';
    }catch(e){
        console.error("Advanced reports failed:",e);
        const warningBox=document.getElementById('advancedReportWarnings');
        if(warningBox) warningBox.textContent=e.message;
        // Keep the page usable even if an optional dataset fails.
        setText('advancedExpenseTotal',money(0)); setText('advancedCancelledValue',money(0));
    }
}

async function downloadAdvancedReport(reportType){
    if(!hasPermission("advanced_reports","export"))return showProfileToast("You don’t have permission to export advanced reports.");
    try{
        const query=advancedReportQuery(true);
        if(!query)return;
        const data=await api(`/reports/advanced?${query}`);
        const keys={
            'hourly-sales':{title:'Hourly Sales',rows:Array.isArray(data.hourly)?data.hourly:[],columns:[['Hour',x=>String(x.hour).padStart(2,'0')+':00'],['Orders',x=>x.orders],['Sales',x=>x.sales]]},
            'weekday-sales':{title:'Sales by Weekday',rows:Array.isArray(data.weekday)?data.weekday:[],columns:[['Weekday',x=>String(x.day||'').trim()],['Orders',x=>x.orders],['Sales',x=>x.sales]]},
            'daypart-sales':{title:'Sales by Daypart',rows:Array.isArray(data.dayparts)?data.dayparts:[],columns:[['Daypart',x=>x.daypart],['Orders',x=>x.orders],['Sales',x=>x.sales]]},
            'top-customers':{title:'Top Customers',rows:Array.isArray(data.customers)?data.customers:[],columns:[['Customer',x=>x.customer],['Orders',x=>x.orders],['Sales',x=>x.sales]]},
            cancelled:{title:'Cancelled Orders',rows:Array.isArray(data.cancelled)?data.cancelled:[],columns:[['Order',x=>x.order_number||`#${x.order_id}`],['Order ID',x=>x.order_id],['Order Type',x=>x.order_type],['Table',x=>x.table_number],['Cancelled At',x=>x.cancelled_at],['Reason',x=>x.reason||'Not recorded'],['Cancelled By',x=>x.cancelled_by_user_name||'Unknown user'],['Order Value',x=>x.value]]},
            discounts:{title:'Discounted Orders',rows:Array.isArray(data.discountOrders)?data.discountOrders:[],columns:[['Order',x=>x.order_number||`#${x.order_id}`],['Order ID',x=>x.order_id],['Date',x=>x.created_at],['Order Type',x=>x.order_type],['Table',x=>x.table_number],['Discount',x=>x.discount],['Discount Rule',x=>x.discount_name],['Payment',x=>x.payment_method],['Total',x=>x.total]]},
            'non-chargeable':{title:'Non-chargeable Orders',rows:Array.isArray(data.nonChargeableOrders)?data.nonChargeableOrders:[],columns:[['Order',x=>x.order_number||`#${x.order_id}`],['Order ID',x=>x.order_id],['Date',x=>x.created_at],['Order Type',x=>x.order_type],['Table',x=>x.table_number],['Reason',x=>x.reason||'Not recorded'],['Order Value',x=>x.total],['Payment',x=>x.payment_method]]}
        };
        const report=keys[reportType];
        if(!report)return;
        const csvValue=value=>{let text=String(value??'');if(/^[=+@\-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
        const csv=['\uFEFF'+report.columns.map(column=>csvValue(column[0])).join(','),...report.rows.map(row=>report.columns.map(column=>csvValue(column[1](row))).join(','))].join('\r\n');
        const link=document.createElement('a');
        link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
        link.download=`cafe-pos-${reportType}-${getPOSDateKey()}.csv`;
        document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(link.href);
        showProfileToast(`${report.title} report downloaded.`);
    }catch(error){alert(error.message||'Could not download this report.');}
}

async function loadDeploymentChecks(){try{const r=await api('/system/deployment-check');const box=document.getElementById('deploymentChecks');box.innerHTML=r.checks.map(c=>`<div class="deployment-check ${c.ok?'ok':'bad'}"><span>${c.ok?'✅':'⚠️'}</span><div><b>${esc(c.label)}</b><br><small>${esc(c.detail|| (c.ok?'Ready':'Needs attention'))}</small></div></div>`).join('');}catch(e){document.getElementById('deploymentChecks').textContent=e.message;}}
function downloadEnvTemplate(){const text=`NODE_ENV=production\nPORT=3000\nDATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE\nDATABASE_SSL_CA=\nDB_POOL_MAX=2\nCORS_ALLOWED_ORIGINS=https://your-pos-domain.example\nVAPID_PUBLIC_KEY=\nVAPID_PRIVATE_KEY=\nVAPID_SUBJECT=mailto:admin@example.com\nSUPPORT_USERNAME=\nSUPPORT_PASSWORD=\nPUBLIC_BUSINESS_REGISTRATION_ENABLED=false\nPUBLIC_BUSINESS_REGISTRATION_KEY=\n`;const blob=new Blob([text],{type:'text/plain'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='.env.example';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(a.href);}

// Keep all sales widgets exclusively on Dashboard and Reports by loading new pages only through their own hooks.
const baseShowPage = showPage;
showPage = function(pageName){ const requestedPage=pageName==='loyalty'?'marketing':pageName; baseShowPage(pageName); if(!currentUser)return; switch(requestedPage){case 'expenses':loadExpenses();break;case 'reports':showSalesReportView('overview');loadOrderCategoryReports();break;case 'advanced-reports':loadAdvancedReports();break;case 'marketing':loadMarketingDeals();loadMarketingPushCampaigns();loadBillingAdjustments();if(hasPermission('loyalty','view'))loadLoyaltySettings();break;case 'new-order':loadMarketingDeals();loadBillingAdjustments();break;} };

function setupDesktopWindowChrome(){
    const desktop=window.cafePOSDesktop;
    const titlebar=document.getElementById("desktopTitlebar");
    if(!desktop||!titlebar)return;
    document.body.classList.add("desktop-mode");
    titlebar.hidden=false;
    const brandMark=document.querySelector(".desktop-titlebar-mark");
    if(brandMark){
        const icon=document.createElement("img");
        icon.className=brandMark.className;
        icon.src=new URL("desktop/assets/cafe-pilot-icon.png",window.location.href).href;
        icon.alt="";
        icon.setAttribute("aria-hidden","true");
        brandMark.replaceWith(icon);
    }
    const maximizeButton=document.getElementById("desktopWindowMaximize");
    const renderWindowState=maximized=>{
        if(!maximizeButton)return;
        maximizeButton.setAttribute("aria-label",maximized?"Restore window":"Maximize window");
        maximizeButton.title=maximized?"Restore":"Maximize";
        maximizeButton.innerHTML=maximized
            ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h7.5V11M11 5H4.5v7.5H12V5"/></svg>'
            : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx=".5"/></svg>';
    };
    const bind=(id,action)=>document.getElementById(id)?.addEventListener("click",()=>Promise.resolve(action()).catch(error=>console.warn("Desktop window action failed:",error)));
    bind("desktopServerSettings",()=>desktop.openServerSettings());
    bind("desktopWindowMinimize",()=>desktop.minimizeWindow());
    bind("desktopWindowMaximize",()=>desktop.toggleMaximizeWindow());
    bind("desktopWindowClose",()=>desktop.closeWindow());
    Promise.resolve(desktop.getWindowState()).then(state=>renderWindowState(Boolean(state?.maximized))).catch(()=>{});
    const unsubscribe=desktop.onWindowStateChanged(renderWindowState);
    if(typeof unsubscribe==="function")window.addEventListener("beforeunload",unsubscribe,{once:true});
}
setupDesktopWindowChrome();
setupDesktopBluetoothPicker();

// ==========================================
// START APPLICATION
// ==========================================

window.addEventListener(
    "DOMContentLoaded",
    async function() {

        console.log("🚀 Slash POS started");
        await loadLoginBusinessWelcome();
        if (new URLSearchParams(window.location.search).get("view") === "register-business") {
            showRegisterBusiness();
        }

        // Settings are loaded after session validation.


        // ======================================
        // REPORT DATE FILTER
        // ======================================

        const reportFilter =
            document.getElementById(
                "reportDateFilter"
            );


        if (reportFilter) {

            reportFilter.addEventListener(
                "change",
                function() {

                    console.log(
                        "📅 Report filter changed:",
                        reportFilter.value
                    );


                    toggleCustomReportDates();

                }
            );

        }


        // ======================================
        // INITIAL REPORT DATE STATE
        // ======================================

        toggleCustomReportDates();
        toggleKOTCustomDates();
        setOrderType(appSettings.defaultOrderType || "Dine-in");


        // ======================================
        // INITIAL CART
        // ======================================

        updateCart();


        // ======================================
        // DEFAULT ORDER TYPE
        // ======================================

        setOrderType("Takeaway");


        // ======================================
        // LOAD APPLICATION DATA
        // ======================================

        await checkSession();

        console.log("✅ Slash POS initialized successfully");

    }
);

let tableQrMenuTables=[];
let tableQrMenuItems=[];
let tableQrMenuQrData=new Map();
let tableQrMenuPosterData=new Map();

function parseQrMenuBaseUrl(value){
    let parsed;
    try{parsed=new URL(String(value||"").trim()||window.location.origin);}
    catch(_){throw new Error("Enter a valid QR website address, for example https://your-cafe-domain.com");}
    if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=="/"||parsed.search||parsed.hash)
        throw new Error("Enter only the website address, without a page path.");
    return parsed.origin;
}
function getQrMenuBaseUrl(){
    const input=document.getElementById("publicMenuBaseUrl");
    const fallback=restaurantMenuPublication?.publicBaseUrl||restaurantMenuPublication?.localNetworkUrl||window.location.origin;
    return parseQrMenuBaseUrl(input?.value||fallback);
}
function updateRestaurantMenuLinkPreview(){
    const url=document.getElementById("publicMenuUrl"),status=document.getElementById("publicMenuStatus"),hostNote=document.getElementById("publicMenuHostNote");
    if(!restaurantMenuPublication?.token)return;
    try{
        const base=getQrMenuBaseUrl(),parsed=new URL(base);
        if(url)url.value=base+"/restaurant/"+restaurantMenuPublication.token;
        if(hostNote){
            const secure=parsed.protocol==="https:";
            hostNote.hidden=secure;
            if(!secure){
                const loopback=["localhost","127.0.0.1","::1"].includes(parsed.hostname);
                hostNote.textContent=loopback
                    ?"This localhost link opens only on this computer. Use the suggested LAN address for phone ordering; Android app installation and push notifications need your live HTTPS website."
                    :"This address can work for phones on the same Wi-Fi. Android app installation and push notifications need your live HTTPS website.";
            }
        }
    }catch(error){if(status)status.textContent=error.message;}
}

function qrTableDisplayName(value){
    const label=String(value||"").trim();
    if(/^t\d+$/i.test(label))return label.toUpperCase();
    const tableMatch=label.match(/^table\s+(.+)$/i);
    if(tableMatch&&/^t?\d+$/i.test(tableMatch[1]))return "T"+tableMatch[1].replace(/^t/i,"");
    if(/^\d+$/.test(label))return "T"+label;
    return label;
}
function loadQrPosterImage(source){
    return new Promise((resolve,reject)=>{
        const image=new Image();
        image.onload=()=>resolve(image);
        image.onerror=()=>reject(new Error("Could not prepare the QR poster image."));
        image.src=source;
    });
}
async function createGenzTableQrPoster(table,qrDataUrl){
    const qrImage=await loadQrPosterImage(qrDataUrl);
    const canvas=document.createElement("canvas");
    canvas.width=1200;canvas.height=1600;
    const context=canvas.getContext("2d");
    if(!context)throw new Error("This browser cannot prepare the themed QR poster.");
    const roundedRect=(x,y,width,height,radius,color)=>{
        context.beginPath();context.moveTo(x+radius,y);context.arcTo(x+width,y,x+width,y+height,radius);context.arcTo(x+width,y+height,x,y+height,radius);context.arcTo(x,y+height,x,y,radius);context.arcTo(x,y,x+width,y,radius);context.closePath();context.fillStyle=color;context.fill();
    };
    context.fillStyle="#eee9f8";context.fillRect(0,0,canvas.width,canvas.height);
    roundedRect(30,30,1140,1540,58,"#25222f");
    context.globalAlpha=.16;context.fillStyle="#ff6cad";context.beginPath();context.arc(1090,180,210,0,Math.PI*2);context.fill();
    context.fillStyle="#d9fb55";context.beginPath();context.arc(105,1320,210,0,Math.PI*2);context.fill();context.globalAlpha=1;
    context.textAlign="center";context.textBaseline="middle";
    context.font="900 29px Arial, sans-serif";context.fillStyle="#e9e3f5";context.fillText("GOOD FOOD · NO GATEKEEPING",600,130);
    context.font="900 78px Arial, sans-serif";context.fillStyle="#fffaf1";context.fillText("Your next fave",600,260);
    context.fillStyle="#d9fb55";context.fillText("is one scan away ✦",600,350);
    context.font="700 27px Arial, sans-serif";context.fillStyle="#cec8dc";context.fillText("Scan the code. Pick your mood. We’ll make the good stuff.",600,425,1010);
    const tableLabel="TABLE "+qrTableDisplayName(table.table_number||table.id);
    context.font="900 26px Arial, sans-serif";
    const badgeWidth=Math.max(210,context.measureText(tableLabel).width+64);
    roundedRect((1200-badgeWidth)/2,466,badgeWidth,62,31,"#ff6cad");
    context.fillStyle="#25222f";context.fillText(tableLabel,600,497);
    roundedRect(190,560,820,820,38,"#ffffff");
    context.imageSmoothingEnabled=false;
    context.drawImage(qrImage,280,650,640,640);
    context.font="900 30px Arial, sans-serif";context.fillStyle="#25222f";context.fillText("SCAN · PICK · REPEAT",600,1442);
    const brand=String(appSettings.restaurantName||currentUser?.business_name||"YOUR CAFE").trim().toUpperCase();
    context.font="700 22px Arial, sans-serif";context.fillStyle="#d8d1e6";context.fillText(brand||"YOUR CAFE",600,1490,1000);
    return canvas.toDataURL("image/png");
}
tableQrMenuTables=[];
tableQrMenuItems=[];
tableQrMenuQrData=new Map();
let tableQrMenuHeroImages=[];

function renderQrHeroImages(unsaved=false){
    const grid=document.getElementById("qrHeroImageList"),note=document.getElementById("qrHeroImageNote"),count=document.getElementById("qrHeroImageCount"),uploadButton=document.getElementById("qrHeroUploadButton");
    if(!grid)return;
    if(count)count.textContent=tableQrMenuHeroImages.length+"/6";
    if(uploadButton)uploadButton.disabled=tableQrMenuHeroImages.length>=6;
    if(!tableQrMenuHeroImages.length){
        grid.innerHTML='<div class="qr-hero-empty">No photos added. The existing welcome artwork will be shown.</div>';
    }else{
        grid.innerHTML=tableQrMenuHeroImages.map((image,index)=>'<article class="qr-hero-image-card"><img src="'+esc(image)+'" alt="QR menu hero image '+(index+1)+'" loading="lazy"><div class="qr-hero-image-card-footer"><span>Image '+(index+1)+'</span><div class="qr-hero-image-actions"><button type="button" '+(index===0?'disabled':'')+' title="Move image earlier" aria-label="Move image '+(index+1)+' earlier" onclick="moveQrHeroImage('+index+',-1)">↑</button><button type="button" '+(index===tableQrMenuHeroImages.length-1?'disabled':'')+' title="Move image later" aria-label="Move image '+(index+1)+' later" onclick="moveQrHeroImage('+index+',1)">↓</button><button type="button" class="qr-hero-remove" title="Remove image" aria-label="Remove image '+(index+1)+'" onclick="removeQrHeroImage('+index+')">×</button></div></div></article>').join("");
    }
    if(note)note.textContent=(unsaved?"Unsaved image changes — save them to update the guest menu. ":"")+"Add up to 6 JPG, PNG or WebP images, up to 200 KB each after compression. Use the arrows to choose their order.";
}

function moveQrHeroImage(index,direction){
    const target=index+direction;
    if(index<0||target<0||target>=tableQrMenuHeroImages.length)return;
    const [image]=tableQrMenuHeroImages.splice(index,1);
    tableQrMenuHeroImages.splice(target,0,image);
    renderQrHeroImages(true);
}

function removeQrHeroImage(index){
    if(index<0||index>=tableQrMenuHeroImages.length)return;
    tableQrMenuHeroImages.splice(index,1);
    renderQrHeroImages(true);
}

async function compressQrHeroImage(file){
    if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw new Error(file.name+": choose a JPG, PNG or WebP image.");
    if(file.size>12*1024*1024)throw new Error(file.name+": choose an image smaller than 12 MB.");
    const bitmap=await createImageBitmap(file);
    try{
        const canvas=document.createElement("canvas"),context=canvas.getContext("2d",{alpha:false});
        if(!context)throw new Error("This browser cannot prepare the selected image.");
        let longest=Math.min(2000,Math.max(bitmap.width,bitmap.height)),quality=.86,encoded="";
        for(let attempt=0;attempt<32;attempt++){
            const scale=Math.min(1,longest/Math.max(bitmap.width,bitmap.height));
            canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
            context.fillStyle="#ffffff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
            encoded=canvas.toDataURL("image/jpeg",quality);
            if(atob(encoded.slice(encoded.indexOf(",")+1)).length<=200*1024)return encoded;
            if(quality>.5)quality=Math.max(.48,quality-.08);else longest=Math.max(320,Math.floor(longest*.82));
        }
        throw new Error(file.name+": could not resize this image enough. Choose a smaller image.");
    }finally{bitmap.close?.();}
}

async function addQrHeroImages(input){
    const files=[...(input?.files||[])],available=Math.max(0,6-tableQrMenuHeroImages.length),selected=files.slice(0,available),errors=[];
    if(files.length>available)errors.push("You can add up to 6 images in total.");
    const addButton=document.getElementById("qrHeroUploadButton");
    if(addButton)addButton.disabled=true;
    try{
        const additions=[];
        for(const file of selected){try{additions.push(await compressQrHeroImage(file));}catch(error){errors.push(error.message||"Could not read "+file.name+".");}}
        if(additions.length){tableQrMenuHeroImages.push(...additions);renderQrHeroImages(true);}
    }finally{
        if(input)input.value="";
        if(addButton)addButton.disabled=tableQrMenuHeroImages.length>=6;
    }
    if(errors.length)alert(errors.join("\n"));
}

async function loadTableQrMenuModule(){
    const grid=document.getElementById("tableQrGrid"),stock=document.getElementById("qrStockGrid");
    if(grid)grid.innerHTML='<div class="table-qr-empty">Loading your POS tables…</div>';
    if(stock)stock.innerHTML='<div class="qr-stock-empty">Loading menu items…</div>';
    try{
        const [tables,items,publication,categories]=await Promise.all([api("/tables"),api("/menu"),api("/menu/public-settings"),api("/menu/categories")]);
        tableQrMenuTables=Array.isArray(tables)?tables:[];
        tableQrMenuItems=Array.isArray(items)?items:[];
        restaurantMenuPublication=publication;
        qrMenuCategoryNames=(Array.isArray(categories)?categories:[]).filter(category=>category.active!==false).map(category=>String(category.name||"").trim()).filter(Boolean);
        const savedOrder=Array.isArray(publication.categoryOrder)?publication.categoryOrder:[];
        const categoryByKey=new Map(qrMenuCategoryNames.map(name=>[name.toLocaleLowerCase(),name]));
        qrCategoryOrder=[...savedOrder.map(name=>categoryByKey.get(String(name||"").trim().toLocaleLowerCase())).filter(Boolean)];
        qrMenuCategoryNames.forEach(name=>{if(!qrCategoryOrder.some(entry=>entry.toLocaleLowerCase()===name.toLocaleLowerCase()))qrCategoryOrder.push(name);});
        renderQrCategoryOrder();
        const enabled=document.getElementById("publicMenuEnabled"),channel=document.getElementById("publicMenuPriceChannel"),url=document.getElementById("publicMenuUrl"),baseField=document.getElementById("publicMenuBaseUrl"),status=document.getElementById("publicMenuStatus");
        tableQrMenuHeroImages=Array.isArray(publication.heroImages)?publication.heroImages.slice(0,6):[];
        renderQrHeroImages();
        if(enabled)enabled.checked=publication.enabled===true;
        if(channel){const choices=Array.isArray(publication.qrMenuChannels)?publication.qrMenuChannels:POS_CHANNELS.filter(entry=>entry.qrMenu);channel.innerHTML=choices.map(entry=>`<option value="${esc(entry.key)}">${esc(entry.label)}</option>`).join("");channel.value=choices.some(entry=>entry.key===publication.priceChannel)?publication.priceChannel:choices[0]?.key||"online";}
        const isLoopback=["localhost","127.0.0.1","::1"].includes(window.location.hostname.toLowerCase());
        const suggestedBase=publication.publicBaseUrl||(isLoopback&&publication.localNetworkUrl)||window.location.origin;
        if(baseField)baseField.value=suggestedBase;
        if(url)url.value=parseQrMenuBaseUrl(suggestedBase)+"/restaurant/"+publication.token;
        updateRestaurantMenuLinkPreview();
        if(status)status.textContent=publication.enabled?"Your QR menu is live. Guests enter their details, then open the published menu.":"Your QR menu is private until you turn publishing on.";
        renderQrStockItems();
        await renderTableQrCards();
    }catch(error){
        if(grid)grid.innerHTML='<div class="table-qr-empty">Could not load your table QR setup. '+esc(error.message||"Refresh and try again.")+'</div>';
        if(stock)stock.innerHTML='<div class="qr-stock-empty">Could not load menu items.</div>';
        const status=document.getElementById("publicMenuStatus");
        if(status)status.textContent=error.message||"Guest menu settings are unavailable.";
    }
}

function renderQrCategoryOrder(){
    const list=document.getElementById("qrCategoryOrderList");
    if(!list)return;
    if(!qrCategoryOrder.length){list.innerHTML='<li class="qr-category-order-empty">Create menu categories first to arrange them for guests.</li>';return;}
    list.innerHTML=qrCategoryOrder.map((name,index)=>`<li class="qr-category-order-item"><span class="qr-category-order-rank">${index+1}</span><span class="qr-category-order-name">${esc(name)}</span><span class="qr-category-order-actions"><button type="button" class="table-action-btn" aria-label="Move ${esc(name)} up" title="Move up" ${index===0?"disabled":""} onclick="moveQrCategoryOrder(${index},-1)">↑</button><button type="button" class="table-action-btn" aria-label="Move ${esc(name)} down" title="Move down" ${index===qrCategoryOrder.length-1?"disabled":""} onclick="moveQrCategoryOrder(${index},1)">↓</button></span></li>`).join("");
}

function moveQrCategoryOrder(index,direction){
    const target=index+direction;
    if(index<0||target<0||index>=qrCategoryOrder.length||target>=qrCategoryOrder.length)return;
    [qrCategoryOrder[index],qrCategoryOrder[target]]=[qrCategoryOrder[target],qrCategoryOrder[index]];
    renderQrCategoryOrder();
}

async function readQrCategoryOrderFile(file){
    const status=document.getElementById("qrCategoryOrderStatus");
    if(!file)return;
    try{
        const extension=String(file.name||"").split(".").pop().toLowerCase();
        const matrix=extension==="xlsx"?await parseMenuXlsx(file):parseMenuDelimited(await file.text(),extension==="tsv"?"\t":",");
        if(!matrix.length)throw new Error("The file has no category rows.");
        const normalize=value=>String(value||"").trim().toLocaleLowerCase().replace(/[^a-z0-9]/g,"");
        const headers=matrix[0].map(normalize);
        const categoryColumn=headers.findIndex(value=>["category","categories","categoryname"].includes(value));
        const orderColumn=headers.findIndex(value=>["order","displayorder","sortorder","position","sequence"].includes(value));
        if(categoryColumn<0||orderColumn<0)throw new Error("Add Category and Order columns to the first row of your CSV or Excel sheet.");
        const categoryByKey=new Map(qrMenuCategoryNames.map(name=>[name.toLocaleLowerCase(),name]));
        const imported=[];
        const seen=new Set();
        for(const [rowIndex,row] of matrix.slice(1).entries()){
            const rawName=String(row[categoryColumn]||"").trim();
            if(!rawName)continue;
            const name=categoryByKey.get(rawName.toLocaleLowerCase());
            if(!name)throw new Error(`Row ${rowIndex+2}: “${rawName}” is not an active menu category.`);
            const key=name.toLocaleLowerCase();
            if(seen.has(key))throw new Error(`“${name}” appears more than once in the file.`);
            const order=Number(String(row[orderColumn]||"").trim());
            if(!Number.isFinite(order)||order<1)throw new Error(`Row ${rowIndex+2}: enter a display order of 1 or higher.`);
            seen.add(key);
            imported.push({name,order,index:rowIndex});
        }
        if(!imported.length)throw new Error("The file has no category rows to import.");
        imported.sort((a,b)=>a.order-b.order||a.index-b.index);
        qrCategoryOrder=[...imported.map(entry=>entry.name),...qrCategoryOrder.filter(name=>!seen.has(name.toLocaleLowerCase()))];
        renderQrCategoryOrder();
        if(status)status.textContent=`Imported ${imported.length} categories. Save display order to publish the new sequence.`;
        showProfileToast("QR menu category order imported.");
    }catch(error){
        if(status)status.textContent=error.message||"Could not read this category order file.";
    }finally{
        const input=document.getElementById("qrCategoryOrderFile");
        if(input)input.value="";
    }
}

function downloadQrCategoryOrderTemplate(){
    const rows=[["Category","Order"],...qrCategoryOrder.map((name,index)=>[name,index+1])];
    downloadCsvRows(`qr-menu-category-order-${getPOSDateKey()}.csv`,rows);
}

async function saveQrCategoryOrder(){
    const status=document.getElementById("qrCategoryOrderStatus");
    try{
        await api("/menu/public-settings/category-order",{method:"PUT",body:JSON.stringify({categoryOrder:qrCategoryOrder})});
        if(restaurantMenuPublication)restaurantMenuPublication.categoryOrder=qrCategoryOrder.slice();
        if(status)status.textContent="Guest QR menu categories will follow this order.";
        showProfileToast("QR menu category order saved.");
    }catch(error){
        if(status)status.textContent=error.message||"Could not save the QR menu category order.";
    }
}

async function saveRestaurantMenuSettings(){
    const enabled=document.getElementById("publicMenuEnabled")?.checked===true;
    const priceChannel=document.getElementById("publicMenuPriceChannel")?.value||"online";
    const status=document.getElementById("publicMenuStatus");
    let publicBaseUrl;
    try{publicBaseUrl=parseQrMenuBaseUrl(document.getElementById("publicMenuBaseUrl")?.value||getQrMenuBaseUrl());}
    catch(error){if(status)status.textContent=error.message||"Enter a valid QR website address.";return;}
    try{
        await api("/menu/public-settings",{method:"PUT",body:JSON.stringify({enabled,priceChannel,publicBaseUrl,heroImages:tableQrMenuHeroImages})});
        await loadTableQrMenuModule();
        showProfileToast("QR menu settings and hero images saved.");
    }catch(error){
        if(status)status.textContent=error.message||"Could not save the QR menu settings.";
    }
}
async function setQrMenuStock(id,inStock){
    try{
        await api("/menu/"+Number(id)+"/qr-stock",{method:"PATCH",body:JSON.stringify({inStock})});
        tableQrMenuItems=await api("/menu");
        renderQrStockItems();
        showProfileToast(inStock?"Item marked in stock on the QR menu.":"Item marked sold out on the QR menu.");
    }catch(error){
        alert(error.message||"Could not update the QR menu stock status.");
        try{tableQrMenuItems=await api("/menu");renderQrStockItems();}catch(_){}
    }
}

function qrMenuTableUrl(table){
    const url=new URL(getQrMenuBaseUrl()+"/restaurant/"+restaurantMenuPublication.token);
    url.searchParams.set("table",String(table.table_number||""));
    return url.toString();
}

async function renderTableQrCards(){
    const grid=document.getElementById("tableQrGrid");
    if(!grid)return;
    const select=document.getElementById("tableQrTableSelect");
    const previousValue=select?.value||"";
    tableQrMenuQrData=new Map();
    tableQrMenuPosterData=new Map();
    if(!tableQrMenuTables.length){
        grid.innerHTML='<div class="table-qr-empty">No POS tables yet. Add tables in <button type="button" class="table-action-btn" onclick="showPage(\'tables\')">Tables</button> to create their QR codes.</div>';
        return;
    }
    if(select){
        const options=tableQrMenuTables.map(table=>'<option value="'+Number(table.id)+'">Table '+esc(qrTableDisplayName(table.table_number))+'</option>').join("");
        select.innerHTML='<option value="">Choose a table…</option>'+options;
        select.value=tableQrMenuTables.some(table=>String(table.id)===previousValue)?previousValue:"";
    }
    const selectedTable=tableQrMenuTables.find(table=>Number(table.id)===Number(select?.value));
    if(!selectedTable){
        grid.innerHTML='<div class="table-qr-empty"><strong>Choose a table to get started</strong><span>Only the selected table QR will be generated. Download it as a PNG or print a table card.</span></div>';
        return;
    }
    grid.innerHTML=[selectedTable].map(table=>{
        const id=Number(table.id),label="Table "+qrTableDisplayName(table.table_number),targetUrl=qrMenuTableUrl(table);
        return '<article class="table-qr-card"><div class="table-qr-card-head"><h4>'+esc(label)+'</h4><span>'+esc(table.status||"Available")+'</span></div>'
            +'<div class="table-qr-preview"><img id="tableQrImage'+id+'" alt="QR code for '+esc(label)+'" hidden><div id="tableQrPlaceholder'+id+'" class="table-qr-placeholder">Generating QR…</div></div>'
            +'<span class="table-qr-link" title="'+esc(targetUrl)+'">'+esc(targetUrl)+'</span>'
            +'<div class="table-qr-actions"><button id="tableQrDownload'+id+'" type="button" class="table-action-btn" onclick="downloadTableMenuQr('+id+')" disabled>↓ Download PNG</button><button id="tableQrPrint'+id+'" type="button" class="big-btn" onclick="printTableMenuQr('+id+')" disabled>Print</button></div></article>';
    }).join("");
    await generateTableMenuQr(selectedTable);
}

async function generateTableMenuQr(table){
    const id=Number(table.id),image=document.getElementById("tableQrImage"+id),placeholder=document.getElementById("tableQrPlaceholder"+id);
    const download=document.getElementById("tableQrDownload"+id),print=document.getElementById("tableQrPrint"+id);
    try{
        const result=await api("/menu/public-settings/qr",{method:"POST",body:JSON.stringify({url:qrMenuTableUrl(table)})});
        if(!result.dataUrl)throw new Error("QR image was not returned.");
        tableQrMenuQrData.set(String(id),result.dataUrl);
        const posterDataUrl=await createGenzTableQrPoster(table,result.dataUrl);
        tableQrMenuPosterData.set(String(id),posterDataUrl);
        image.src=posterDataUrl;image.hidden=false;
        if(placeholder)placeholder.hidden=true;
        if(download)download.disabled=false;
        if(print)print.disabled=false;
    }catch(error){if(placeholder)placeholder.textContent=error.message||"Could not generate this QR code.";}
}

function downloadTableMenuQr(tableId){
    const table=tableQrMenuTables.find(row=>Number(row.id)===Number(tableId)),dataUrl=tableQrMenuPosterData.get(String(tableId));
    if(!table||!dataUrl)return;
    const safeName=qrTableDisplayName(table.table_number||table.id).replace(/[^a-z0-9_-]+/gi,"-");
    const link=document.createElement("a");link.href=dataUrl;link.download="table-"+safeName+"-menu-qr.png";document.body.appendChild(link);link.click();link.remove();
}

function printTableMenuQr(tableId){
    const table=tableQrMenuTables.find(row=>Number(row.id)===Number(tableId)),dataUrl=tableQrMenuPosterData.get(String(tableId));
    if(!table||!dataUrl)return;
    const tableLabel="Table "+qrTableDisplayName(table.table_number);
    const printWindow=window.open("","_blank","width=760,height=900");
    if(!printWindow){alert("Allow pop-ups for this POS page to print a table QR.");return;}
    printWindow.document.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(tableLabel)+' menu QR</title><style>@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eee9f8;font-family:Arial,sans-serif}.sheet{display:grid;place-items:center;width:100%;min-height:275mm}.sheet img{display:block;width:min(170mm,100%);height:auto;max-height:275mm;object-fit:contain}.print-action{position:fixed;top:16px;right:16px;padding:11px 18px;border:0;border-radius:999px;background:#d9fb55;color:#25222f;font-weight:900;cursor:pointer}@media print{body{min-height:auto;background:#fff}.sheet{min-height:0}.sheet img{width:170mm;max-height:275mm}.print-action{display:none}}</style></head><body><main class="sheet"><img src="'+dataUrl+'" alt="'+esc(tableLabel)+' themed menu QR"></main><button class="print-action" onclick="window.print()">Print QR ✦</button><script>window.addEventListener("load",()=>setTimeout(()=>window.print(),300));</script></body></html>');
    printWindow.document.close();
}

function renderQrStockItems(){
    const grid=document.getElementById("qrStockGrid");
    if(!grid)return;
    const term=String(document.getElementById("qrStockSearch")?.value||"").trim().toLowerCase();
    const items=tableQrMenuItems.filter(item=>!term||String(item.name||"").toLowerCase().includes(term)||String(item.category||"").toLowerCase().includes(term));
    if(!items.length){
        grid.innerHTML=tableQrMenuItems.length?'<div class="qr-stock-empty">No menu items match that search.</div>':'<div class="qr-stock-empty">No menu items yet. Add them in the Menu module first.</div>';
        return;
    }
    grid.innerHTML=items.map(item=>{
        const inStock=item.qr_available!==false;
        return '<article class="qr-stock-card"><div><strong>'+esc(item.name)+'</strong><small>'+esc(item.category||"Menu item")+' · '+(item.available===false?"POS off":"POS on")+'</small></div><label class="menu-availability-toggle"><input type="checkbox" '+(inStock?"checked":"")+' onchange="setQrMenuStock('+Number(item.id)+',this.checked)" aria-label="Mark '+esc(item.name)+' as in stock for QR"><span>'+(inStock?"In Stock":"Sold Out")+'</span></label></article>';
    }).join("");
}

async function printOrderKOT(orderId){
    await printKOT(orderId);
}
let posQrServiceRequestCursor=null;
let posQrServiceRequestTimer=null;
let posQrServiceRequestBusy=false;
let posQrServiceRequestGeneration=0;
let qrServiceSpeechQueue=[];
let qrServiceSpeechActive=false;
let qrServiceSpeechGeneration=0;
let qrServiceSpeechRetryArmed=false;
let qrServiceSpeechRetryHandler=null;
function flushPendingQrServiceVoices(){
    if(!pendingQrServiceVoiceRequests.length)return;
    const pending=pendingQrServiceVoiceRequests.splice(0);
    pending.forEach(queueQrTableServiceVoice);
}
function armQrServiceSpeechRetry(){
    if(qrServiceSpeechRetryArmed)return;
    qrServiceSpeechRetryArmed=true;
    const retry=()=>{
        document.removeEventListener("pointerdown",retry,true);
        document.removeEventListener("keydown",retry,true);
        qrServiceSpeechRetryArmed=false;
        qrServiceSpeechRetryHandler=null;
        if(!currentUser)return;
        primeKOTAlertAudio();
        flushPendingQrServiceVoices();
    };
    qrServiceSpeechRetryHandler=retry;
    document.addEventListener("pointerdown",retry,{once:true,capture:true});
    document.addEventListener("keydown",retry,{once:true,capture:true});
}
function showQrTableServiceRequestToast(request){
    let stack=document.getElementById("qrServiceRequestToastStack");
    if(!stack){stack=document.createElement("div");stack.id="qrServiceRequestToastStack";stack.className="qr-service-request-toast-stack";stack.setAttribute("aria-live","polite");stack.setAttribute("aria-relevant","additions");document.body.appendChild(stack);}
    const clean=String(request.request_type||"")==="clean_table",table=String(request.table_number||"").trim()||"—";
    const toast=document.createElement("article");toast.className="qr-service-request-toast";toast.setAttribute("role","status");
    const icon=document.createElement("span");icon.className="qr-service-request-icon";icon.setAttribute("aria-hidden","true");icon.textContent=clean?"✧":"♧";
    const copy=document.createElement("span");copy.className="qr-service-request-copy";
    const title=document.createElement("strong");title.textContent=clean?`टेबल नंबर ${table} · सफ़ाई का अनुरोध`:`टेबल नंबर ${table} · वेटर का अनुरोध`;
    const detail=document.createElement("small");detail.textContent=clean?"कृपया इस टेबल को साफ़ करें।":"कृपया इस टेबल पर वेटर भेजें।";
    copy.append(title,detail);
    const close=document.createElement("button");close.className="qr-service-request-close";close.type="button";close.setAttribute("aria-label","Dismiss table request notification");close.textContent="×";
    close.addEventListener("click",()=>toast.remove());toast.append(icon,copy,close);stack.appendChild(toast);
    requestAnimationFrame(()=>toast.classList.add("show"));
    toast._hideTimer=setTimeout(()=>{toast.classList.remove("show");setTimeout(()=>toast.remove(),220);},18000);
}
function queueQrTableServiceVoice(request){
    if(!window.speechSynthesis||typeof SpeechSynthesisUtterance!=="function")return;
    const table=String(request.table_number||"").trim()||"—";
    const cafeName=String(appSettings.restaurantName||currentUser?.business_name||"रेस्टोरेंट").trim();
    const text=String(request.request_type||"")==="clean_table"
        ?`${cafeName}, टेबल नंबर ${table} को कृपया साफ़ कर दें।`
        :`${cafeName}, टेबल नंबर ${table} पर वेटर को बुलाया जा रहा है।`;
    qrServiceSpeechQueue.push({text,request,generation:qrServiceSpeechGeneration});
    if(qrServiceSpeechActive)return;
    const findHindiVoice=()=>{
        const voices=window.speechSynthesis.getVoices();
        const hindiVoices=voices.filter(voice=>/^hi(?:[-_]|$)/i.test(String(voice.lang||"")));
        const maleVoiceName=/(?:^|[\s_-])male(?:$|[\s_-])|hemant|rishi|madhur|amit|arjun|neeraj|rahul|aditya|rohit|vivek/i;
        const naturalVoiceName=/natural|neural|premium|enhanced|google/i;
        const namedMaleVoices=hindiVoices.filter(voice=>maleVoiceName.test(voice.name||""));
        const candidates=namedMaleVoices.length?namedMaleVoices:hindiVoices;
        const voiceScore=voice=>
            (/^hi[-_]IN$/i.test(String(voice.lang||""))?50:0)
            +(naturalVoiceName.test(`${voice.name||""} ${voice.voiceURI||""}`)?25:0)
            +(voice.localService===false?5:0)
            +(voice.default?1:0);
        return candidates.slice().sort((left,right)=>voiceScore(right)-voiceScore(left))[0]||null;
    };
    const waitForHindiVoice=()=>new Promise(resolve=>{
        const existing=findHindiVoice();
        if(existing){resolve(existing);return;}
        let settled=false;
        const finish=voice=>{if(settled)return;settled=true;clearTimeout(timer);window.speechSynthesis.removeEventListener?.("voiceschanged",onVoicesChanged);resolve(voice||null);};
        const onVoicesChanged=()=>{const voice=findHindiVoice();if(voice)finish(voice);};
        const timer=setTimeout(()=>finish(findHindiVoice()),1000);
        window.speechSynthesis.addEventListener?.("voiceschanged",onVoicesChanged);
    });
    const speakNext=async()=>{
        const next=qrServiceSpeechQueue.shift();
        if(!next){qrServiceSpeechActive=false;return;}
        qrServiceSpeechActive=true;
        const generation=next.generation;
        const voice=await waitForHindiVoice();
        if(generation!==qrServiceSpeechGeneration){qrServiceSpeechActive=false;return;}
        const utterance=new SpeechSynthesisUtterance(next.text);
        utterance.lang=voice?.lang||"hi-IN";utterance.rate=0.94;utterance.pitch=1;utterance.volume=1;
        if(voice)utterance.voice=voice;
        let finished=false;
        const finishSpeech=event=>{
            if(finished)return;finished=true;clearTimeout(watchdog);
            if(event?.error&&generation===qrServiceSpeechGeneration){
                pendingQrServiceVoiceRequests.push(next.request);
                armQrServiceSpeechRetry();
            }
            setTimeout(speakNext,180);
        };
        utterance.onend=finishSpeech;
        utterance.onerror=finishSpeech;
        const watchdog=setTimeout(()=>finishSpeech({error:"timeout"}),12000);
        try{window.speechSynthesis.speak(utterance);}catch(_){finishSpeech({error:"not-allowed"});}
    };
    speakNext();
}
async function pollQrTableServiceAlerts(){
    if(!currentUser){stopQrTableServiceAlerts();return;}
    if(document.visibilityState!=="visible"||posQrServiceRequestBusy)return;
    const generation=posQrServiceRequestGeneration,businessId=String(currentUser.business_id||"");
    posQrServiceRequestBusy=true;
    try{
        const query=posQrServiceRequestCursor===null?"":"?afterId="+encodeURIComponent(String(posQrServiceRequestCursor));
        const result=await api("/qr-service-requests"+query);
        if(generation!==posQrServiceRequestGeneration||businessId!==String(currentUser?.business_id||""))return;
        const latestId=Math.max(0,Number(result.latestId)||0);
        if(posQrServiceRequestCursor===null){
            posQrServiceRequestCursor=latestId;
            return;
        }
        if(posQrServiceRequestCursor>latestId){
            posQrServiceRequestCursor=latestId;
        }
        const requests=Array.isArray(result.requests)?result.requests:[];
        if(requests.length){
            const voiceRequests=[];
            let buzzerCount=0;
            for(const request of requests){
                const clean=String(request.request_type||"")==="clean_table";
                const notificationEnabled=appSettings[clean?"qrCleanTableNotification":"qrCallWaiterNotification"]!==false;
                const voiceAndBuzzerEnabled=appSettings[clean?"qrCleanTableSound":"qrCallWaiterSound"]!==false;
                const buzzerOnlyEnabled=appSettings[clean?"qrCleanTableBuzzer":"qrCallWaiterBuzzer"]===true;
                if(notificationEnabled)showQrTableServiceRequestToast(request);
                if(voiceAndBuzzerEnabled)voiceRequests.push(request);
                if(voiceAndBuzzerEnabled||buzzerOnlyEnabled)buzzerCount++;
            }
            voiceRequests.forEach(queueQrTableServiceVoice);
            if(buzzerCount){
                const audio=ensureKOTAlertAudio();
                if(audio?.state==="running"){
                    for(let i=0;i<Math.min(3,buzzerCount);i++)emitPOSNotificationBuzzer();
                }else{
                    pendingQrServiceAlertSounds=Math.min(3,pendingQrServiceAlertSounds+buzzerCount);
                }
            }
        }
        posQrServiceRequestCursor=Math.max(posQrServiceRequestCursor,Number(result.cursorId||result.latestId||0));
    }catch(error){if(generation===posQrServiceRequestGeneration)console.warn("QR table service notification check failed:",error.message);}
    finally{if(generation===posQrServiceRequestGeneration)posQrServiceRequestBusy=false;}
}
function startQrTableServiceAlerts(){
    stopQrTableServiceAlerts();
    if(!currentUser)return;
    // Treat login/reload as a fresh session: establish a baseline and don't replay
    // table-service requests that were already present before the POS reopened.
    posQrServiceRequestCursor=null;
    if(!window.__qrServiceRequestVisibilityListener){document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&currentUser)pollQrTableServiceAlerts();});window.__qrServiceRequestVisibilityListener=true;}
    document.addEventListener("pointerdown",primeKOTAlertAudio,{once:true,capture:true});
    document.addEventListener("keydown",primeKOTAlertAudio,{once:true,capture:true});
    pollQrTableServiceAlerts();
    posQrServiceRequestTimer=setInterval(pollQrTableServiceAlerts,5000);
}
function stopQrTableServiceAlerts(){
    posQrServiceRequestGeneration++;
    if(posQrServiceRequestTimer){clearInterval(posQrServiceRequestTimer);posQrServiceRequestTimer=null;}
    if(qrServiceSpeechRetryHandler){document.removeEventListener("pointerdown",qrServiceSpeechRetryHandler,true);document.removeEventListener("keydown",qrServiceSpeechRetryHandler,true);qrServiceSpeechRetryHandler=null;qrServiceSpeechRetryArmed=false;}
    posQrServiceRequestCursor=null;posQrServiceRequestBusy=false;qrServiceSpeechQueue=[];qrServiceSpeechActive=false;qrServiceSpeechGeneration++;pendingQrServiceAlertSounds=0;pendingQrServiceVoiceRequests=[];
    document.getElementById("qrServiceRequestToastStack")?.remove();
    try{if(window.speechSynthesis)window.speechSynthesis.cancel();}catch(_){}
}
let posQrOrderAlertCursor=null;
let posQrOrderActivityCursor=null;
let posQrOrderAlertTimer=null;
let posQrOrderAlertBusy=false;
function playPOSQrOrderAlertSound(){
    const context=ensureKOTAlertAudio();
    if(!context||context.state!=="running"){
        pendingQrAlertSounds=Math.min(3,pendingQrAlertSounds+1);
        return;
    }
    emitPOSQrOrderAlertSound();
}
function emitPOSQrOrderAlertSound(){
    emitPOSNotificationBuzzer();
}
function showQROrderArrivalToast(arrivals){
    const items=Array.isArray(arrivals)?arrivals:[];
    if(!items.length)return;
    let toast=document.getElementById("qrOrderArrivalToast");
    if(!toast){
        toast=document.createElement("div");
        toast.id="qrOrderArrivalToast";
        toast.className="qr-order-arrival-toast";
        toast.setAttribute("role","status");
        toast.setAttribute("aria-live","polite");
        document.body.appendChild(toast);
    }
    const first=items[0];
    const table=first.table_number?` · Table ${first.table_number}`:"";
    const orderText=items.length===1?`${first.order_number||"New QR order"}${table}`:`${items.length} new QR orders have arrived`;
    const canViewOrders=hasPermission("orders","view");
    toast.innerHTML=`<span class="qr-order-arrival-icon" aria-hidden="true">▦</span><span class="qr-order-arrival-copy"><strong>${items.length===1?"New QR order received":"New QR orders received"}</strong><span>${esc(orderText)}</span></span><button type="button" class="qr-order-arrival-view">${canViewOrders?"View orders":"Open kitchen"}</button><button type="button" class="qr-order-arrival-close" aria-label="Dismiss notification">×</button>`;
    toast.querySelector(".qr-order-arrival-view")?.addEventListener("click",()=>{if(canViewOrders){showPage("orders");updateOrdersTable(true,false);}else{showPage("kitchen");loadKOT(false);}toast.classList.remove("show");});
    toast.querySelector(".qr-order-arrival-close")?.addEventListener("click",()=>toast.classList.remove("show"));
    toast.classList.add("show");
    clearTimeout(toast._hideTimer);
    toast._hideTimer=setTimeout(()=>toast.classList.remove("show"),12000);
}
async function pollPOSQrOrderAlerts(){
    if(!currentUser){stopPOSQrOrderAlerts();return;}
    if((!hasPermission("orders","view")&&!hasPermission("kitchen","view"))||posQrOrderAlertBusy)return;
    posQrOrderAlertBusy=true;
    try{
        const cursors=new URLSearchParams();
        if(posQrOrderAlertCursor!==null)cursors.set("afterId",String(posQrOrderAlertCursor));
        if(posQrOrderActivityCursor!==null)cursors.set("afterActivityId",String(posQrOrderActivityCursor));
        const query=cursors.toString(),url="/orders/qr-notifications"+(query?"?"+query:"");
        const result=await api(url);
        const latest=Number(result.latestOrderId||0);
        const latestActivity=Number(result.latestActivityId||0);
        const arrivals=Array.isArray(result.orders)?result.orders:[];
        const updates=Array.isArray(result.updates)?result.updates:[];
        posQrOrderAlertCursor=Math.max(posQrOrderAlertCursor,latest);
        posQrOrderActivityCursor=Math.max(posQrOrderActivityCursor,latestActivity);
        if(arrivals.length){
            // QR orders are a separate arrival source from regular POS KOTs. Alert
            // kitchen users here instead of relying on the KOT poll's initial seed.
            if(canKitchenReceiveKOTAlerts())playKOTAlertSound();
            else playPOSQrOrderAlertSound();
            showQROrderArrivalToast(arrivals);
        }
        if((arrivals.length||updates.length)&&hasPermission("orders","view")&&document.getElementById("orders")?.classList.contains("active-page"))await updateOrdersTable(true,false);
        const changedSelectedOrder=updates.some(order=>Number(order.id)===Number(window.selectedOrderId));
        if(changedSelectedOrder)await viewOrder(Number(window.selectedOrderId));
    }catch(error){console.warn("QR order notification check failed:",error.message);}
    finally{posQrOrderAlertBusy=false;}
}
function startPOSQrOrderAlerts(){
    if(posQrOrderAlertTimer){clearInterval(posQrOrderAlertTimer);posQrOrderAlertTimer=null;}
    posQrOrderAlertCursor=null;
    posQrOrderActivityCursor=null;
    if(!currentUser||(!hasPermission("orders","view")&&!hasPermission("kitchen","view")))return;
    if(!window.__qrKitchenAlertVisibilityListener){
        document.addEventListener("visibilitychange",()=>{
            if(document.visibilityState==="visible"&&currentUser){pollPOSQrOrderAlerts();pollKOTAlerts();}
        });
        window.__qrKitchenAlertVisibilityListener=true;
    }
    document.addEventListener("pointerdown",primeKOTAlertAudio,{once:true,capture:true});
    document.addEventListener("keydown",primeKOTAlertAudio,{once:true,capture:true});
    pollPOSQrOrderAlerts();
    posQrOrderAlertTimer=setInterval(pollPOSQrOrderAlerts,5000);
}
function stopPOSQrOrderAlerts(){
    if(posQrOrderAlertTimer){clearInterval(posQrOrderAlertTimer);posQrOrderAlertTimer=null;}
    posQrOrderAlertCursor=null;
}
if(!window.__qrOrderRefreshTimer){
    window.__qrOrderRefreshTimer=setInterval(()=>{
        if(document.visibilityState==="visible"&&currentUser&&hasPermission("orders","view")&&document.getElementById("orders")?.classList.contains("active-page"))updateOrdersTable(true,Date.now()-lastOrderDetailsRefreshAt>=60000);
    },15000);
}
