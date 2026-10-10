// ==========================================
// CAFE POS SYSTEM
// Table • Reservation • Orders • KOT • Payment
// Billing • Menu • Customers • Reports
// ==========================================

const API = "/api";
let authToken = sessionStorage.getItem("cafeAuthToken") || "";
let currentUser = null;
let currentDevice = null;
const LOGIN_BUSINESS_NAME_KEY = 'cafeLoginBusinessName';
function settingsLocalStorageKey(){return currentUser&&currentUser.business_id?"cafeAppSettings:"+Number(currentUser.business_id):"cafeAppSettings";}

let sessionExpiryTimer = null;

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

    if (typeof stopKOTAlertPolling === "function") {
        stopKOTAlertPolling();
    }

    kotAlertInitialized = false;
    knownPendingKOTIds = new Set();

    authToken = "";
    currentUser = null;

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
let orderType = "Takeaway";
let selectedPOSChannelKey = "takeaway";

let restaurantTables = [];
let currentOrders = [];
let currentMenu = [];
let currentCustomers = [];
let currentReservations = [];
let billingAdjustments = [];
let currentPayments = [];
let accessUsers = [];
let accessProfiles = [];
let editingMenuItemId = null;
let editingAccessUserId = null;
let editingAccessProfileId = null;

const STARTER_PAYMENT_MODES = [
    { name: "Cash", isCash: true },
    { name: "UPI", isCash: false },
    { name: "Card", isCash: false }
];

let appSettings = {
    restaurantName: "CAFE POS", address: "", phone: "", gstin: "",
    header: "Cafe Management System", footer: "Thank You!\nVisit Again 😊",
    showInvoice: true, showCustomer: true, showCustomerPhone: true,
    showOrder: true, showOrderType: true, showTable: true, showTimestamp: true,
    showGST: true, showPayment: true, showQR: true, uppercaseItems: false, wrapItems: true,
    paperWidth: "80", autoPrint: false, autoClose: true, currency: "₹", gstRate: 5,
    defaultPayment: STARTER_PAYMENT_MODES[0].name, paymentModes: STARTER_PAYMENT_MODES.map(mode => ({ ...mode })), orderPrefix: "ORD-", invoicePrefix: "INV-",
    allowZeroAmount: false, roundTotals: false, logoUrl: "", upiId: "", receiptFont: "Arial",
    printKitchenOnOrder: false, enableReceiptSound: false, openingTime: "09:00", closingTime: "23:00",
    defaultOrderType: "Takeaway", allowOrderNotes: true, showItemNotes: true, lowStockThreshold: 5,
    customerMessage: "Thank you for visiting!", enableNotifications: true, enableKOTSound: true, kotAlertInterval: 5,
    sessionTimeout: 12, auditLog: false,
    uiDensity: "comfortable", accentLabel: "", largeBilling: false, kotEnabled: true, kotDisabledBehavior: "hide"
};
const DEFAULT_APP_SETTINGS = { ...appSettings };

let editingTableId = null;
let editingCustomerId = null;
let currentOrderForDetails = null;
let currentOpenOrderId = null;
let currentOpenOrderData = null;
window.currentOrdersTab = "open";


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
            ...(authToken ? { "Authorization": "Bearer " + authToken } : {}),
            ...(options.headers || {})
        },

        ...options

    });

    let data = {};

    try {
        data = await response.json();
    } catch (_) {
        // Response is not JSON
    }

    if (!response.ok) {
        if (response.status === 401 && authToken) {
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
function hasPermission(moduleKey, action="view") {
    if (!currentUser) return false;
    if (currentUser.profile_name === "Admin") return true;
    return currentUser.permissions?.[`${moduleKey}.${action}`] === true;
}
function showRegisterBusiness() {
    document.getElementById("loginCard")?.classList.add("registration-mode");
    document.getElementById("loginView")?.style.setProperty("display", "none");
    document.getElementById("registerView")?.style.setProperty("display", "block");
    document.getElementById("registerError")?.replaceChildren();
}

function showLoginView() {
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
        alert("Business profile created successfully! Please login.");
        document.getElementById("loginUsername").value=payload.username;
        showLoginView();
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
    renderLoginBusinessWelcome(localStorage.getItem(LOGIN_BUSINESS_NAME_KEY) || "");
    try {
        const response = await fetch(API + "/public/device-business");
        if (!response.ok) return;
        const data = await response.json();
        cacheLoginBusinessName(data.businessName || "");
    } catch (_) {}
}
async function loginUser(event) {
    event?.preventDefault();
    const username=document.getElementById("loginUsername")?.value.trim()||"";
    const password=document.getElementById("loginPassword")?.value||"";
    const box=document.getElementById("loginError"); if(box) box.textContent="";
    try{
        const r=await fetch(API+"/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
        const data=await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.error||"Login failed");
        authToken=data.token; currentUser=data.user; currentDevice=data.device||null; cacheLoginBusinessName(currentUser.business_name); sessionStorage.setItem("cafeAuthToken",authToken);
        const fallbackSessionHours = Math.max(1, Number(appSettings.sessionTimeout || 12));
        scheduleSessionExpiry(data.expiresAt || (Date.now() + fallbackSessionHours * 60 * 60 * 1000));
        primeKOTAlertAudio(); await startAuthenticatedApp(); if(currentUser?.business_name) showProfileToast("Welcome to " + currentUser.business_name + "!");
    }catch(e){if(box) box.textContent=e.message;}
}
async function logoutUser(){clearSessionExpiryTimer();closeProfilePanel();stopKOTAlertPolling();kotAlertInitialized=false;knownPendingKOTIds=new Set();try{if(authToken) await api("/auth/logout",{method:"POST"});}catch(_){} authToken="";currentUser=null;currentDevice=null;sessionStorage.removeItem("cafeAuthToken");const lp=document.getElementById("loginPassword"); if(lp) lp.value="";document.getElementById("loginScreen")?.style.setProperty("display","flex");loadLoginBusinessWelcome();}
async function checkSession(){if(!authToken){document.getElementById("loginScreen")?.style.setProperty("display","flex");return false;}try {
    const r = await api("/auth/me");

    currentUser = r.user;
    currentDevice = r.device || null;
    cacheLoginBusinessName(currentUser?.business_name);

    const fallbackSessionHours = Math.max(1, Number(appSettings.sessionTimeout || 12));
    scheduleSessionExpiry(r.expiresAt || (Date.now() + fallbackSessionHours * 60 * 60 * 1000));

    await startAuthenticatedApp();

    return true;

} catch (_) {
    clearSessionExpiryTimer();

    authToken = "";
    currentUser = null;

    sessionStorage.removeItem("cafeAuthToken");

    document.getElementById("loginScreen")
        ?.style.setProperty("display", "flex");

    return false;
}
}

    document.querySelectorAll(".nav-btn").forEach(function(btn){
        const text=btn.getAttribute("onclick")||"";
        const m=text.match(/showPage\('([^']+)'\)/);
        if(!m)return;

        const page=m[1];
        const mod=
            page==="new-order"
                ?"new_order"
                :(page==="kot-groups"
                    ?"kot_groups"
                    :page);

        let visible=hasPermission(mod,"view");

        if(
            (page==="kitchen"||page==="kot-groups") &&
            appSettings.kotEnabled===false &&
            appSettings.kotDisabledBehavior==="hide"
        ){
            visible=false;
        }

        btn.style.display=visible?"":"none";
    });

    const label=document.getElementById("sessionUserLabel");

    if(label && currentUser){
        const businessName=currentUser.business_name || "Cafe POS";
        const userName=currentUser.display_name || "User";
        const role=currentUser.profile_name || "No Profile";

        label.textContent=`${businessName} · ${userName} · ${role}`;

        const headerTitle=document.querySelector(".header h1");
        if(headerTitle){
            headerTitle.textContent=businessName;
        }

        document.title=`${businessName} · Cafe POS`;
    }

    updateProfilePanelInfo();

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
                    : page);

        let visible = hasPermission(mod, "view");

        if(
            (page === "kitchen" || page === "kot-groups") &&
            appSettings.kotEnabled === false &&
            appSettings.kotDisabledBehavior === "hide"
        ){
            visible = false;
        }

        btn.style.display = visible ? "" : "none";
    });

    const label = document.getElementById("sessionUserLabel");

    if(label && currentUser){
        const businessName = currentUser.business_name || "Cafe POS";
        const userName = currentUser.display_name || "User";
        const role = currentUser.profile_name || "No Profile";

        label.textContent = `${businessName} · ${userName} · ${role}`;

        const headerTitle = document.querySelector(".header h1");

        if(headerTitle){
            headerTitle.textContent = businessName;
        }

        document.title = `${businessName} · Cafe POS`;
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

function profileAction(action){
    closeProfilePanel();
    switch(action){
        case "notification": showProfileToast("🔔 Test notification sent."); break;
        case "sync": showProfileToast("🔄 Syncing data…"); break;
        case "whats-new": showProfileToast("✨ You're on the latest version of Cafe Pilot."); break;
        case "change-business": showBusinessProfileDialog(); break;
        case "about": openBusinessAboutDialog(); break;
    }
}
function showProfileToast(message){
    let toast=document.getElementById("profileToast");
    if(!toast){
        toast=document.createElement("div");
        toast.id="profileToast";
        toast.className="profile-toast";
        document.body.appendChild(toast);
    }
    toast.textContent=message;
    toast.classList.add("show");
    clearTimeout(toast._hideTimer);
    toast._hideTimer=setTimeout(function(){ toast.classList.remove("show"); },2600);
}
function setAboutText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value || "—");
}
function openBusinessAboutDialog() {
    if (!currentUser) return showProfileToast("Sign in to view business information.");
    const location = [currentUser.business_address, currentUser.city, currentUser.state].filter(Boolean).join(", ");
    const branch = [currentUser.business_code, currentUser.city].filter(Boolean).join(" · ") || currentUser.business_name;
    setAboutText("aboutBusinessName", currentUser.business_name || "Current Business");
    setAboutText("aboutBusinessMeta", [currentUser.business_code, currentUser.business_type].filter(Boolean).join(" · "));
    setAboutText("aboutBranch", branch);
    setAboutText("aboutBusinessType", currentUser.business_type || "Cafe");
    setAboutText("aboutOwner", currentUser.owner_name || currentUser.display_name || "—");
    setAboutText("aboutDevice", currentDevice ? [currentDevice.device_name, currentDevice.device_type].filter(Boolean).join(" · ") : "—");
    setAboutText("aboutPhone", currentUser.business_phone || "—");
    setAboutText("aboutEmail", currentUser.business_email || "—");
    setAboutText("aboutAddress", location || "—");
    setAboutText("aboutGstin", currentUser.gstin || "—");
    setAboutText("aboutCurrency", currentUser.currency || appSettings.currency || "₹");
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

async function startAuthenticatedApp(){document.getElementById("loginScreen")?.style.setProperty("display","none");applyPermissionsToUI();await loadSettings();await Promise.all([loadBillingAdjustments(),loadMarketingDeals()]);stopKOTAlertPolling();kotAlertInitialized=false;knownPendingKOTIds=new Set();await Promise.all([hasPermission("dashboard")?updateDashboard():Promise.resolve(),hasPermission("new_order")?loadMenu():Promise.resolve(),hasPermission("menu")?loadMenuManagement():Promise.resolve(),hasPermission("tables")?loadTables():Promise.resolve(),hasPermission("access")?loadAccess():Promise.resolve(),hasPermission("printer")?loadPrinters():Promise.resolve(),(appSettings.kotEnabled!==false && hasPermission("kot_groups")?loadKOTGroups():Promise.resolve())]);updateCart();setOrderType("Takeaway");startKOTAlertPolling();}

// ==========================================
// NAVIGATION
// ==========================================

function showPage(pageName) {

    if ((pageName === "kitchen" || pageName === "kot-groups") && appSettings.kotEnabled === false && appSettings.kotDisabledBehavior === "hide") {
        return;
    }

    const permissionModule = pageName === "new-order" ? "new_order" : (pageName === "table-view" ? "tables" : (pageName === "kot-groups" ? "kot_groups" : (pageName === "advanced-reports" ? "advanced_reports" : pageName)));
    if (!currentUser || !hasPermission(permissionModule, "view")) {
        if (currentUser) alert("You do not have permission to open this module.");
        return;
    }

    const activePage = document.querySelector(".page.active-page");
    if (pageName === "table-view") {
        selectedPOSChannelKey = "dine_in";
        setOrderType("Dine-in", true);
    }
    if (pageName === "new-order" && activePage?.id !== "new-order" && !currentOpenOrderId) {
        if (document.getElementById("tableNumber")?.value) {
            selectedPOSChannelKey = "dine_in";
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
        if (document.getElementById("billModal")?.classList.contains("bill-preview-sidecar")) closeBillModal();
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

    // The header's "+ New Order" button is redundant once you're already
    // on the billing screen, so hide it there and show it everywhere else.
    const newOrderHeaderBtn = document.querySelector(".header .new-order-btn");
    if (newOrderHeaderBtn) {
        newOrderHeaderBtn.style.display = (pageName === "new-order") ? "none" : "";
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

        loadKOTGroups();

    }


    if (pageName === "menu") {

        loadMenuManagement();

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

    }

    if (pageName === "settings") {

        loadSettings();
        loadBillingAdjustmentMaster();

    }

    if (pageName === "access") {

        loadAccess();

    }

}


// ==========================================
// ORDER TYPE
// ==========================================

function setOrderType(type, preserveSaleChannel = false) {
    orderType = type;
    const label = document.getElementById("orderType");
    if (label) label.textContent = type;
    document.getElementById("dineBtn")?.classList.toggle("selected", type === "Dine-in");
    document.getElementById("takeBtn")?.classList.toggle("selected", type === "Takeaway");
    const menuTitle = document.getElementById("billingMenuTitle");
    if (menuTitle) menuTitle.textContent = type === "Dine-in" ? "Dine-in menu" : "Takeaway menu";
    const takeawayHint = document.getElementById("takeawayMenuHint");
    if (takeawayHint) takeawayHint.style.display = type === "Takeaway" ? "" : "none";
    if (!preserveSaleChannel) {
        const preferences = getPOSChannelPreferences();
        const modulePrefs = type === "Dine-in" ? preferences.tableView : preferences.newOrder;
        const fallback = type === "Dine-in" ? "dine_in" : "takeaway";
        let nextChannel = modulePrefs.defaultChannel || fallback;
        if (type === "Dine-in" && !modulePrefs.channels.includes("dine_in")) nextChannel = modulePrefs.channels[0] || "dine_in";
        if (type === "Takeaway" && POS_CHANNELS.find(channel => channel.key === nextChannel)?.orderType !== "Takeaway") {
            nextChannel = modulePrefs.channels.find(key => POS_CHANNELS.find(channel => channel.key === key)?.orderType === "Takeaway") || "takeaway";
        }
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
function addToCart(id,name,price,menuItem=null,variant=null){
    const cartKey=variant?`${id}:${variant.id}`:String(id); const existing=cart.find(x=>String(x.cartKey)===cartKey);
    if(existing) existing.quantity++; else cart.push({id,variantId:variant?.id||null,cartKey,name,price:Number(price),quantity:1,unit:variant?.unit||menuItem?.unit||'ea',taxRate:Number(menuItem?.tax_rate??5),taxMode:menuItem?.tax_mode==='inclusive'?'inclusive':'exclusive'});
    updateCart();
}

function changeQuantity(index, amount) {

    if (!cart[index]) {

        return;

    }


    cart[index].quantity += amount;


    if (cart[index].quantity <= 0) {

        cart.splice(index, 1);

    }


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
    const channel = orderType === "Dine-in" ? "dine-in" : orderType === "Takeaway" ? "takeaway" : String(orderType || "").toLowerCase();
    if (applies !== "all" && applies !== channel) return null;
    return rule;
}

function isMarketingDealAvailableForCheckout(deal) {
    return !marketingDealUnavailableReason(deal);
}

function marketingDealUnavailableReason(deal) {
    if (!deal || deal.active === false) return "Inactive";
    const type = String(deal.type || "").trim().toLowerCase();
    if (["voucher", "payment deals"].includes(type)) return `${deal.type} needs a voucher or payment rule before it can be used at checkout`;
    if (!["discount", "buy x", "buy x get x", "buy x get y", "meal deals", "slab-based discount"].includes(type)) return `${deal.type || "Deal"} is not supported at checkout`;
    if (deal.forNewCustomers) return "Select and verify an eligible new customer first";
    if (deal.useMembership) return "Membership eligibility is not linked to this POS customer yet";
    if (deal.requireAuthentication) return "Customer verification is not configured for this checkout";
    if (Number(deal.maxOccurrences) > 0) return "Usage limits are not tracked for checkout yet";
    const now = new Date();
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    if (deal.startDate && String(deal.startDate) > today) return `Starts ${deal.startDate}`;
    if (deal.endDate && String(deal.endDate) < today) return `Ended ${deal.endDate}`;
    const channels = Array.isArray(deal.channels) ? deal.channels : [];
    const normalizeChannel = value => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (channels.length && !channels.map(normalizeChannel).includes(normalizeChannel(currentSaleChannelKey()))) return "Unavailable on this channel";
    return "";
}

function marketingDealAppliesToLine(deal, line) {
    const menuItem = currentMenu.find(item => String(item.id) === String(line.item.id));
    if (deal.itemId && String(deal.itemId) !== String(line.item.id)) return false;
    if (deal.category) {
        const category = menuItem?.category || line.item.category || "";
        if (String(category).trim().toLowerCase() !== String(deal.category).trim().toLowerCase()) return false;
    }
    return true;
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
        const rewardId = type === "buy x get x" ? rule.itemId : (rule.rewardItemId || (type === "meal deals" ? rule.itemId : null));
        const rewardIndexes = lines.map((line, index) => {
            const itemId = line.item?.id ?? line.item?.menuId ?? line.item?.menu_id;
            return rewardId ? (String(itemId) === String(rewardId) ? index : -1) : (marketingDealAppliesToLine(rule, line) ? index : -1);
        }).filter(index => index >= 0);
        let freeUnits = Math.floor(eligibleQuantity / buyQuantity) * Math.max(1, Number(rule.getQuantity || 1));
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

    const lines = cart.map(item => {
        const gross = Number(item.price || 0) * Number(item.quantity || 0);
        const rate = Math.max(0, Number(item.taxRate ?? appSettings.gstRate ?? 0));
        const inclusive = item.taxMode === "inclusive";
        const net = inclusive && rate ? gross / (1 + rate / 100) : gross;
        return { item, gross, rate, inclusive, net };
    });

    const subtotal = lines.reduce((sum, x) => sum + x.net, 0);

    const discountPlan = marketingDiscountPlan(discountRule, lines);
    const discount = discountPlan.discount;
    let gst = 0;
    let inclusiveTax = 0;
    let exclusiveTax = 0;
    let totalBeforeCharge = 0;
    const taxesByRate = {};

    for (const [index, line] of lines.entries()) {
        const adjustedNet = Math.max(0, line.net - Number(discountPlan.discounts[index] || 0));
        const lineTax = adjustedNet * line.rate / 100;
        gst += lineTax;
        if (line.inclusive) inclusiveTax += lineTax;
        else exclusiveTax += lineTax;
        taxesByRate[String(line.rate)] = (taxesByRate[String(line.rate)] || 0) + lineTax;
        totalBeforeCharge += adjustedNet + lineTax;
    }

    const taxable = Math.max(0, subtotal - discount);
    let serviceCharge = 0;
    if (chargeRule) {
        serviceCharge = chargeRule.calculation === "percent"
            ? taxable * Math.max(0, Number(chargeRule.value || 0)) / 100
            : Math.max(0, Number(chargeRule.value || 0));
    }

    let total = Math.max(0, totalBeforeCharge + serviceCharge);
    if (appSettings.roundTotals) total = Math.round(total);

    return {
        subtotal, discount, serviceCharge, gst, inclusiveTax, exclusiveTax,
        total, taxable, gstRate: null, taxesByRate,
        discountId: discountRule?.source === "marketing" ? null : discountRule?.id || null,
        chargeId: chargeRule?.id || null,
        discountName: discountRule?.name || "",
        chargeName: chargeRule?.name || "",
        marketingDealId: discountRule?.source === "marketing" ? String(discountRule.id) : null,
        marketingDealName: discountRule?.source === "marketing" ? String(discountRule.name || "") : ""
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


    setText("discountAmount", money(b.discount));
    setText("serviceChargeAmount", money(b.serviceCharge));
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

}


function previewCurrentBill() {
    const breakdown = getBillingBreakdown();
    const order = currentOpenOrderData?.order || {};
    openBillPreview({
        viewMode: "side-panel",
        orderNumber: order.order_number || "New Order",
        invoiceNumber: currentOpenOrderData?.invoice?.invoice_number || null,
        orderType,
        tableNumber: document.getElementById("tableNumber")?.value || null,
        subtotal: breakdown.subtotal,
        discount: breakdown.discount,
        discountName: breakdown.discountName,
        serviceCharge: breakdown.serviceCharge,
        chargeName: breakdown.chargeName,
        gst: breakdown.gst,
        total: breakdown.total,
        paymentMethod: order.payment_method || "Pending",
        customerName: document.getElementById("billingCustomerNameQuick")?.value.trim() || "",
        customerPhone: document.getElementById("billingCustomerPhoneQuick")?.value.trim() || "",
        customerEmail: document.getElementById("billingCustomerEmailQuick")?.value.trim() || "",
        items: cart.map(item => ({
            name: item.name,
            price: Number(item.price),
            quantity: Number(item.quantity)
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
    if (modal?.classList.contains("bill-preview-sidecar") && modal.style.display !== "none") previewCurrentBill();
}


// ==========================================
// MENU
// ==========================================

const POS_CHANNELS = [
    { key: "dine_in", label: "Dine-In", orderType: "Dine-in" },
    { key: "takeaway", label: "Takeaway Meal", orderType: "Takeaway" },
    { key: "delivery", label: "Delivery", orderType: "Takeaway" },
    { key: "online", label: "Online", orderType: "Takeaway" }
];
function defaultPOSChannelPreferences() {
    return {
        newOrder: { channels: ["dine_in", "takeaway", "delivery", "online"], defaultChannel: "takeaway" },
        tableView: { channels: ["dine_in"], defaultChannel: "dine_in" }
    };
}
function normalizePOSChannelPreferences(value) {
    const defaults = defaultPOSChannelPreferences();
    const normalizeModule = function(moduleValue, fallback) {
        const valid = Array.isArray(moduleValue?.channels) ? moduleValue.channels.filter(key => POS_CHANNELS.some(channel => channel.key === key)) : [];
        const channels = valid.length ? [...new Set(valid)] : fallback.channels.slice();
        const defaultChannel = channels.includes(moduleValue?.defaultChannel) ? moduleValue.defaultChannel : channels[0];
        return { channels, defaultChannel };
    };
    const newOrder = normalizeModule(value?.newOrder, defaults.newOrder);
    if (!newOrder.channels.some(key => POS_CHANNELS.find(channel => channel.key === key)?.orderType === "Takeaway")) newOrder.channels.push("takeaway");
    if (POS_CHANNELS.find(channel => channel.key === newOrder.defaultChannel)?.orderType !== "Takeaway") {
        newOrder.defaultChannel = newOrder.channels.find(key => POS_CHANNELS.find(channel => channel.key === key)?.orderType === "Takeaway") || "takeaway";
    }
    const tableView = normalizeModule(value?.tableView, defaults.tableView);
    if (!tableView.channels.includes("dine_in")) tableView.channels.unshift("dine_in");
    tableView.defaultChannel = "dine_in";
    return {
        newOrder,
        tableView
    };
}
function getPOSChannelPreferences() {
    return normalizePOSChannelPreferences(appSettings.posChannelPreferences);
}
function renderBillingSaleChannelOptions() {
    const select = document.getElementById("billingSaleChannel");
    if (!select) return;
    const preferences = getPOSChannelPreferences();
    const modulePrefs = orderType === "Dine-in" ? preferences.tableView : preferences.newOrder;
    const channels = modulePrefs.channels.length ? modulePrefs.channels : [orderType === "Dine-in" ? "dine_in" : "takeaway"];
    if (!channels.includes(selectedPOSChannelKey)) selectedPOSChannelKey = modulePrefs.defaultChannel || channels[0];
    select.innerHTML = channels.map(key => {
        const channel = POS_CHANNELS.find(entry => entry.key === key);
        return channel ? "<option value=\"" + esc(channel.key) + "\">" + esc(channel.label) + "</option>" : "";
    }).join("");
    if (channels.includes(selectedPOSChannelKey)) select.value = selectedPOSChannelKey;
    else {
        selectedPOSChannelKey = modulePrefs.defaultChannel || channels[0];
        select.value = selectedPOSChannelKey;
    }
}

function clearNewOrderDraft() {
    cart = [];
    currentOpenOrderId = null;
    currentOpenOrderData = null;

    const clearFields = [
        "tableNumber",
        "billingOrderNotes",
        "billingCustomerNameQuick",
        "billingCustomerPhoneQuick",
        "billingCustomerEmailQuick",
        "billingDiscountSelect",
        "billingChargeSelect"
    ];
    clearFields.forEach(id => {
        const field = document.getElementById(id);
        if (field) field.value = "";
    });

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
    const channel = POS_CHANNELS.find(entry => entry.key === channelKey);
    if (!channel) return;
    selectedPOSChannelKey = channelKey;
    if (channel.orderType !== orderType) setOrderType(channel.orderType, true);
    renderBillingSaleChannelOptions();
    renderBillingAdjustmentSelectors();
    await loadMenu();
    cart = cart.map(entry => {
        const item = currentMenu.find(candidate => Number(candidate.id) === Number(entry.id));
        const variant = item?.variants?.find(candidate => Number(candidate.id) === Number(entry.variantId));
        return item ? { ...entry, price: resolveMenuPrice(item, variant || null) } : entry;
    });
    updateCart();
}
function currentSaleChannelKey() {
    return selectedPOSChannelKey || (orderType === "Dine-in" ? "dine_in" : "takeaway");
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
        const variant = item?.variants?.find(candidate => Number(candidate.id) === Number(entry.variantId));
        return item ? { ...entry, price: resolveMenuPrice(item, variant || null) } : entry;
    });
    updateCart();
}
function menuTaxLabel(item){ return item?.tax_label || (Number(item?.tax_rate||0) ? `GST ${Number(item.tax_rate)}%` : 'Tax 0%'); }
function getAvailableMenuVariants(item) {
    return Array.isArray(item?.variants)
        ? item.variants.filter(variant => variant && variant.available !== false && variant.available !== 0 && !["false", "0"].includes(String(variant.available).toLowerCase()))
        : [];
}
function selectBillingMenuItem(item) {
    if (Array.isArray(item?.variants) && item.variants.length) {
        openVariantPicker(item);
        return;
    }
    addToCart(item.id, item.name, resolveMenuPrice(item), item);
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
function chooseVariant(menuId,variantId){const item=currentMenu.find(x=>Number(x.id)===Number(menuId));const v=getAvailableMenuVariants(item).find(x=>Number(x.id)===Number(variantId));if(!item||!v)return;addToCart(item.id,`${item.name} — ${v.name}`,resolveMenuPrice(item,v),item,v);closeVariantPicker();}

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
            results.hidden = true;
            results.innerHTML = "";
        });
    });
}

let menuCategories=[];
async function loadMenuCategories(){
    try{
        menuCategories=await api('/menu/categories');
        renderMenuCategoryMaster();
        populateMenuCategorySelect();
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
        currentMenu.filter(x => x.available !== false).forEach(item => {
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

function menuIcon(category) {

    const c =
        String(category || "")
            .toLowerCase();


    if (c.includes("coffee")) {

        return "☕";

    }


    if (c.includes("burger")) {

        return "🍔";

    }


    if (c.includes("pizza")) {

        return "🍕";

    }


    if (c.includes("drink")) {

        return "🥤";

    }


    if (c.includes("dessert")) {

        return "🍰";

    }


    return "🍝";

}


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

async function openPayment() {
    const newOrderPage = document.getElementById("new-order");
    if (!newOrderPage?.classList.contains("active-page")) return;
    if (!cart.length) return alert("Please add at least one item.");
    if (orderType === "Dine-in" && !document.getElementById("tableNumber")?.value) return alert("Please select a table for Dine-in.");

    paymentCollectedSoFar = 0;
    if (currentOpenOrderId) {
        try {
            const summary = await api(`/orders/${currentOpenOrderId}/payment-summary`);
            paymentCollectedSoFar = Math.max(0, Number(summary.amountCollected || 0));
        } catch (error) {
            return alert("Unable to load previous payments: " + error.message);
        }
    }
    if (!newOrderPage.classList.contains("active-page") || !cart.length) return;

    const breakdown = getBillingBreakdown();
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
    if (date) date.textContent = new Date().toLocaleString();
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

function setPaymentCategory(category) {
    const previousCategory = paymentCategory;
    paymentCategory = ["full", "partial", "split", "non-chargeable"].includes(category) ? category : "full";
    const nonChargeable = paymentCategory === "non-chargeable";
    const single = document.getElementById("singlePaymentEntry");
    const split = document.getElementById("splitPaymentEntry");
    const notice = document.getElementById("nonChargeableNotice");
    const methods = document.querySelector(".pos-payment-method-section");
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
    const b = getBillingBreakdown();
    const setMoney = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = money(value); };
    setMoney("paymentSubtotal", b.subtotal);
    setMoney("paymentCharges", b.serviceCharge);
    setMoney("paymentTax", b.gst);
    setMoney("paymentDiscount", b.discount);
    setMoney("paymentBillTotal", b.total);
    setMoney("paymentBillTotalHeader", b.total);
    const due = Math.max(0, Number(b.total || 0) - paymentCollectedSoFar);
    let currentCollection = 0;
    if (paymentCategory === "partial") currentCollection = Math.max(0, Number(document.getElementById("cashReceived")?.value || 0));
    if (paymentCategory === "split") currentCollection = splitPayments.reduce((sum, payment) => sum + payment.amount, 0);
    if (paymentCategory === "full") currentCollection = due;
    if (paymentCategory === "non-chargeable") currentCollection = 0;
    setMoney("paymentAmountCollected", paymentCollectedSoFar + currentCollection);
    setMoney("paymentAmountDue", paymentCategory === "non-chargeable" ? 0 : Math.max(0, due - currentCollection));
    const entered = Number(document.getElementById("cashReceived")?.value || 0);
    const applied = paymentCategory === "partial" ? entered : due;
    setMoney("changeAmount", isCashPaymentMethod(selectedPaymentMethod) && paymentCategory !== "split" ? Math.max(0, entered - applied) : 0);
    const allocations = document.getElementById("paymentAllocations");
    if (allocations) allocations.innerHTML = splitPayments.map(payment => `<div><span>${esc(payment.method)}</span><strong>${money(payment.amount)}</strong></div>`).join("");
}
function updateCashChange() { updatePaymentSummary(); }
function choosePayment(method) { selectPaymentMethod(method); }

async function confirmPOSPayment() {
    const due = Math.max(0, Number(getBillingBreakdown().total || 0) - paymentCollectedSoFar);
    if (paymentCategory === "non-chargeable") {
        return completeOrder("Non-chargeable", { nonChargeable: true, amountDue: due, keepOpen: false });
    }
    if (paymentCategory === "partial") {
        const amount = Math.round(Number(document.getElementById("cashReceived")?.value || 0) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0 || amount >= due) return alert("Enter an amount greater than zero and less than the remaining balance. Use Full Payment to settle the full balance.");
        if (isCashPaymentMethod(selectedPaymentMethod) && Number(document.getElementById("cashReceived")?.value || 0) < amount) return alert("Cash received is less than the payment amount.");
        return completeOrder(selectedPaymentMethod, { payments: [{ method: selectedPaymentMethod, amount }], amountDue: due, keepOpen: true });
    }
    if (paymentCategory === "split") {
        const amount = Math.round(splitPayments.reduce((sum, payment) => sum + payment.amount, 0) * 100) / 100;
        if (splitPayments.length < 2) return alert("Add at least two payment methods for a split payment.");
        if (Math.abs(amount - due) > 0.01) return alert("Split payments must add up to the remaining balance of " + money(due) + ".");
        return completeOrder(splitPayments.map(payment => payment.method).join(" + "), { payments: splitPayments.slice(), amountDue: due, keepOpen: false });
    }
    const tendered = Number(document.getElementById("cashReceived")?.value || 0);
    if (isCashPaymentMethod(selectedPaymentMethod) && tendered < due) return alert("Cash received is less than the remaining bill amount.");
    return completeOrder(selectedPaymentMethod, { payments: [{ method: selectedPaymentMethod, amount: due }], amountDue: due, keepOpen: false });
}

let completingOrder = false;
let clearNewOrderDraftAfterPayment = false;

async function completeOrder(paymentMethod, paymentOptions = {}) {
    if (completingOrder) return;
    if (!cart.length) return alert("There are no items in the order.");
    completingOrder = true;
    const subtotal = calculateSubtotal();
    const b = getBillingBreakdown();
    const gst = b.gst;
    const total = b.total;
    const paymentsToRecord = Array.isArray(paymentOptions.payments) ? paymentOptions.payments : [{ method: paymentMethod, amount: total }];

    try {
        const tableNumber = document.getElementById("tableNumber")?.value || null;
        const customerName = document.getElementById("billingCustomerNameQuick")?.value.trim() || "";
        const customerPhone = document.getElementById("billingCustomerPhoneQuick")?.value.trim() || "";
        const customerEmail = document.getElementById("billingCustomerEmailQuick")?.value.trim() || "";
        if (customerName || customerPhone || customerEmail) {
            if (!customerName || !customerPhone) throw new Error("Please enter both customer name and phone number, or leave customer details blank.");
        }
        let billingCustomer = null;
        if (customerName && customerPhone) {
            const customerResult = await api("/customers/save-for-billing", { method: "POST", body: JSON.stringify({ name: customerName, phone: customerPhone, email: customerEmail || null }) });
            billingCustomer = customerResult.customer || null;
            cacheBillingCustomer(billingCustomer);
        }
        const orderPayload = {
            orderType, tableNumber, subtotal, gst, total, paymentMethod,
            customerId: billingCustomer?.id || currentOpenOrderData?.order?.customer_id || null,
            discount: b.discount, serviceCharge: b.serviceCharge,
            discountAdjustmentId: b.discountId, chargeAdjustmentId: b.chargeId,
            marketingDealId: b.marketingDealId, marketingDealName: b.marketingDealName,
            notes: document.getElementById("billingOrderNotes")?.value.trim() || null,
            items: cart.map(item => ({ menuId: item.id, variantId: item.variantId || null, name: item.name, price: item.price, quantity: item.quantity, unit: item.unit, taxRate: item.taxRate, taxMode: item.taxMode }))
        };
        let order;
        let orderNumber;
        let billItems;
        if (currentOpenOrderId) {
            const existing = currentOpenOrderData || await api(`/orders/${currentOpenOrderId}`);
            const orderId = existing.order?.id || currentOpenOrderId;
            const updated = await api(`/orders/${orderId}`, { method: "PUT", body: JSON.stringify(orderPayload) });
            order = updated.order;
            orderNumber = order.order_number;
            billItems = cart.map(item => ({ name: item.name, price: Number(item.price), quantity: Number(item.quantity) }));
        } else {
            orderNumber = (appSettings.orderPrefix || "ORD-") + Date.now().toString().slice(-8);
            const kotEnabled = appSettings.kotEnabled !== false;
            const initialStatus = paymentOptions.keepOpen ? "Open" : (kotEnabled ? "Pending" : "Completed");
            const result = await api("/orders", { method: "POST", body: JSON.stringify({ orderNumber, ...orderPayload, initialStatus, createKot: !paymentOptions.keepOpen && kotEnabled }) });
            order = result.order;
            billItems = cart.map(item => ({ name: item.name, price: Number(item.price), quantity: Number(item.quantity) }));
        }

        const paymentStatus = paymentOptions.nonChargeable ? "Non-chargeable" : "Success";
        for (const payment of paymentsToRecord) {
            await api("/payments", { method: "POST", body: JSON.stringify({ orderId: order.id, orderNumber: order.order_number || orderNumber, amount: paymentOptions.nonChargeable ? 0 : Number(payment.amount), paymentMethod: paymentOptions.nonChargeable ? "Non-chargeable" : payment.method, paymentStatus, transactionId: null }) });
        }

        if (paymentOptions.keepOpen) {
            closePayment();
            cart = [];
            currentOpenOrderId = null;
            currentOpenOrderData = null;
            const tableInput = document.getElementById("tableNumber");
            if (tableInput) tableInput.value = "";
            updateCart();
            await loadTables();
            await updateDashboard();
            await updateOrdersTable();
            showPage("orders");
            showProfileToast("Partial payment recorded. The order remains open with a balance due.");
            return;
        }

        const invoiceResult = await api("/invoices", { method: "POST", body: JSON.stringify({ orderId: order.id, customerId: order.customer_id || billingCustomer?.id || null }) });
        const completion = await api(`/orders/${order.id}/complete`, { method: "PUT" });
        const completedOrder = completion.order || order;
        const kotEnabled = appSettings.kotEnabled !== false;
        closePayment();
        cart = [];
        currentOpenOrderId = null;
        currentOpenOrderData = null;
        const tableInput = document.getElementById("tableNumber");
        if (tableInput) tableInput.value = "";
        updateCart();
        if (kotEnabled && appSettings.printKitchenOnOrder && !paymentOptions.nonChargeable) {
            try { await printKOT(order.id); } catch (_) {}
        }
        openBillPreview({
            orderNumber: completedOrder.order_number || orderNumber,
            invoiceNumber: invoiceResult.invoice?.invoice_number || null,
            orderType: completedOrder.order_type || orderType,
            tableNumber: completedOrder.table_number || tableNumber,
            subtotal: Number(completedOrder.subtotal || subtotal),
            discount: Number(completedOrder.discount ?? b.discount),
            discountName: b.discountName,
            serviceCharge: Number(completedOrder.service_charge ?? b.serviceCharge),
            chargeName: b.chargeName,
            gst: Number(completedOrder.gst || gst),
            total: Number(completedOrder.total || total),
            paymentMethod, customerId: completedOrder.customer_id || billingCustomer?.id || null,
            customerName: completedOrder.customer_name || billingCustomer?.name || customerName || null,
            customerPhone: completedOrder.customer_phone || billingCustomer?.phone || customerPhone || null,
            customerEmail: completedOrder.customer_email || billingCustomer?.email || customerEmail || null,
            items: billItems
        });
        window.printThermalBill();
        await loadTables();
        await updateDashboard();
        await updateOrdersTable();
        showPage("orders");
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
        quantity: item.quantity,
        unit: item.unit,
        taxRate: item.taxRate,
        taxMode: item.taxMode
    }));
    const customerName = document.getElementById("billingCustomerNameQuick")?.value.trim() || "";
    const customerPhone = document.getElementById("billingCustomerPhoneQuick")?.value.trim() || "";
    const customerEmail = document.getElementById("billingCustomerEmailQuick")?.value.trim() || "";

    if (customerName || customerPhone || customerEmail) {
        if (!customerName || !customerPhone) return alert("Please enter both customer name and phone number, or leave customer details blank.");
    }

    try {
        let billingCustomer = null;
        if (customerName && customerPhone) {
            const r = await api("/customers/save-for-billing", {
                method: "POST",
                body: JSON.stringify({ name: customerName, phone: customerPhone, email: customerEmail || null })
            });
            billingCustomer = r.customer || null;
            cacheBillingCustomer(billingCustomer);
        }

        if (openOrderId) {
            const result = await api(`/orders/${openOrderId}`, {
                method: "PUT",
                body: JSON.stringify({
                    orderType: orderTypeToSave, tableNumber, subtotal, gst: b.gst, total: b.total,
                    paymentMethod: null,
                    customerId: billingCustomer?.id || openOrderData?.order?.customer_id || null,
                    discount: b.discount,
                    serviceCharge: b.serviceCharge,
                    discountAdjustmentId: b.discountId,
                    chargeAdjustmentId: b.chargeId,
                    marketingDealId: b.marketingDealId,
                    marketingDealName: b.marketingDealName,
                    notes: orderNotes || null,
                    items
                })
            });
            cart = [];
            currentOpenOrderId = null;
            currentOpenOrderData = null;
            updateCart();
            await loadTables(); await updateDashboard(); await updateOrdersTable();
            alert(`Open order updated successfully.\n\nOrder: ${result.order.order_number}`);
            showPage("orders");
            return;
        }

        const orderNumber = (appSettings.orderPrefix || "ORD-") + Date.now().toString().slice(-8);
        const result = await api("/orders", {
            method: "POST",
            body: JSON.stringify({
                orderNumber, orderType: orderTypeToSave, tableNumber, subtotal,
                gst: b.gst, total: b.total, paymentMethod: null,
                customerId: billingCustomer?.id || null,
                discount: b.discount, serviceCharge: b.serviceCharge,
                discountAdjustmentId: b.discountId, chargeAdjustmentId: b.chargeId,
                marketingDealId: b.marketingDealId,
                marketingDealName: b.marketingDealName,
                notes: orderNotes || null,
                initialStatus: "Open", createKot: false, items
            })
        });

        cart = [];
        currentOpenOrderId = null;
        currentOpenOrderData = null;
        updateCart();
        alert(`Order saved successfully.\n\nOrder: ${orderNumber}\nStatus: Open`);
        await loadTables(); await updateDashboard(); await updateOrdersTable();
        showPage("orders");
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
        cart = (data.items || []).map(item => ({
            id: item.menu_id || ("order-item-" + item.id),
            variantId: item.variant_id || null,
            cartKey: item.variant_id ? `${item.menu_id}:${item.variant_id}` : String(item.menu_id || item.id),
            name: item.item_name,
            price: Number(item.price),
            quantity: Number(item.quantity),
            unit: item.unit || 'ea',
            taxRate: Number(item.tax_rate ?? 5),
            taxMode: item.tax_mode === 'inclusive' ? 'inclusive' : 'exclusive'
        }));
        orderType = order.order_type || "Dine-in";
        setOrderType(orderType);
        const tableSelect = document.getElementById("tableNumber");
        if (tableSelect) tableSelect.value = order.table_number || tableSelect.value;
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
    modal?.classList.toggle("bill-preview-sidecar", data?.viewMode === "side-panel");

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

    document.getElementById("billDate").textContent =
        data.date || new Date().toLocaleString();

    document.getElementById("billOrderType").textContent =
        data.orderType || "-";

    document.getElementById("billTableNumber").textContent =
        data.tableNumber || "-";

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

    document.getElementById("billTotal").textContent =
        money(data.total || 0);

    document.getElementById("billPaymentMethod").textContent =
        data.paymentMethod || "-";

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

    if (billCustomerRow && billCustomerDetails) {
        billCustomerRow.style.display =
            customerParts.length ? "block" : "none";
        billCustomerDetails.textContent =
            customerParts.join(" • ");
    }

    const body = document.getElementById("billItemsBody");

    if (body) {

        body.innerHTML = "";

        (data.items || []).forEach(function(item) {

            const row = document.createElement("tr");

            const qty = Number(item.quantity || 0);
            const price = Number(item.price || 0);
            const lineTotal = qty * price;

            row.innerHTML =
                "<td>" + esc(item.name || "-") + "</td>" +
                "<td>" + qty + "</td>" +
                "<td>" + money(price) + "</td>" +
                "<td>" + money(lineTotal) + "</td>";

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
    }

};


window.printBill = function() {

    window.printThermalBill();
};

  const width =
    document.getElementById(
        "thermalPaperWidth"
    )?.value ||
    localStorage.getItem(
        "cafeThermalPaperWidth"
    ) ||
    "80";

window.printThermalBill = async function() {
    const data = window.currentBillData;
    if (!data) return alert("No bill is available to print.");

    const defaultPrinter = (window.cafePrinters || []).find(function(printer) {
        return printer.is_default && printer.active !== false;
    });

    if (!defaultPrinter) {
        return alert("No default bill printer is configured. Open Printer settings and select a default printer.");
    }

    try {
        // LOCAL = Windows installed printer. Print directly through the local Cafe POS Printer Service.
        if (defaultPrinter.connection_type === "local") {
            if (isVirtualWindowsPrinter(defaultPrinter.name)) {
                throw new Error("The default is a virtual printer. Select a physical ESC/POS thermal receipt printer in Printer settings.");
            }
            const serviceUrl = window.CAFE_PRINT_SERVICE_URL || "http://127.0.0.1:18181";
            const receipt = printerReceiptText(data);
            const response = await fetch(serviceUrl + "/print", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    printerName: defaultPrinter.name,
                    receipt: receipt,
                    paperWidth: defaultPrinter.paper_width || appSettings.paperWidth || "80"
                })
            });
            const result = await response.json().catch(function(){ return {}; });
            if (!response.ok) throw new Error(result.error || "Windows print service rejected the job.");
            showProfileToast("Bill sent to " + defaultPrinter.name + ".");
            return;
        }

        if (defaultPrinter.connection_type === "network") {
            await api("/printers/" + defaultPrinter.id + "/print", {
                method: "POST",
                body: JSON.stringify({ receipt: data, settings: appSettings })
            });
            showProfileToast("Bill sent to " + defaultPrinter.name + ".");
            return;
        }

        if (defaultPrinter.connection_type === "bluetooth") {
            await sendBluetoothPrinterText(defaultPrinter, printerReceiptText(data));
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

async function updateOrdersTable(refresh = true) {
    try {
        if (refresh || !Array.isArray(currentOrders)) currentOrders = await api("/orders");
        const tbody = document.getElementById("ordersTableBody");
        if (!tbody) return;

        // Open tab keeps every non-closed order visible, including the existing
        // KOT workflow states (Pending / Preparing / Ready) so nothing is removed.
        const openOrders = currentOrders.filter(order => !["completed", "cancelled"].includes(String(order.status).toLowerCase()));
        const cancelledOrders = currentOrders.filter(order => String(order.status).toLowerCase() === "cancelled");
        const closedOrders = currentOrders.filter(order => String(order.status).toLowerCase() === "completed");
        const activeOrders = currentOrders.filter(order => !["open", "completed", "cancelled"].includes(String(order.status).toLowerCase()));

        const tabOrders = window.currentOrdersTab === "cancelled" ? cancelledOrders : window.currentOrdersTab === "closed" ? closedOrders : openOrders;
        const query = String(document.getElementById("ordersSearch")?.value || "").trim().toLocaleLowerCase();
        const visibleOrders = tabOrders.filter(order => !query || [order.order_number, order.id, order.order_type, order.table_number, order.status, order.payment_method, order.customer_name].some(value => String(value || "").toLocaleLowerCase().includes(query)));
        tbody.innerHTML = "";

        visibleOrders.forEach(function(order) {
            const tr = document.createElement("tr");
            const isOpen = String(order.status).toLowerCase() === "open";
            const cancellable = !["Completed", "Cancelled"].includes(order.status);
            tr.innerHTML = `
                <td>${esc(order.order_number)}</td>
                <td>${esc(order.order_type)}</td>
                <td>${esc(order.table_number || "-")}</td>
                <td>${money(order.total)}</td>
                <td>${esc(order.payment_method || (isOpen ? "Unpaid" : "-"))}</td>
                <td>${esc(order.status)}</td>
                <td>${new Date(order.created_at).toLocaleString()}</td>
                <td>
                    <div class="order-row-actions">
                    <button type="button" onclick="viewOrder(${order.id})">👁️ View</button>
                    <button type="button" onclick="viewOrderActivity(${order.id})">◷ Activity</button>
                    ${isOpen ? `<button onclick="editOpenOrder(${order.id})">✏️ Edit</button><button onclick="payOpenOrder(${order.id})">💳 Pay</button>` : ""}
                    ${cancellable ? `<button onclick="cancelOrder(${order.id})">❌ Cancel</button>` : ""}
                    </div>
                </td>`;
            tbody.appendChild(tr);
        });

        if (!visibleOrders.length) {
            const label = query ? "orders match your search" : window.currentOrdersTab === "cancelled" ? "cancelled" : window.currentOrdersTab === "closed" ? "closed/completed" : "open";
            tbody.innerHTML = `<tr><td colspan="8" class="orders-empty-state">No ${label} orders.</td></tr>`;
        }

        const openCount = document.getElementById("openOrdersCount");
        const closedCount = document.getElementById("closedOrdersCount");
        const activeCount = document.getElementById("activeOrdersCount");
        if (openCount) openCount.textContent = openOrders.length;
        if (closedCount) closedCount.textContent = closedOrders.length;
        const cancelledCount = document.getElementById("cancelledOrdersCount");
        if (cancelledCount) cancelledCount.textContent = cancelledOrders.length;
        if (activeCount) activeCount.textContent = activeOrders.length;
    } catch (error) {
        console.error("Orders failed:", error);
    }
}

function filterOrders() {
    updateOrdersTable(false);
}

function clearOrdersSearch() {
    const input = document.getElementById("ordersSearch");
    if (input) input.value = "";
    updateOrdersTable(false);
    input?.focus();
}

window.switchOrdersTab = function(tab) {
    window.currentOrdersTab = ["closed","cancelled"].includes(tab) ? tab : "open";
    document.querySelectorAll(".orders-tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === window.currentOrdersTab));
    updateOrdersTable();
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
                <div class="order-activity-copy"><strong>${esc(item.event_type || "Order updated")}</strong><p>${esc(item.description || "-")}</p><small>${esc(item.actor || "Staff")} · ${esc(item.created_at ? new Date(item.created_at).toLocaleString() : "-")}</small></div>
            </article>`).join("") : '<p class="access-muted">No activity has been recorded for this order.</p>';
    } catch (error) {
        list.innerHTML = `<p class="access-muted">Unable to load activity: ${esc(error.message)}</p>`;
    }
}

function closeOrderActivity() {
    const modal = document.getElementById("orderActivityModal");
    if (modal) modal.style.display = "none";
}

async function viewOrder(orderId) {

    try {

        const data =
            await api(
                `/orders/${orderId}`
            );


        currentOrderForDetails =
            data;


        const order =
            data.order;


        const items =
            data.items || [];


        const box =
            document.getElementById(
                "orderDetailsContent"
            );


        if (!box) {

            return;

        }


        box.innerHTML = `

            <h2>
                ${esc(order.order_number)}
            </h2>

            <p>

                <strong>Type:</strong>
                ${esc(order.order_type)}

                &nbsp;

                <strong>Table:</strong>
                ${esc(
                    order.table_number || "-"
                )}

            </p>


            <p>

                <strong>Status:</strong>
                ${esc(order.status)}

                &nbsp;

                <strong>Payment:</strong>
                ${esc(
                    order.payment_method || "-"
                )}

            </p>


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
                                                )}
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


                <div class="total">

                    <strong>Total</strong>

                    <strong>
                        ${money(order.total)}
                    </strong>

                </div>

            </div>

        `;


        const modal =
            document.getElementById(
                "orderDetailsModal"
            );


        if (modal) {

            modal.style.display =
                "flex";

        }


    } catch (error) {

        alert(error.message);

    }

}


function closeOrderDetails() {

    const modal =
        document.getElementById(
            "orderDetailsModal"
        );


    if (modal) {

        modal.style.display =
            "none";

    }

}


async function cancelOrder(orderId) {

    const reason =
        prompt(
            "Enter cancellation reason:",
            "Customer cancelled"
        );


    if (reason === null) {

        return;

    }


    if (!confirm("Cancel this order?")) {

        return;

    }


    try {

        await api(
            `/orders/${orderId}/cancel`,
            {

                method: "PUT",

                body: JSON.stringify({
                    reason
                })

            }
        );


        alert(
            "Order cancelled."
        );


        await updateOrdersTable();

        await loadTables();

        await updateDashboard();


    } catch (error) {

        alert(error.message);

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
        invoiceNumber: order.invoice_number || order.invoiceNumber || order.order_number || "-",
        orderNumber: order.order_number || "-",
        orderType: order.order_type || "-",
        tableNumber: order.table_number || "",
        date: order.created_at ? new Date(order.created_at).toLocaleString() : new Date().toLocaleString(),
        customerName: order.customer_name || "",
        customerPhone: order.customer_phone || "",
        customerEmail: order.customer_email || "",
        items: sourceItems.map(function(item) {
            return {
                name: item.item_name || item.name || "-",
                quantity: Number(item.quantity || 0),
                price: Number(item.price || 0)
            };
        }),
        subtotal: Number(order.subtotal || 0),
        gst: Number(order.gst || 0),
        total: Number(order.total || 0),
        paymentMethod: order.payment_method || "-"
    };

    await window.printThermalBill();
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

                            <div class="table-card">

                                <div class="table-card-header">

                                    <h3>
                                        ${esc(
                                            table.table_number
                                        )}
                                    </h3>

                                    <span
                                        class="table-status ${String(
                                            table.status
                                        ).toLowerCase()}"
                                    >
                                        ${esc(
                                            table.status
                                        )}
                                    </span>

                                </div>


                                <div class="table-icon">
                                    🪑
                                </div>


                                <p>
                                    Capacity:
                                    ${table.capacity}
                                    people
                                </p>


                                <div class="table-actions">

                                    <button
                                        onclick="changeTableStatus(${table.id}, 'Available')"
                                    >
                                        Available
                                    </button>


                                    <button
                                        onclick="changeTableStatus(${table.id}, 'Occupied')"
                                    >
                                        Occupied
                                    </button>


                                    <button
                                        onclick="changeTableStatus(${table.id}, 'Reserved')"
                                    >
                                        Reserved
                                    </button>


                                    <button
                                        onclick="openEditTableModal(${table.id})"
                                    >
                                        ✏️ Edit
                                    </button>


                                    <button
                                        onclick="deleteTable(${table.id}, '${esc(table.table_number)}')"
                                    >
                                        🗑️ Delete
                                    </button>

                                </div>

                            </div>

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


async function deleteTable(id, number) {

    if (
        !confirm(
            `Delete ${number}?\n\nThis cannot be undone.`
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
            `${number} deleted successfully! 🗑️`
        );


    } catch (error) {

        alert(error.message);

    }

}


// ==========================================
// RESERVATIONS
// ==========================================

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

                const active =
                    [
                        "Reserved",
                        "Confirmed"
                    ].includes(
                        reservation.status
                    );


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

                        ${
                            active
                                ? `

                                    <button
                                        onclick="updateReservationStatus(${reservation.id}, 'Confirmed')"
                                    >
                                        Confirm
                                    </button>

                                    <button
                                        onclick="updateReservationStatus(${reservation.id}, 'Arrived')"
                                    >
                                        Arrived
                                    </button>

                                    <button
                                        onclick="updateReservationStatus(${reservation.id}, 'Cancelled')"
                                    >
                                        Cancel
                                    </button>

                                `
                                : `

                                    <button
                                        onclick="updateReservationStatus(${reservation.id}, 'Reserved')"
                                    >
                                        Reserve
                                    </button>

                                `
                        }

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


    if (form) {

        form.style.display =
            form.style.display === "none"
                ? "block"
                : "none";

    }


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


        alert(
            "Reservation created! 📅"
        );


        document.getElementById(
            "reservationForm"
        ).style.display =
            "none";


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

function getKOTGroupName(id){
    const g=(kotGroups||[]).find(x=>Number(x.id)===Number(id));
    return g ? g.name : "No KOT Group";
}

function populateKOTGroupSelect(){
    const select=document.getElementById("menuKOTGroup");
    if(!select)return;
    const current=select.value;
    select.innerHTML='<option value="">No KOT Group</option>'+(kotGroups||[]).filter(g=>g.active!==false).map(g=>`<option value="${g.id}">${esc(g.name)} — ${esc(g.station||"Kitchen")}</option>`).join("");
    if(current)select.value=String(current);
}

async function loadKOTGroups(){
    try{
        kotGroups=await api("/kot-groups");
        const c=document.getElementById("kotGroupsContainer");
        if(!c)return;
        populateKOTGroupSelect();
        if(!kotGroups.length){c.innerHTML='<div class="settings-card"><p>No KOT groups created yet.</p></div>';return;}
        c.innerHTML=kotGroups.map(g=>`<div class="settings-card"><div class="access-profile-card-head"><div><h3>${esc(g.name)}</h3><p>${esc(g.description||"")}</p></div><span class="access-status ${g.active?'active':'inactive'}">${g.active?'Active':'Inactive'}</span></div><div class="access-summary-grid"><div class="access-summary-item"><strong>Station</strong><span>${esc(g.station||"Kitchen")}</span></div><div class="access-summary-item"><strong>Sort</strong><span>${Number(g.sort_order||0)}</span></div></div><div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;"><button onclick="editKOTGroup(${g.id})">✏️ Edit</button><button onclick="deleteKOTGroup(${g.id})">🗑️ Delete</button></div></div>`).join("");
    }catch(e){const c=document.getElementById("kotGroupsContainer");if(c)c.innerHTML=`<div class="settings-card"><p>Failed to load KOT Groups: ${esc(e.message)}</p></div>`;}
}

function openKOTGroupModal(group){
    document.getElementById("kotGroupModal").style.display="flex";
    document.getElementById("kotGroupModalTitle").textContent=group?"Edit KOT Group":"Add KOT Group";
    document.getElementById("kotGroupId").value=group?.id||"";
    document.getElementById("kotGroupName").value=group?.name||"";
    document.getElementById("kotGroupDescription").value=group?.description||"";
    document.getElementById("kotGroupStation").value=group?.station||"Kitchen";
    document.getElementById("kotGroupSort").value=group?.sort_order??0;
    document.getElementById("kotGroupActive").checked=group?.active!==false;
}
function closeKOTGroupModal(){document.getElementById("kotGroupModal").style.display="none";}
function editKOTGroup(id){const g=(kotGroups||[]).find(x=>Number(x.id)===Number(id));if(g)openKOTGroupModal(g);}
async function saveKOTGroup(){
    const id=Number(document.getElementById("kotGroupId").value||0);
    const body={name:document.getElementById("kotGroupName").value.trim(),description:document.getElementById("kotGroupDescription").value.trim(),station:document.getElementById("kotGroupStation").value,sortOrder:Number(document.getElementById("kotGroupSort").value||0),active:document.getElementById("kotGroupActive").checked};
    if(!body.name)return alert("Enter a KOT group name.");
    try{await api(id?`/kot-groups/${id}`:"/kot-groups",{method:id?"PUT":"POST",body:JSON.stringify(body)});closeKOTGroupModal();await loadKOTGroups();alert(id?"KOT group updated! ✅":"KOT group created! ✅");}catch(e){alert(e.message);}
}
async function deleteKOTGroup(id){
    if(!confirm("Delete this KOT group? Existing KOT history will keep working; menu items will become unassigned."))return;
    try{await api(`/kot-groups/${id}`,{method:"DELETE"});await loadKOTGroups();await loadMenuManagement();alert("KOT group deleted. ✅");}catch(e){alert(e.message);}
}

// ==========================================
// KITCHEN / KOT
// ==========================================

let kotState={tab:"pending",range:"today",from:"",to:"",items:[]};
let kotAlertTimer=null;
let kotAlertInitialized=false;
let knownPendingKOTIds=new Set();
let kotAlertAudioContext=null;

function setKOTTab(tab){
    kotState.tab=tab;
    document.querySelectorAll(".kot-tab").forEach(b=>b.classList.remove("active"));
    document.getElementById(tab==="pending"?"kotTabPending":tab==="ready"?"kotTabReady":"kotTabCompleted")?.classList.add("active");
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
    return Boolean(appSettings.kotEnabled !== false && currentUser && hasPermission("kitchen","view") && appSettings.enableKOTSound !== false);
}

function ensureKOTAlertAudio(){
    try{
        if(!kotAlertAudioContext) kotAlertAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        if(kotAlertAudioContext.state === "suspended") kotAlertAudioContext.resume().catch(()=>{});
    }catch(e){ console.warn("KOT alert audio unavailable:",e.message); }
}

function primeKOTAlertAudio(){
    // Called from the staff login click/submit gesture so browsers allow later alert sounds.
    ensureKOTAlertAudio();
}

function playKOTAlertSound(){
    if(!canKitchenReceiveKOTAlerts()) return;
    try{
        ensureKOTAlertAudio();
        if(!kotAlertAudioContext) return;
        const now=kotAlertAudioContext.currentTime;
        [0,0.18,0.36].forEach((offset,index)=>{
            const osc=kotAlertAudioContext.createOscillator();
            const gain=kotAlertAudioContext.createGain();
            osc.type="sine";
            osc.frequency.value=index===1?920:740;
            gain.gain.setValueAtTime(0.0001,now+offset);
            gain.gain.exponentialRampToValueAtTime(0.22,now+offset+0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001,now+offset+0.14);
            osc.connect(gain);
            gain.connect(kotAlertAudioContext.destination);
            osc.start(now+offset);
            osc.stop(now+offset+0.16);
        });
    }catch(e){ console.warn("KOT alert sound failed:",e.message); }
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

function inspectNewKOTAlerts(items){
    if(!canKitchenReceiveKOTAlerts()) return;
    const pendingIds=new Set((items||[]).filter(i=>["Pending","Preparing"].includes(i.status)).map(i=>Number(i.id)));
    if(!kotAlertInitialized){
        knownPendingKOTIds=pendingIds;
        kotAlertInitialized=true;
        return;
    }
    const newCount=[...pendingIds].filter(id=>!knownPendingKOTIds.has(id)).length;
    knownPendingKOTIds=pendingIds;
    if(newCount>0){
        playKOTAlertSound();
        showKOTArrivalToast(newCount);
    }
}

async function pollKOTAlerts(){
    if(appSettings.kotEnabled === false || !currentUser || !hasPermission("kitchen","view") || appSettings.enableKOTSound === false) return;
    try{
        const items=await api("/kot?range=today");
        inspectNewKOTAlerts(items);
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

function renderKOT(){
    const items=Array.isArray(kotState.items)?kotState.items:[],groups={};
    items.forEach(item=>{
        if(!groups[item.order_id])groups[item.order_id]={orderId:item.order_id,orderNumber:item.order_number,orderType:item.order_type,tableNumber:item.table_number,status:item.status,createdAt:item.created_at,items:[]};
        groups[item.order_id].items.push(item);
        const ss=groups[item.order_id].items.map(i=>i.status);
        groups[item.order_id].status=ss.every(s=>s==="Completed")?"Completed":ss.some(s=>s==="Ready")?"Ready":ss.some(s=>s==="Preparing")?"Preparing":"Pending";
    });
    const all=Object.values(groups),pending=all.filter(o=>o.status==="Pending"||o.status==="Preparing"),ready=all.filter(o=>o.status==="Ready"),completed=all.filter(o=>o.status==="Completed");
    setText("kotCountPending",pending.length);setText("kotCountReady",ready.length);setText("kotCountCompleted",completed.length);
    const selected=kotState.tab==="pending"?pending:kotState.tab==="ready"?ready:completed,container=document.getElementById("kotContainer");
    if(!container)return;
    container.innerHTML="";
    if(!selected.length){container.innerHTML=`<div class="dashboard-box"><p>No KOTs for this tab/date range.</p></div>`;return;}
    selected.forEach(order=>{
        let next=order.status==="Pending"?"Preparing":order.status==="Preparing"?"Ready":order.status==="Ready"?"Completed":null;
        const card=document.createElement("div");
        card.className="kot-card";
        const byGroup={};
        (order.items||[]).forEach(item=>{const key=item.kot_group_id?String(item.kot_group_id):"none";if(!byGroup[key])byGroup[key]={name:item.kot_group_name||"Unassigned",station:item.kot_group_station||"Kitchen",items:[]};byGroup[key].items.push(item);});
        const groupedHtml=Object.values(byGroup).map(g=>`<div class="kot-group-block"><div class="kot-group-heading"><strong>${esc(g.name)}</strong><span>${esc(g.station)}</span></div>${g.items.map(item=>`<div class="kot-item"><span>${esc(item.item_name)}</span><strong>× ${item.quantity}</strong></div>`).join("")}</div>`).join("");
        const actions=(appSettings.kotEnabled===false)?'<span class="access-muted">KOT workflow disabled in Settings</span>':(next?`<button class="big-btn" onclick="updateKOTOrder(${order.orderId}, '${next}')">${next==="Preparing"?"👨‍🍳 Start Preparing":next==="Ready"?"✅ Mark Ready":"✅ Complete"}</button>`:`<span>✅ Completed</span>`);
        card.innerHTML=`<div class="kot-header"><strong>${esc(order.orderNumber)}</strong><span>${esc(order.orderType)}</span></div><div class="kot-table">Table: ${esc(order.tableNumber||"-")}</div><div class="kot-items">${groupedHtml}</div><div class="kot-status">Status: <strong>${esc(order.status)}</strong></div><div class="kot-actions">${actions}${appSettings.kotEnabled!==false?`<button class="big-btn" onclick="printKOT(${order.orderId})">🖨️ Print KOT</button>`:""}</div>`;
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

async function updateKOTOrder(orderId,status){
    if(appSettings.kotEnabled===false)return alert("KOT / Kitchen workflow is disabled in Settings.");
    try{
        const orderItems=(kotState.items||[]).filter(item=>Number(item.order_id)===Number(orderId));
        if(!orderItems.length)return alert("KOT not found for the selected date/filter.");
        for(const item of orderItems){
            await api(`/kot/${item.id}`,{method:"PUT",body:JSON.stringify({status})});
        }
        if(status==="Completed"){
            await api(`/orders/${orderId}/complete`,{method:"PUT"});
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

async function printKOT(orderId) {

    try {

        const items =
            await api("/kot");


        const kotItems =
            items.filter(
                function(item) {

                    return Number(
                        item.order_id
                    ) === Number(orderId);

                }
            );


        if (!kotItems.length) {

            return alert(
                "KOT not found."
            );

        }


        const first =
            kotItems[0];


        const printWindow =
            window.open(
                "",
                "_blank",
                "width=420,height=700"
            );


        if (!printWindow) {

            return alert(
                "Please allow pop-ups to print KOT."
            );

        }


        printWindow.document.write(`

            <!DOCTYPE html>

            <html>

            <head>

                <title>
                    KOT - ${esc(
                        first.order_number
                    )}
                </title>


                <style>

                    * {
                        box-sizing: border-box;
                    }


                    body {

                        font-family:
                            Arial,
                            sans-serif;

                        width: 300px;

                        margin: 0 auto;

                        padding: 15px;

                        color: #000;

                    }


                    h2 {

                        text-align: center;

                        margin: 0;

                        font-size: 22px;

                    }


                    .subtitle {

                        text-align: center;

                        font-size: 14px;

                        font-weight: bold;

                        margin-top: 4px;

                    }


                    .line {

                        border-top:
                            1px dashed #000;

                        margin: 10px 0;

                    }


                    .row {

                        display: flex;

                        justify-content:
                            space-between;

                        margin: 6px 0;

                        font-size: 14px;

                    }


                    .item-header {

                        display: flex;

                        justify-content:
                            space-between;

                        font-weight: bold;

                        font-size: 14px;

                        margin-bottom: 8px;

                    }


                    .item {

                        display: flex;

                        justify-content:
                            space-between;

                        font-size: 17px;

                        font-weight: bold;

                        margin: 10px 0;

                    }


                    .item-name {

                        max-width: 220px;

                    }


                    .qty {

                        font-size: 18px;

                    }


                    .footer {

                        text-align: center;

                        font-weight: bold;

                        margin-top: 15px;

                        font-size: 14px;

                    }


                    .kot-number {

                        text-align: center;

                        font-size: 18px;

                        font-weight: bold;

                        margin-top: 8px;

                    }


                    @media print {

                        body {

                            width: 300px;

                            margin: 0;

                        }

                    }

                </style>

            </head>


            <body>

                <h2>
                    ☕ CAFE POS
                </h2>


                <div class="subtitle">
                    KITCHEN ORDER TICKET
                </div>


                <div class="kot-number">

                    KOT #${first.id}

                </div>


                <div class="line"></div>


                <div class="row">

                    <span>
                        Order
                    </span>

                    <strong>
                        ${esc(
                            first.order_number
                        )}
                    </strong>

                </div>


                <div class="row">

                    <span>
                        Order Type
                    </span>

                    <strong>
                        ${esc(
                            first.order_type
                        )}
                    </strong>

                </div>


                <div class="row">

                    <span>
                        Table
                    </span>

                    <strong>
                        ${esc(
                            first.table_number || "-"
                        )}
                    </strong>

                </div>


                <div class="row">

                    <span>
                        Time
                    </span>

                    <strong>
                        ${new Date(
                            first.created_at
                        ).toLocaleString()}
                    </strong>

                </div>


                <div class="line"></div>


                <div class="item-header">

                    <span>
                        ITEM
                    </span>

                    <span>
                        QTY
                    </span>

                </div>


                ${
                    kotItems
                        .map(function(item) {

                            return `

                                <div class="item">

                                    <span class="item-name">

                                        ${esc(
                                            item.item_name
                                        )}

                                    </span>


                                    <span class="qty">

                                        ×
                                        ${item.quantity}

                                    </span>

                                </div>

                            `;

                        })
                        .join("")
                }


                <div class="line"></div>


                <div class="row">

                    <span>
                        Status
                    </span>

                    <strong>
                        ${esc(
                            first.status
                        )}
                    </strong>

                </div>


                <div class="footer">
                    KITCHEN COPY
                </div>


                <script>

                    window.onload = function() {

                        window.print();

                    };

                <\/script>


            </body>

            </html>

        `);


        printWindow.document.close();


    } catch (error) {

        console.error(
            "Print KOT failed:",
            error
        );


        alert(
            "Unable to print KOT: " +
            error.message
        );

    }

}


// ==========================================
// MENU MANAGEMENT
// ==========================================

async function loadMenuManagement(){
    try{currentMenu=await api('/menu');try{kotGroups=await api('/kot-groups');}catch(_){kotGroups=kotGroups||[];}populateKOTGroupSelect();const list=document.querySelector('#menu .menu-list');if(!list)return;list.innerHTML=`<div class="menu-modern-head"><div><strong>${currentMenu.length}</strong><span>menu items</span></div><div class="menu-modern-actions"><input id="menuManagementSearch" type="search" placeholder="Search item, category, variant…" oninput="filterMenuManagement()"><select id="menuManagementNature" onchange="filterMenuManagement()"><option value="">All types</option><option>Goods</option><option>Service</option></select></div></div><div id="menuManagementGrid" class="menu-management-grid"></div>`;renderMenuManagementCards();}catch(e){console.error('Menu management failed:',e);}
}
function renderMenuManagementCards(){const grid=document.getElementById('menuManagementGrid');if(!grid)return;const q=String(document.getElementById('menuManagementSearch')?.value||'').toLowerCase();const nature=String(document.getElementById('menuManagementNature')?.value||'');const items=currentMenu.filter(item=>{const hay=`${item.name} ${item.category} ${item.nature} ${item.kot_group_name||''} ${(item.variants||[]).map(v=>v.name).join(' ')}`.toLowerCase();return(!q||hay.includes(q))&&(!nature||item.nature===nature);});grid.innerHTML=items.length?items.map(item=>{const ch=item.channel_prices||{};const vs=item.variants||[];return `<article class="menu-admin-card ${item.available?'':'disabled'}"><div class="menu-admin-top"><div class="menu-admin-icon">${menuIcon(item.category)}</div><div><h3>${esc(item.name)}</h3><p>${esc(item.category)} · ${esc(item.nature||'Goods')} · ${esc(item.unit||'ea')}</p></div><span class="menu-availability ${item.available?'active':'inactive'}">${item.available?'Active':'Disabled'}</span></div><div class="menu-admin-price-row"><div><small>Base</small><strong>${money(item.price)}</strong></div><div><small>Tax</small><strong>${esc(menuTaxLabel(item))} · ${esc(item.tax_mode||'exclusive')}</strong></div><div><small>KOT</small><strong>${esc(item.kot_group_name||'Not routed')}</strong></div></div><div class="menu-channel-chips"><span>Dine-in ${money(ch.dine_in??item.price)}</span><span>Takeaway ${money(ch.takeaway??item.price)}</span><span>Delivery ${money(ch.delivery??item.price)}</span><span>Online ${money(ch.online??item.price)}</span></div>${vs.length?`<div class="menu-variant-list"><strong>Variants</strong>${vs.map(v=>`<span>${esc(v.name)} · ${money(resolveMenuPrice(item,v))}</span>`).join('')}</div>`:''}<div class="menu-admin-actions"><button class="table-action-btn" onclick="editMenuItem(${item.id})">✏️ Edit</button>${item.available?`<button class="table-action-btn" onclick="disableMenuItem(${item.id})">🗑️ Disable</button>`:`<button class="table-action-btn" onclick="enableMenuItem(${item.id})">♻️ Enable</button>`}</div></article>`;}).join(''):'<div class="menu-empty-state">No matching menu items.</div>';}
function filterMenuManagement(){renderMenuManagementCards();}
function openAddMenuModal(item=null){editingMenuItemId=item?.id||null;populateKOTGroupSelect();populateMenuCategorySelect(item?.category||'');document.getElementById('addMenuModalTitle').textContent=editingMenuItemId?'Edit Menu Item':'Add Menu Item';document.getElementById('menuName').value=item?.name||'';document.getElementById('menuPrice').value=item?.price??'';document.getElementById('menuCategory').value=item?.category||'';document.getElementById('menuNature').value=item?.nature||'Goods';document.getElementById('menuUnit').value=item?.unit||'ea';document.getElementById('menuTaxProfile').value=Number(item?.tax_rate||5)===0?'0':Number(item?.tax_rate||5)===18?'18':Number(item?.tax_rate||5)===28?'28':'5';document.getElementById('menuTaxMode').value=item?.tax_mode||'exclusive';document.getElementById('menuKOTGroup').value=item?.kot_group_id?String(item.kot_group_id):'';const cp=item?.channel_prices||{};for(const k of ['dine_in','takeaway','delivery','online'])document.getElementById('menuPrice_'+k).value=cp[k]??item?.price??'';renderMenuVariantsEditor(item?.variants||[]);document.getElementById('addMenuModal').style.display='flex';}
function closeAddMenuModal(){document.getElementById('addMenuModal').style.display='none';editingMenuItemId=null;}
function menuVariantEditorRow(v={}){return `<div class="variant-editor-row"><input class="variant-name" placeholder="Variant (Small / Large)" value="${esc(v.name||'')}"><input class="variant-sku" placeholder="SKU" value="${esc(v.sku||'')}"><input class="variant-price" type="number" min="0" step="0.01" placeholder="Price" value="${v.price??''}"><select class="variant-unit"><option value="ea" ${v.unit==='ea'?'selected':''}>ea</option><option value="g" ${v.unit==='g'?'selected':''}>g</option><option value="kg" ${v.unit==='kg'?'selected':''}>kg</option><option value="ml" ${v.unit==='ml'?'selected':''}>ml</option><option value="lt" ${v.unit==='lt'?'selected':''}>lt</option></select><button type="button" class="cancel-btn" onclick="this.parentElement.remove()">✕</button></div>`;}
function renderMenuVariantsEditor(vs){const wrap=document.getElementById('menuVariantsEditor');if(wrap)wrap.innerHTML=(vs||[]).map(menuVariantEditorRow).join('');}
function addMenuVariantRow(){document.getElementById('menuVariantsEditor')?.insertAdjacentHTML('beforeend',menuVariantEditorRow({}));}
async function addMenuItem(){const name=document.getElementById('menuName').value.trim(),price=Number(document.getElementById('menuPrice').value),category=document.getElementById('menuCategory').value.trim();if(!name||!Number.isFinite(price)||price<0||!category)return alert('Enter valid menu details.');const taxMap={0:{rate:0,cgst:0,sgst:0,igst:0,label:'Tax 0%'},5:{rate:5,cgst:2.5,sgst:2.5,igst:5,label:'GST 5%'},18:{rate:18,cgst:9,sgst:9,igst:18,label:'GST 18%'},28:{rate:28,cgst:14,sgst:14,igst:28,label:'GST 28%'}};const t=taxMap[document.getElementById('menuTaxProfile').value]||taxMap[5];const channelPrices={};for(const k of ['dine_in','takeaway','delivery','online']){const raw=String(document.getElementById('menuPrice_'+k)?.value||'').trim();if(raw!==''){const n=Number(raw);if(Number.isFinite(n)&&n>=0)channelPrices[k]=n;}}const variants=[...document.querySelectorAll('#menuVariantsEditor .variant-editor-row')].map(r=>({name:r.querySelector('.variant-name')?.value.trim(),sku:r.querySelector('.variant-sku')?.value.trim(),price:Number(r.querySelector('.variant-price')?.value),unit:r.querySelector('.variant-unit')?.value||'ea'})).filter(v=>v.name&&Number.isFinite(v.price)&&v.price>=0);const existingMenu=editingMenuItemId?currentMenu.find(x=>Number(x.id)===Number(editingMenuItemId)):null;const payload={name,price,category,nature:document.getElementById('menuNature').value,unit:document.getElementById('menuUnit').value,taxRate:t.rate,cgstRate:t.cgst,sgstRate:t.sgst,igstRate:t.igst,taxLabel:t.label,taxMode:document.getElementById('menuTaxMode').value,kotGroupId:Number(document.getElementById('menuKOTGroup').value||0)||null,channelPrices,variants,available:existingMenu?existingMenu.available!==false:true};try{await api(editingMenuItemId?`/menu/${editingMenuItemId}`:'/menu',{method:editingMenuItemId?'PUT':'POST',body:JSON.stringify(payload)});closeAddMenuModal();await loadMenuManagement();await loadMenu();alert(editingMenuItemId?'Menu item updated! ✅':'Menu item added! 🍔');}catch(e){alert(e.message);}}
async function editMenuItem(id){const item=currentMenu.find(x=>Number(x.id)===Number(id));if(item)openAddMenuModal(item);}
async function disableMenuItem(id){if(!confirm('Disable this menu item?'))return;try{await api(`/menu/${id}`,{method:'DELETE'});await loadMenuManagement();await loadMenu();}catch(e){alert(e.message);}}
async function enableMenuItem(id){try{await api(`/menu/${id}/enable`,{method:'PUT'});await loadMenuManagement();await loadMenu();}catch(e){alert(e.message);}}

let menuImportRows = [];

function openMenuImportModal() {
    menuImportRows = [];
    const file = document.getElementById("menuImportFile");
    if (file) file.value = "";
    document.getElementById("menuImportFileName").textContent = "No file selected";
    document.getElementById("menuImportStatus").textContent = "Required columns: Item Name, Category, Price. Optional columns support channel prices, tax, unit, availability and KOT group.";
    document.getElementById("menuImportPreview").innerHTML = "";
    document.getElementById("menuImportSubmit").disabled = true;
    document.getElementById("menuImportModal").style.display = "flex";
}

function closeMenuImportModal() {
    document.getElementById("menuImportModal").style.display = "none";
}

function downloadMenuImportTemplate() {
    const headers = ["Item Name", "Category", "Price", "Dine-in Price", "Takeaway Price", "Delivery Price", "Online Price", "Available", "Nature", "Unit", "Tax Rate", "Tax Mode", "KOT Group"];
    const example = ["Masala Chai", "Hot Drinks", "80", "80", "85", "90", "90", "TRUE", "Goods", "cup", "5", "exclusive", "Main Kitchen"];
    const csv = "\uFEFF" + [headers, example].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "cafe-pos-menu-template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
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
        category: findColumn("Category", "Menu Category"),
        price: findColumn("Price", "Base Price", "Selling Price"),
        dine_in: findColumn("Dine-in Price", "Dine In Price"),
        takeaway: findColumn("Takeaway Price", "Take Away Price"),
        delivery: findColumn("Delivery Price"),
        online: findColumn("Online Price"),
        available: findColumn("Available", "Availability", "Active"),
        nature: findColumn("Nature", "Item Nature"),
        unit: findColumn("Unit", "UOM"),
        taxRate: findColumn("Tax Rate", "GST Rate", "Tax"),
        taxMode: findColumn("Tax Mode"),
        kotGroup: findColumn("KOT Group", "Kitchen Station")
    };
    if (columns.name < 0 || columns.category < 0 || columns.price < 0) throw new Error("The sheet must include Item Name, Category and Price columns.");
    const valueAt = (row, column) => column < 0 ? "" : String(row[column] ?? "").trim();
    const optionalNumber = (row, column) => {
        const raw = valueAt(row, column);
        return raw === "" ? null : Number(raw);
    };
    return matrix.slice(1).map((row, index) => {
        const name = valueAt(row, columns.name);
        const category = valueAt(row, columns.category);
        const price = optionalNumber(row, columns.price);
        const reason = !name ? "Item name is missing." : !category ? "Category is missing." : !Number.isFinite(price) || price < 0 ? "Price must be a non-negative number." : "";
        const channelPrices = {};
        for (const key of ["dine_in", "takeaway", "delivery", "online"]) {
            const amount = optionalNumber(row, columns[key]);
            if (amount !== null && Number.isFinite(amount) && amount >= 0) channelPrices[key] = amount;
        }
        const rawTax = optionalNumber(row, columns.taxRate);
        const rawAvailable = valueAt(row, columns.available).toLocaleLowerCase();
        return {
            rowNumber: index + 2, name, category, price,
            channelPrices,
            available: !["false", "no", "0", "inactive", "disabled"].includes(rawAvailable),
            nature: ["goods", "service"].includes(valueAt(row, columns.nature).toLocaleLowerCase()) ? valueAt(row, columns.nature)[0].toUpperCase() + valueAt(row, columns.nature).slice(1).toLowerCase() : "Goods",
            unit: valueAt(row, columns.unit) || "ea",
            taxRate: rawTax === null ? 5 : Number.isFinite(rawTax) && rawTax >= 0 && rawTax <= 100 ? rawTax : 5,
            taxMode: valueAt(row, columns.taxMode).toLocaleLowerCase() === "inclusive" ? "inclusive" : "exclusive",
            kotGroup: valueAt(row, columns.kotGroup),
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
        status.textContent = `${menuImportRows.length} item row${menuImportRows.length === 1 ? "" : "s"} found · ${valid.length} ready${invalid ? ` · ${invalid} with errors` : ""}${limited ? " · Split this file into batches of 500 or fewer" : ""}. Existing item names will be skipped.`;
        const sample = menuImportRows.slice(0, 8);
        preview.innerHTML = sample.length ? `<div class="table-container"><table><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Check</th></tr></thead><tbody>${sample.map(row => `<tr><td>${esc(row.name || "-")}</td><td>${esc(row.category || "-")}</td><td>${Number.isFinite(row.price) ? money(row.price) : "-"}</td><td>${row.error ? `<span class="menu-import-error">${esc(row.error)}</span>` : "Ready"}</td></tr>`).join("")}</tbody></table></div>${menuImportRows.length > sample.length ? `<small>Showing 8 of ${menuImportRows.length} rows.</small>` : ""}` : '<p class="access-muted">No menu rows found.</p>';
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
        const result = await api("/menu/import", { method: "POST", body: JSON.stringify({ items: valid }) });
        const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
        status.textContent = `${result.imported} items imported · ${result.categoriesCreated} new categor${result.categoriesCreated === 1 ? "y" : "ies"}${result.skipped?.length ? ` · ${result.skipped.length} duplicate/invalid rows skipped` : ""}${warnings ? ` · ${warnings} KOT station warning${warnings === 1 ? "" : "s"}` : ""}.`;
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
    { key: "invoice_designer", label: "Invoice Designer" },
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
    const users = tab === "users";
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
            <td><span class="access-status ${user.active ? "active" : "inactive"}">${user.active ? "Active" : "Inactive"}</span></td>
            <td>${user.created_at ? new Date(user.created_at).toLocaleString() : "-"}</td>
            <td>
                <button onclick="editAccessUser(${user.id})">✏️ Edit</button>
                <button onclick="toggleAccessUser(${user.id}, ${user.active ? "false" : "true"})">${user.active ? "⏸️ Disable" : "▶️ Enable"}</button>
                ${user.username !== "admin" ? `<button onclick="deleteAccessUser(${user.id})">🗑️ Delete</button>` : ""}
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
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
                <button onclick="editAccessProfile(${profile.id})">✏️ Edit</button>
                ${profile.name !== "Admin" ? `<button onclick="deleteAccessProfile(${profile.id})">🗑️ Delete</button>` : ""}
            </div>
        `;
        container.appendChild(card);
    });
}

function populateAccessProfileSelect(selectedId) {
    const select = document.getElementById("accessUserProfile");
    if (!select) return;
    select.innerHTML = '<option value="">-- No profile --</option>' + accessProfiles.map(function(profile) {
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
}

function readAccessPermissionEditor() {
    const permissions = defaultAccessPermissions();
    document.querySelectorAll("#accessPermissionsEditor input[data-permission-key]").forEach(function(input) {
        permissions[input.dataset.permissionKey] = input.checked;
    });
    return permissions;
}

function openAccessProfileModal(profile) {
    editingAccessProfileId = profile?.id || null;
    document.getElementById("accessProfileModalTitle").textContent = editingAccessProfileId ? "Edit Access Profile" : "Add Access Profile";
    document.getElementById("accessProfileId").value = editingAccessProfileId || "";
    document.getElementById("accessProfileName").value = profile?.name || "";
    document.getElementById("accessProfileDescription").value = profile?.description || "";
    buildAccessPermissionEditor(profile?.permissions || defaultAccessPermissions());
    document.getElementById("accessProfileModal").style.display = "flex";
}

function closeAccessProfileModal() {
    const modal = document.getElementById("accessProfileModal");
    if (modal) modal.style.display = "none";
    editingAccessProfileId = null;
}

async function saveAccessProfile() {
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
    if (profile) openAccessProfileModal(profile);
}

async function deleteAccessProfile(id) {
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
        applies_to: item.applies_to === "dine_in" ? "dine-in" : (item.applies_to || "all")
    }));
}

function renderBillingAdjustmentSelectors() {
    const discount = document.getElementById("billingDiscountSelect");
    const charge = document.getElementById("billingChargeSelect");
    const channel = orderType === "Dine-in" ? "dine-in" : orderType === "Takeaway" ? "takeaway" : String(orderType || "").toLowerCase();

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


async function editOpenOrder(orderId) {
    try {
        const data = await api(`/orders/${orderId}`);
        if (String(data.order?.status || "").toLowerCase() !== "open") {
            return alert("Only Open orders can be edited.");
        }
        currentOpenOrderId = orderId;
        currentOpenOrderData = data;
        cart = (data.items || []).map(item => ({
            id: item.menu_id || ("order-item-" + item.id),
            variantId: item.variant_id || null,
            cartKey: item.variant_id ? `${item.menu_id}:${item.variant_id}` : String(item.menu_id || item.id),
            name: item.item_name,
            price: Number(item.price),
            quantity: Number(item.quantity),
            unit: item.unit || "ea",
            taxRate: Number(item.tax_rate ?? 5),
            taxMode: item.tax_mode === "inclusive" ? "inclusive" : "exclusive"
        }));
        orderType = data.order.order_type || "Dine-in";
        setOrderType(orderType);
        const table = document.getElementById("tableNumber");
        if (table) table.value = data.order.table_number || "";
        const ds=document.getElementById("billingDiscountSelect");
        const cs=document.getElementById("billingChargeSelect");
        if(ds) ds.value=data.order.discount_adjustment_id ? String(data.order.discount_adjustment_id) : "";
        if(cs) cs.value=data.order.charge_adjustment_id ? String(data.order.charge_adjustment_id) : "";
        const n=document.getElementById("billingCustomerNameQuick"); if(n)n.value=data.order.customer_name||"";
        const p=document.getElementById("billingCustomerPhoneQuick"); if(p)p.value=data.order.customer_phone||"";
        const note=document.getElementById("billingOrderNotes"); if(note)note.value=data.order.notes||"";
        updateCart();
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
    document.getElementById("billingAdjustmentApplies").value=item?.applies_to||"all";
    document.getElementById("billingAdjustmentDescription").value=item?.description||"";
    document.getElementById("billingAdjustmentModal").style.display="flex";
}

async function saveBillingAdjustment(){
    const id=document.getElementById("billingAdjustmentEditingId")?.value;
    const payload={
        name:document.getElementById("billingAdjustmentName")?.value.trim(),
        type:document.getElementById("billingAdjustmentKind")?.value,
        valueType:document.getElementById("billingAdjustmentCalculation")?.value==="percent"?"percent":"amount",
        value:Number(document.getElementById("billingAdjustmentValue")?.value||0),
        appliesTo:(document.getElementById("billingAdjustmentApplies")?.value||"all")==="dine-in"?"dine_in":(document.getElementById("billingAdjustmentApplies")?.value||"all"),
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
            <td>${esc(x.applies_to||"all")}</td>
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

let marketingDeals = [];
let editingMarketingDealId = null;
const MARKETING_DEAL_TYPES = ["Discount", "Buy X", "Buy X Get X", "Buy X Get Y", "Voucher", "Payment Deals", "Meal Deals", "Slab-Based Discount"];

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
        const offer = deal.type && deal.type.startsWith("Buy") ? `Buy ${Number(deal.buyQuantity || 1)} · Get ${Number(deal.getQuantity || 1)}` : deal.value ? `${deal.valueType === "percentage" ? `${deal.value}% off` : money(deal.value)}` : "Custom offer";
        const channels = (deal.channels || []).map(key => POS_CHANNELS.find(channel => channel.key === key)?.label).filter(Boolean).join(", ") || "All channels";
        return `<article class="marketing-deal-card ${deal.active === false ? "inactive" : ""}"><div class="marketing-deal-card-top"><span class="marketing-deal-type">${esc(deal.type || "Deal")}</span><span class="marketing-deal-status">${deal.active === false ? "Inactive" : "Active"}</span></div><h3>${esc(deal.name || "Untitled deal")}</h3><p>${esc(deal.category || "All categories")}${deal.itemName ? ` · ${esc(deal.itemName)}` : ""}</p><div class="marketing-deal-offer">${esc(offer)}</div><div class="marketing-deal-meta"><span>📅 ${esc(schedule)}</span><span>🛒 ${esc(channels)}</span></div><div class="marketing-deal-actions"><button type="button" onclick="openMarketingDealForm('${esc(deal.id)}')">Edit</button><button type="button" onclick="toggleMarketingDeal('${esc(deal.id)}')">${deal.active === false ? "Enable" : "Disable"}</button><button type="button" onclick="deleteMarketingDeal('${esc(deal.id)}')">Delete</button></div></article>`;
    }).join("");
}
function populateMarketingDealOptions(selected = {}) {
    const categories = [...new Set(currentMenu.map(item => String(item.category || "").trim()).filter(Boolean))].sort();
    const categorySelect = document.getElementById("marketingDealCategory");
    if (categorySelect) categorySelect.innerHTML = '<option value="">All categories</option>' + categories.map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join("");
    const items = currentMenu.filter(item => !selected.category || item.category === selected.category);
    const itemMarkup = '<option value="">All items</option>' + items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
    const itemSelect = document.getElementById("marketingDealItem");
    const rewardSelect = document.getElementById("marketingRewardItem");
    if (itemSelect) itemSelect.innerHTML = itemMarkup;
    if (rewardSelect) rewardSelect.innerHTML = '<option value="">Same item</option>' + currentMenu.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
    if (categorySelect) categorySelect.value = selected.category || "";
    if (itemSelect) itemSelect.value = selected.itemId || "";
    if (rewardSelect) rewardSelect.value = selected.rewardItemId || "";
}
function openMarketingDealForm(id = null) {
    editingMarketingDealId = id;
    const deal = id === null ? null : marketingDeals.find(item => String(item.id) === String(id));
    document.getElementById("marketingDealModalTitle").textContent = deal ? "Edit Deal" : "Create Deal";
    document.getElementById("marketingDealName").value = deal?.name || "";
    document.getElementById("marketingDealType").value = deal?.type || "Discount";
    populateMarketingDealOptions(deal || {});
    document.getElementById("marketingBuyQuantity").value = deal?.buyQuantity || 1;
    document.getElementById("marketingGetQuantity").value = deal?.getQuantity || 1;
    document.getElementById("marketingValueType").value = deal?.valueType || "amount";
    document.getElementById("marketingDealValue").value = deal?.value ?? "";
    document.getElementById("marketingDealStart").value = deal?.startDate || "";
    document.getElementById("marketingDealEnd").value = deal?.endDate || "";
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
    const prior = editingMarketingDealId === null ? null : marketingDeals.find(item => String(item.id) === String(editingMarketingDealId));
    const deal = {
        id: prior?.id || String(Date.now()), name, type,
        category: document.getElementById("marketingDealCategory").value,
        itemId: document.getElementById("marketingDealItem").value || null,
        itemName: currentMenu.find(item => String(item.id) === document.getElementById("marketingDealItem").value)?.name || "",
        buyQuantity: Math.max(1, Number(document.getElementById("marketingBuyQuantity").value || 1)),
        getQuantity: Math.max(1, Number(document.getElementById("marketingGetQuantity").value || 1)),
        rewardItemId: document.getElementById("marketingRewardItem").value || null,
        valueType: document.getElementById("marketingValueType").value,
        value: Math.max(0, Number(document.getElementById("marketingDealValue").value || 0)),
        startDate: document.getElementById("marketingDealStart").value || null,
        endDate: document.getElementById("marketingDealEnd").value || null,
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
            if (String(active.status).toLowerCase() === "open") {
                await editOpenOrder(active.id);
                return;
            }
            await viewOrder(active.id);
            return;
        } catch (error) {
            return alert("Unable to open the table order: " + error.message);
        }
    }

    selectedPOSChannelKey = "dine_in";
    setOrderType("Dine-in", true);
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
function updatePOSDefaultOptions(moduleKey) {
    const selected = [...document.querySelectorAll("[data-pos-module=\"" + moduleKey + "\"]:checked")].map(input => input.dataset.posChannel);
    if (moduleKey === "newOrder" && !selected.some(key => POS_CHANNELS.find(channel => channel.key === key)?.orderType === "Takeaway")) {
        const fallback = document.getElementById("posChannel_newOrder_takeaway");
        if (fallback) fallback.checked = true;
        if (!selected.includes("takeaway")) selected.push("takeaway");
    }
    if (!selected.length) {
        const fallback = moduleKey === "tableView" ? "dine_in" : "takeaway";
        const input = document.getElementById("posChannel_" + moduleKey + "_" + fallback) || document.getElementById("posChannel_" + moduleKey + "_dine_in");
        if (input) input.checked = true;
        selected.push(input?.dataset.posChannel || "dine_in");
    }
    const select = document.getElementById("posDefault_" + moduleKey);
    if (!select) return;
    const prior = select.value;
    select.innerHTML = selected.map(key => {
        const channel = POS_CHANNELS.find(entry => entry.key === key);
        return channel ? "<option value=\"" + esc(key) + "\">" + esc(channel.label) + "</option>" : "";
    }).join("");
    select.value = selected.includes(prior) ? prior : selected[0];
}
function readPOSPreferencesFromForm() {
    const result = {};
    ["newOrder", "tableView"].forEach(moduleKey => {
        const channels = [...document.querySelectorAll("[data-pos-module=\"" + moduleKey + "\"]:checked")].map(input => input.dataset.posChannel);
        const fallback = moduleKey === "tableView" ? "dine_in" : "takeaway";
        const selectedChannels = channels.length ? channels : [fallback];
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
        if (local && typeof local === "object") appSettings = { ...appSettings, ...local };
    } catch (_) {}

    try {
        const saved = await api("/settings");
        if (saved && typeof saved === "object") appSettings = { ...appSettings, ...saved };
    } catch (error) {
        console.warn("Settings API unavailable:", error.message);
    }

    appSettings.paymentModes = normalizePaymentModes(appSettings.paymentModes);
    appSettings.defaultPayment = preferredPaymentMethod();

    setSettingValue("settingRestaurantName", appSettings.restaurantName);
    setSettingValue("settingAddress", appSettings.address);
    setSettingValue("settingPhone", appSettings.phone);
    setSettingValue("settingGstin", appSettings.gstin);
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
    setSettingValue("settingAllowZeroAmount", appSettings.allowZeroAmount); setSettingValue("settingRoundTotals", appSettings.roundTotals);
    setSettingValue("settingLogoUrl", appSettings.logoUrl); setSettingValue("settingUpiId", appSettings.upiId); setSettingValue("settingReceiptFont", appSettings.receiptFont);
    setSettingValue("settingPrintKitchenOnOrder", appSettings.printKitchenOnOrder); setSettingValue("settingEnableReceiptSound", appSettings.enableReceiptSound);
    setSettingValue("settingOpeningTime", appSettings.openingTime); setSettingValue("settingClosingTime", appSettings.closingTime); setSettingValue("settingDefaultOrderType", appSettings.defaultOrderType);
    setSettingValue("settingAllowOrderNotes", appSettings.allowOrderNotes); setSettingValue("settingShowItemNotes", appSettings.showItemNotes);
    setSettingValue("settingLowStockThreshold", appSettings.lowStockThreshold); setSettingValue("settingCustomerMessage", appSettings.customerMessage);
    setSettingValue("settingEnableNotifications", appSettings.enableNotifications); setSettingValue("settingEnableKOTSound", appSettings.enableKOTSound); setSettingValue("settingKOTAlertInterval", appSettings.kotAlertInterval);
    setSettingValue("settingSessionTimeout", appSettings.sessionTimeout);
    setSettingValue("settingAuditLog", appSettings.auditLog);
    setSettingValue("settingUiDensity", appSettings.uiDensity); setSettingValue("settingAccentLabel", appSettings.accentLabel); setSettingValue("settingLargeBilling", appSettings.largeBilling);
    setSettingValue("settingKOTEnabled", appSettings.kotEnabled !== false); setSettingValue("settingKOTDisabledBehavior", appSettings.kotDisabledBehavior || "hide");
    renderPaymentModeManager();
    renderPOSPreferences();
    renderBillingSaleChannelOptions();
    applyPermissionsToUI();
}

async function saveSettings() {
    const next = {
        restaurantName: readSettingValue("settingRestaurantName") || "CAFE POS",
        address: readSettingValue("settingAddress") || "",
        phone: readSettingValue("settingPhone") || "",
        gstin: readSettingValue("settingGstin") || "",
        header: readSettingValue("settingHeader") || "",
        footer: readSettingValue("settingFooter") || "Thank You!\nVisit Again 😊",
        showInvoice: readSettingValue("settingShowInvoice"),
        showCustomer: readSettingValue("settingShowCustomer"),
        showCustomerPhone: readSettingValue("settingShowCustomerPhone"),
        showOrder: readSettingValue("settingShowOrder"),
        showOrderType: readSettingValue("settingShowOrderType"),
        showTable: readSettingValue("settingShowTable"),
        showTimestamp: readSettingValue("settingShowTimestamp"),
        showGST: readSettingValue("settingShowGST"),
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
        allowZeroAmount: readSettingValue("settingAllowZeroAmount"), roundTotals: readSettingValue("settingRoundTotals"),
        logoUrl: readSettingValue("settingLogoUrl") || "", upiId: readSettingValue("settingUpiId") || "", receiptFont: readSettingValue("settingReceiptFont") || "Arial",
        printKitchenOnOrder: readSettingValue("settingPrintKitchenOnOrder"), enableReceiptSound: readSettingValue("settingEnableReceiptSound"),
        openingTime: readSettingValue("settingOpeningTime") || "09:00", closingTime: readSettingValue("settingClosingTime") || "23:00", defaultOrderType: readSettingValue("settingDefaultOrderType") || "Takeaway",
        allowOrderNotes: readSettingValue("settingAllowOrderNotes"), showItemNotes: readSettingValue("settingShowItemNotes"), lowStockThreshold: Number(readSettingValue("settingLowStockThreshold")) || 0,
        customerMessage: readSettingValue("settingCustomerMessage") || "Thank you for visiting!", enableNotifications: readSettingValue("settingEnableNotifications"), enableKOTSound: readSettingValue("settingEnableKOTSound"), kotAlertInterval: Math.min(60, Math.max(3, Number(readSettingValue("settingKOTAlertInterval")) || 5)),
        sessionTimeout: Number(readSettingValue("settingSessionTimeout")) || 12, auditLog: readSettingValue("settingAuditLog"),
        uiDensity: readSettingValue("settingUiDensity") || "comfortable", accentLabel: readSettingValue("settingAccentLabel") || "", largeBilling: readSettingValue("settingLargeBilling"),
        kotEnabled: readSettingValue("settingKOTEnabled"), kotDisabledBehavior: readSettingValue("settingKOTDisabledBehavior") || "hide", posChannelPreferences: readPOSPreferencesFromForm()
    };

    appSettings = { ...appSettings, ...next };
    localStorage.setItem(settingsLocalStorageKey(), JSON.stringify(appSettings));
    localStorage.setItem("cafeThermalPaperWidth", appSettings.paperWidth);

    try {
        await api("/settings", { method: "PUT", body: JSON.stringify(appSettings) });
        alert("Settings saved successfully! ✅");
    } catch (error) {
        alert("Settings saved locally. Server could not be reached.");
    }
}

function resetSettings() {
    if (!confirm("Reset all settings to defaults?")) return;
    appSettings = {
        restaurantName: "CAFE POS", address: "", phone: "", gstin: "",
        header: "Cafe Management System", footer: "Thank You!\nVisit Again 😊",
        showInvoice: true, showCustomer: true, showCustomerPhone: true,
        showOrder: true, showOrderType: true, showTable: true, showTimestamp: true,
        showGST: true, showPayment: true, showQR: true, uppercaseItems: false, wrapItems: true,
        paperWidth: "80", autoPrint: false, autoClose: true, currency: "₹", gstRate: 5,
        defaultPayment: STARTER_PAYMENT_MODES[0].name, paymentModes: normalizePaymentModes(STARTER_PAYMENT_MODES), orderPrefix: "ORD-", invoicePrefix: "INV-",
        allowZeroAmount: false, roundTotals: false, logoUrl: "", upiId: "", receiptFont: "Arial",
        printKitchenOnOrder: false, enableReceiptSound: false, openingTime: "09:00", closingTime: "23:00",
        defaultOrderType: "Takeaway", allowOrderNotes: true, showItemNotes: true, lowStockThreshold: 5,
        customerMessage: "Thank you for visiting!", enableNotifications: true, enableKOTSound: true, kotAlertInterval: 5,
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

        currentCustomers =
            await api("/customers");


        const tbody =
            document.getElementById(
                "customersTableBody"
            );


        if (!tbody) {

            return;

        }


        tbody.innerHTML = "";


        currentCustomers.forEach(
            function(customer) {

                const tr =
                    document.createElement(
                        "tr"
                    );


                tr.innerHTML = `

                    <td>
                        ${customer.id}
                    </td>

                    <td>
                        ${esc(customer.name)}
                    </td>

                    <td>
                        ${esc(customer.phone)}
                    </td>

                    <td>
                        ${esc(
                            customer.email || "-"
                        )}
                    </td>

                    <td>
                        ${new Date(
                            customer.created_at
                        ).toLocaleString()}
                    </td>

                    <td>

                        <button
                            onclick="editCustomer(${customer.id})"
                        >
                            ✏️ Edit
                        </button>

                        <button
                            onclick="deleteCustomer(${customer.id})"
                        >
                            🗑️ Delete
                        </button>

                    </td>

                `;


                tbody.appendChild(tr);

            }
        );


    } catch (error) {

        console.error(
            "Customers failed:",
            error
        );

    }

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


    if (form) {

        form.style.display =
            form.style.display === "none"
                ? "block"
                : "none";

    }

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


        document.getElementById(
            "customerForm"
        ).style.display =
            "none";


        await loadCustomers();

        await updateDashboard();


        alert(
            "Customer added! 🎉"
        );


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
                        ${new Date(
                            payment.created_at
                        ).toLocaleString()}
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



window.exportCompleteReportCSV = function() {

    console.log("📊 Complete report export started.");

    function csvEscape(value) {
        return '"' +
            String(value ?? "")
                .replace(/"/g, '""') +
            '"';
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
                        return cell.innerText.trim();
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

    csv += csvEscape("CAFE POS COMPLETE REPORT") + "\r\n";
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
function openExpenseModal(){renderPaymentModeOptions();const m=document.getElementById('expenseModal');if(m)m.style.display='flex';const d=document.getElementById('expenseDate');if(d&&!d.value)d.value=new Date().toISOString().slice(0,10);loadExpenseCategories();}
function closeExpenseModal(){document.getElementById('expenseModal')?.style.setProperty('display','none');}
async function loadExpenseCategories(){try{const cats=await api('/expenses/categories');const s=document.getElementById('expenseCategory');if(s)s.innerHTML=cats.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');}catch(e){}}
async function saveExpense(){try{const amount=Number(document.getElementById('expenseAmount')?.value||0);if(amount<=0)return alert('Enter a valid expense amount.');await api('/expenses',{method:'POST',body:JSON.stringify({categoryId:Number(document.getElementById('expenseCategory')?.value||0)||null,amount,paymentMethod:document.getElementById('expensePayment')?.value||preferredPaymentMethod(),expenseDate:document.getElementById('expenseDate')?.value||null,note:document.getElementById('expenseNote')?.value||''})});closeExpenseModal();document.getElementById('expenseAmount').value='';document.getElementById('expenseNote').value='';await loadExpenses();alert('Expense saved.');}catch(e){alert(e.message);}}
async function deleteExpense(id){if(!confirm('Delete this expense?'))return;try{await api('/expenses/'+id,{method:'DELETE'});await loadExpenses();}catch(e){alert(e.message);}}

async function loadLoyaltySettings(){try{const s=await api('/loyalty/settings');setSettingValue('loyaltyPointsPerCurrency',s.points_per_currency);setSettingValue('loyaltyCurrencyPerPoint',s.currency_per_point);setSettingValue('loyaltyMinRedeem',s.min_redeem_points);setSettingValue('loyaltyWelcome',s.welcome_points);setSettingValue('loyaltyEnabled',s.enabled);await loadLoyaltyCustomers();}catch(e){console.error(e);}}
async function saveLoyaltySettings(){try{await api('/loyalty/settings',{method:'PUT',body:JSON.stringify({pointsPerCurrency:Number(document.getElementById('loyaltyPointsPerCurrency')?.value||0),currencyPerPoint:Number(document.getElementById('loyaltyCurrencyPerPoint')?.value||1),minRedeemPoints:Number(document.getElementById('loyaltyMinRedeem')?.value||100),welcomePoints:Number(document.getElementById('loyaltyWelcome')?.value||0),enabled:document.getElementById('loyaltyEnabled')?.checked!==false})});alert('Loyalty settings saved.');}catch(e){alert(e.message);}}
async function loadLoyaltyCustomers(){try{const rows=await api('/customers');const s=document.getElementById('loyaltyCustomerSelect');if(s)s.innerHTML='<option value="">Select customer…</option>'+rows.map(c=>`<option value="${c.id}">${esc(c.name)} · ${esc(c.phone||'')}</option>`).join('');}catch(e){}}
async function loadSelectedLoyaltyCustomer(){const id=document.getElementById('loyaltyCustomerSelect')?.value;if(!id)return;try{const r=await api('/loyalty/customers/'+id);setText('loyaltyBalance',r.balance);const b=document.getElementById('loyaltyHistoryBody');if(b)b.innerHTML=r.history.length?r.history.map(h=>`<tr><td>${esc(new Date(h.created_at).toLocaleString())}</td><td>${esc(h.transaction_type)}</td><td>${h.points>0?'+':''}${h.points}</td><td>${esc(h.note||'')}</td></tr>`).join(''):'<tr><td colspan="4">No loyalty transactions.</td></tr>';}catch(e){alert(e.message);}}

async function runBackupHealth(){try{const r=await api('/backup/health');const box=document.getElementById('backupHealth');if(box)box.innerHTML=`<div class="health-grid"><div><b>Database</b><br>${esc(r.database||'-')}</div><div><b>Host</b><br>${esc(r.host||'-')}</div><div><b>pg_dump</b><br>${r.pgDumpBinary&&r.ready?'Configured':'Check environment'}</div><div><b>Node</b><br>${esc(r.node)}</div></div>`;}catch(e){alert(e.message);}}
async function downloadDatabaseBackup(){try{const response=await fetch(API+'/backup/export',{headers:{'Authorization':'Bearer '+authToken}});if(!response.ok){const j=await response.json().catch(()=>({}));throw new Error(j.error||'Backup failed');}const blob=await response.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='cafe-pos-backup-'+new Date().toISOString().slice(0,10)+'.sql';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}catch(e){alert(e.message);}}
function restoreBackupFile(){document.getElementById('restoreBackupInput')?.click();}
async function handleRestoreBackup(input){const file=input.files?.[0];if(!file)return;if(!confirm('Restore this SQL backup? This may modify existing data.')){input.value='';return;}try{const sql=await file.text();await api('/backup/restore',{method:'POST',body:JSON.stringify({sql})});alert('Restore completed. Reload the application.');location.reload();}catch(e){alert(e.message);}finally{input.value='';}}

function saveInvoiceDesigner(){appSettings.accentLabel=document.getElementById('designerAccent')?.value||'';appSettings.logoUrl=document.getElementById('designerLogo')?.value||'';appSettings.receiptFont=document.getElementById('designerFontSize')?.value||'13';appSettings.designerShowNotes=document.getElementById('designerShowNotes')?.checked!==false;appSettings.designerShowInvoiceMeta=document.getElementById('designerShowInvoiceMeta')?.checked!==false;appSettings.designerCompact=document.getElementById('designerCompact')?.checked===true;localStorage.setItem(settingsLocalStorageKey(),JSON.stringify(appSettings));renderInvoiceDesignerPreview();api('/settings',{method:'PUT',body:JSON.stringify(appSettings)}).then(()=>alert('Invoice design saved.')).catch(()=>alert('Saved locally; server settings unavailable.'));}
function renderInvoiceDesignerPreview(){const p=document.getElementById('invoiceDesignerPreview');if(!p)return;const font=document.getElementById('designerFontSize')?.value||'13';const logo=document.getElementById('designerLogo')?.value||appSettings.logoUrl;const name=appSettings.restaurantName||'CAFE POS';p.innerHTML=`${logo?`<img src="${esc(logo)}" alt="logo" class="invoice-preview-logo">`:''}<div class="invoice-preview-name">${esc(name)}</div><div>${esc(document.getElementById('designerAccent')?.value||'Cafe Receipt')}</div><hr><div class="preview-row"><span>Invoice</span><b>INV-000123</b></div><div class="preview-row"><span>Order</span><b>ORD-00123</b></div><hr><div class="preview-line"><span>☕ Cappuccino ×2</span><b>₹240.00</b></div><div class="preview-line"><span>🥪 Sandwich ×1</span><b>₹180.00</b></div><hr><div class="preview-row"><span>Subtotal</span><span>₹420.00</span></div><div class="preview-row"><span>GST</span><span>₹21.00</span></div><div class="preview-row preview-total"><span>Total</span><b>₹441.00</b></div><p style="margin-top:12px">${esc(appSettings.customerMessage||'Thank you for visiting!')}</p>`;p.style.fontSize=font+'px';}

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
async function loadPrinters(){try{window.cafePrinters=await api("/printers");renderPrinters();showPrinterMessage("");await discoverWindowsPrinters()}catch(e){window.cafePrinters=[];renderPrinters();showPrinterMessage(e.message,true);await discoverWindowsPrinters()}}
function editPrinter(id){const p=(window.cafePrinters||[]).find(function(x){return Number(x.id)===Number(id)});if(!p)return;document.getElementById("printerId").value=p.id;document.getElementById("printerName").value=p.name||"";document.getElementById("printerType").value=p.connection_type||"local";document.getElementById("printerHost").value=p.host||"";document.getElementById("printerPort").value=p.port||9100;document.getElementById("printerBluetoothName").value=p.bluetooth_name||"";document.getElementById("printerServiceUuid").value=p.service_uuid||"000018f0-0000-1000-8000-00805f9b34fb";document.getElementById("printerCharacteristicUuid").value=p.characteristic_uuid||"00002af1-0000-1000-8000-00805f9b34fb";document.getElementById("printerPaperWidth").value=p.paper_width||"80";document.getElementById("printerIsDefault").checked=Boolean(p.is_default);document.getElementById("printerFormTitle").textContent="Edit Printer";togglePrinterFields();document.getElementById("printer").scrollIntoView({behavior:"smooth",block:"start"})}
async function savePrinter(){try{const id=printerFormValue("printerId");const type=printerFormValue("printerType");const selectedWindowsPrinter=type==="local"?(document.getElementById("windowsPrinterSelect")?.value||""):"";const printerName=(type==="local"&&selectedWindowsPrinter)?selectedWindowsPrinter:printerFormValue("printerName").trim();const body={name:printerName,connectionType:type,host:printerFormValue("printerHost").trim(),port:Number(printerFormValue("printerPort")||9100),bluetoothName:printerFormValue("printerBluetoothName").trim(),serviceUuid:printerFormValue("printerServiceUuid").trim(),characteristicUuid:printerFormValue("printerCharacteristicUuid").trim(),paperWidth:printerFormValue("printerPaperWidth")||"80",isDefault:document.getElementById("printerIsDefault").checked};const saved=await api(id?"/printers/"+id:"/printers",{method:id?"PUT":"POST",body:JSON.stringify(body)});showPrinterMessage("Printer saved.");resetPrinterForm();await loadPrinters();if(saved.printer)showPrinterMessage("Saved "+saved.printer.name+".")}catch(e){showPrinterMessage(e.message,true)}}
async function deletePrinter(id){if(!confirm("Delete this saved printer?"))return;try{await api("/printers/"+id,{method:"DELETE"});await loadPrinters();showPrinterMessage("Printer deleted.")}catch(e){showPrinterMessage(e.message,true)}}
function printerReceiptText(data){const currency=appSettings.currency||"₹";const moneyValue=value=>currency+Number(value||0).toFixed(2);const lines=[appSettings.restaurantName||"CAFE POS",appSettings.address||"",appSettings.phone?"Phone: "+appSettings.phone:"",appSettings.gstin?"GSTIN: "+appSettings.gstin:"","--------------------------------", "Invoice: "+(data.invoiceNumber||"-"),"Order: "+(data.orderNumber||"-"),"Type: "+(data.orderType||"-"),data.tableNumber?"Table: "+data.tableNumber:"","Date: "+(data.date||new Date().toLocaleString()),data.customerName?"Customer: "+data.customerName:"","--------------------------------","ITEM / QTY / AMOUNT"];(Array.isArray(data.items)?data.items:[]).forEach(function(item){lines.push((appSettings.uppercaseItems?String(item.name||"-").toUpperCase():(item.name||"-"))+" x"+Number(item.quantity||0)+"  "+moneyValue(Number(item.price||0)*Number(item.quantity||0)))});lines.push("--------------------------------","Subtotal: "+moneyValue(data.subtotal||0),"GST: "+moneyValue(data.gst||0),"TOTAL: "+moneyValue(data.total||0),"Payment: "+(data.paymentMethod||"-"),"--------------------------------",appSettings.footer||"Thank you!");return lines.filter(Boolean).join("\n")+"\n\n\n"}
async function sendBluetoothPrinterText(printer,text){if(!navigator.bluetooth)throw new Error("Bluetooth printing is unavailable in this browser. Use Chrome or Edge on HTTPS or localhost.");const serviceUuid=printer.service_uuid||printer.serviceUuid||"000018f0-0000-1000-8000-00805f9b34fb";const characteristicUuid=printer.characteristic_uuid||printer.characteristicUuid||"00002af1-0000-1000-8000-00805f9b34fb";const name=printer.bluetooth_name||printer.bluetoothName||printer.name;const selection=navigator.bluetooth.requestDevice({filters:[{namePrefix:name}],optionalServices:[serviceUuid]});const device=await selection;const server=await device.gatt.connect();try{const service=await server.getPrimaryService(serviceUuid);const characteristic=await service.getCharacteristic(characteristicUuid);const bytes=new TextEncoder().encode(text);const payload=new Uint8Array(bytes.length+11);payload.set([0x1b,0x40,0x1b,0x61,0x01],0);payload.set(bytes,5);payload.set([0x0a,0x0a,0x0a,0x1d,0x56,0x00],5+bytes.length);const writeChunk=chunk=>characteristic.writeValueWithoutResponse?characteristic.writeValueWithoutResponse(chunk):characteristic.writeValue(chunk);for(let i=0;i<payload.length;i+=20)await writeChunk(payload.slice(i,i+20));}finally{if(device.gatt.connected)device.gatt.disconnect()}}
async function pairBluetoothFromForm(){try{if(!navigator.bluetooth)throw new Error("Bluetooth setup needs Chrome or Edge on HTTPS or localhost.");const serviceUuid=printerFormValue("printerServiceUuid")||"000018f0-0000-1000-8000-00805f9b34fb";const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[serviceUuid]});const name=device.name||"Bluetooth Printer";document.getElementById("printerBluetoothName").value=name;if(!printerFormValue("printerName"))document.getElementById("printerName").value=name;showPrinterMessage("Selected "+name+". Save the printer to finish setup.")}catch(e){showPrinterMessage(e.message,true)}}
async function printLocalPrinterTest(name){
    if (isVirtualWindowsPrinter(name)) {
        showPrinterMessage("This is a virtual printer. Select a physical ESC/POS thermal receipt printer for direct receipt printing.", true);
        return;
    }
    try {
        const serviceUrl = window.CAFE_PRINT_SERVICE_URL || "http://127.0.0.1:18181";
        const response = await fetch(serviceUrl + "/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ printerName: name })
        });
        const result = await response.json().catch(function(){ return {}; });
        if (!response.ok) throw new Error(result.error || "Windows print service error.");
        showPrinterMessage("Test print sent to " + name + ".");
    } catch(e) {
        const serviceUnavailable = e instanceof TypeError || /failed to fetch|econnrefused/i.test(String(e.message || ""));
        showPrinterMessage(serviceUnavailable
            ? "Can't connect to the local printer service. Reopen the desktop POS app and try again."
            : "Windows printer test failed: " + e.message, true);
    }
}
function isVirtualWindowsPrinter(name){return /(?:microsoft print to pdf|microsoft xps document writer|onenote|fax|adobe pdf|foxit pdf)/i.test(String(name||""))}
async function testPrinter(id){const printer=(window.cafePrinters||[]).find(function(p){return Number(p.id)===Number(id)});if(!printer)return;try{if(printer.connection_type==="local"){printLocalPrinterTest(printer.name);return}if(printer.connection_type==="bluetooth"){await sendBluetoothPrinterText(printer,"CAFE POS PRINTER TEST\n"+printer.name+"\nConnection successful.\n\n\n");showPrinterMessage("Bluetooth test sent to "+printer.name+".");return}await api("/printers/"+id+"/test",{method:"POST"});showPrinterMessage("Network printer test sent.")}catch(e){showPrinterMessage(e.message,true)}}
async function loadAdvancedReports(){
    try{
        const range=document.getElementById('advancedReportRange')?.value||'month';
        const r=await api('/reports/advanced?range='+encodeURIComponent(range));
        const hourly=Array.isArray(r.hourly)?r.hourly:[], customers=Array.isArray(r.customers)?r.customers:[], cancelled=Array.isArray(r.cancelled)?r.cancelled:[];
        setText('advancedExpenseTotal',money(r.expenseTotal));
        setText('advancedCancelledValue',money(cancelled.reduce((a,x)=>a+Number(x.value||0),0)));
        const hourlyBody=document.getElementById('advancedHourlyBody');
        const customersBody=document.getElementById('advancedCustomersBody');
        const cancelledBody=document.getElementById('advancedCancelledBody');
        if(hourlyBody)hourlyBody.innerHTML=hourly.length?hourly.map(x=>`<tr><td>${String(x.hour).padStart(2,'0')}:00</td><td>${x.orders}</td><td>${money(x.sales)}</td></tr>`).join(''):'<tr><td colspan="3">No data.</td></tr>';
        if(customersBody)customersBody.innerHTML=customers.length?customers.map(x=>`<tr><td>${esc(x.customer)}</td><td>${x.orders}</td><td>${money(x.sales)}</td></tr>`).join(''):'<tr><td colspan="3">No data.</td></tr>';
        if(cancelledBody)cancelledBody.innerHTML=cancelled.length?cancelled.map(x=>`<tr><td>${esc(x.date)}</td><td>${x.orders}</td><td>${money(x.value)}</td></tr>`).join(''):'<tr><td colspan="3">No cancelled orders.</td></tr>';
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

async function loadDeploymentChecks(){try{const r=await api('/system/deployment-check');const box=document.getElementById('deploymentChecks');box.innerHTML=r.checks.map(c=>`<div class="deployment-check ${c.ok?'ok':'bad'}"><span>${c.ok?'✅':'⚠️'}</span><div><b>${esc(c.label)}</b><br><small>${esc(c.detail|| (c.ok?'Ready':'Needs attention'))}</small></div></div>`).join('');}catch(e){document.getElementById('deploymentChecks').textContent=e.message;}}
function downloadEnvTemplate(){const text=`NODE_ENV=production\nPORT=3000\nDB_USER=your_postgres_user\nDB_HOST=127.0.0.1\nDB_NAME=cafe_pos\nDB_PASSWORD=your_postgres_password\nDB_PORT=5432\nPG_DUMP_PATH=pg_dump\nPSQL_PATH=psql\n`;const blob=new Blob([text],{type:'text/plain'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='.env.example';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(a.href);}

// Keep all sales widgets exclusively on Dashboard and Reports by loading new pages only through their own hooks.
const baseShowPage = showPage;
showPage = function(pageName){ baseShowPage(pageName); if(!currentUser)return; switch(pageName){case 'expenses':loadExpenses();break;case 'loyalty':loadLoyaltySettings();break;case 'invoice-designer':renderInvoiceDesignerPreview();break;case 'printer':loadPrinters();break;case 'advanced-reports':loadAdvancedReports();break;case 'marketing':loadMarketingDeals();break;case 'new-order':loadMarketingDeals();break;} };

// ==========================================
// START APPLICATION
// ==========================================

window.addEventListener(
    "DOMContentLoaded",
    async function() {

        console.log("🚀 Cafe POS started");
        await loadLoginBusinessWelcome();

        await loadSettings();


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
        loadBillingAdjustments();
        if(appSettings.kotEnabled!==false) loadKOTGroups();
        loadMenuCategories();

        console.log("✅ Cafe POS initialized successfully");

    }
);
