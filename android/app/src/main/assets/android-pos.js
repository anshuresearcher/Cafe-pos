(function () {
    if (window.__slashAndroidPosInstalled) return;
    window.__slashAndroidPosInstalled = true;

    const body = document.body;
    if (!body) return;
    body.classList.add("android-pos-app");

    const one = (selector, root = document) => root.querySelector(selector);
    const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const setTextIfChanged = (node, value) => { const text = String(value ?? ""); if (node && node.textContent !== text) node.textContent = text; };
    const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
    const money = value => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    function makeButton(className, label, text, action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className;
        button.setAttribute("aria-label", label);
        button.innerHTML = text;
        button.addEventListener("click", action);
        return button;
    }

    function ensureNavigation() {
        all(".billing-flow-link").forEach((button, index) => {
            if (one(".billing-flow-mobile-label", button)) return;
            const desktopText = button.textContent.trim();
            button.textContent = "";
            const desktop = document.createElement("span");
            desktop.className = "billing-flow-desktop-label";
            desktop.textContent = desktopText;
            const mobile = document.createElement("span");
            mobile.className = "billing-flow-mobile-label";
            mobile.textContent = ["My Orders", "Create New", "Table View"][index] || desktopText;
            button.append(desktop, mobile);
        });
    }

    function ensureDrawerIdentity() {
        const header = one(".module-drawer-header");
        if (!header) return;
        if (!one(".module-drawer-user", header)) {
            const brand = one(":scope > strong", header);
            if (!brand) return;
            const identity = document.createElement("div");
            identity.className = "module-drawer-user";
            identity.innerHTML = '<span id="moduleDrawerAvatar" class="module-drawer-avatar" aria-hidden="true">S</span><span class="module-drawer-identity"><strong id="moduleDrawerUserName">Slash</strong><small id="moduleDrawerUserRole">Point of Sale</small></span>';
            brand.replaceWith(identity);
        }
        const caption = one(".module-drawer-caption");
        setTextIfChanged(caption, "MODULES");
        const user = typeof currentUser !== "undefined" ? currentUser : null;
        const name = one("#moduleDrawerUserName");
        const role = one("#moduleDrawerUserRole");
        const avatar = one("#moduleDrawerAvatar");
        if (user) {
            setTextIfChanged(name, user.display_name || "User");
            setTextIfChanged(role, user.profile_name || "No Profile");
            setTextIfChanged(avatar, (user.display_name || "U").trim().charAt(0).toUpperCase() || "U");
        }
    }

    function setModuleDrawer(open) {
        body.classList.toggle("billing-nav-open", Boolean(open));
        all(".mobile-toolbar-menu-toggle").forEach(button => button.setAttribute("aria-expanded", String(Boolean(open))));
    }
    function ensureDrawerScrim() {
        const nav = one(".app-module-nav"); if (!nav) return;
        let scrim = one("#androidModuleDrawerScrim");
        if (!scrim) { scrim = document.createElement("button"); scrim.id = "androidModuleDrawerScrim"; scrim.type = "button"; scrim.className = "android-module-drawer-scrim"; scrim.setAttribute("aria-label", "Close app menu"); scrim.addEventListener("click", () => setModuleDrawer(false)); document.body.append(scrim); }
        const close = one(".module-drawer-close", nav);
        if (close && close.dataset.androidBound !== "true") { close.dataset.androidBound = "true"; close.addEventListener("click", () => setModuleDrawer(false)); }
        if (!document.body.dataset.androidDrawerEscapeBound) { document.body.dataset.androidDrawerEscapeBound = "true"; document.addEventListener("keydown", event => { if (event.key === "Escape" && body.classList.contains("billing-nav-open")) setModuleDrawer(false); }); }
    }
    function openCart() {
        body.classList.add("mobile-cart-open");
        one("#new-order .billing-shell")?.classList.add("mobile-cart-open");
    }
    function closeCart() {
        body.classList.remove("mobile-cart-open");
        one("#new-order .billing-shell")?.classList.remove("mobile-cart-open");
    }
    function updateCartBar() {
        const cartItems = typeof cart !== "undefined" && Array.isArray(cart) ? cart : [];
        const count = cartItems.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
        const countNode = one("#androidBillItemCount");
        const totalNode = one("#androidBillTotal");
        const bar = one("#androidBillingBar");
        const countText = `${count} ${count === 1 ? "item" : "items"}`;
        const totalText = one("#total")?.textContent || money(0);
        if (countNode && countNode.textContent !== countText) countNode.textContent = countText;
        if (totalNode && totalNode.textContent !== totalText) totalNode.textContent = totalText;
        if (bar && bar.hidden !== (count === 0)) bar.hidden = count === 0;
    }

    function ensureAndroidLoginBrand() {
        const card = one("#loginCard");
        if (!card || one(".android-login-brand", card)) return;
        const brand = document.createElement("div");
        brand.className = "android-login-brand";
        brand.innerHTML = '<span class="android-login-brand-mark" aria-hidden="true">S</span><span class="android-login-brand-copy"><strong>SLASH</strong><small>CAFE POINT OF SALE</small></span>';
        card.insertBefore(brand, card.firstChild);
    }

    function ensureBillingTools() {
        const actions = one("#new-order .billing-top-actions");
        if (!actions) return;
        if (!one(".mobile-toolbar-menu-toggle", actions)) {
            actions.prepend(makeButton("mobile-toolbar-menu-toggle", "Open app menu", "☰", () => setModuleDrawer(!body.classList.contains("billing-nav-open"))));
        }
        if (!one(".mobile-billing-search-toggle", actions)) {
            actions.append(makeButton("mobile-toolbar-icon mobile-billing-search-toggle", "Search menu", '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 5 5"/></svg>', () => {
                const shell = one("#new-order .billing-shell");
                const open = !shell?.classList.contains("mobile-billing-search-open");
                shell?.classList.toggle("mobile-billing-search-open", open);
                if (open) setTimeout(() => one("#billingMenuSearch")?.focus(), 0);
            }));
        }
        if (!one(".android-orders-shortcut", actions)) {
            actions.append(makeButton("mobile-toolbar-icon android-orders-shortcut", "My orders", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12a2 2 0 0 0 4 0h-4Z"/></svg>', () => window.showPage?.("orders")));
        }
        if (!one(".billing-mobile-more-toggle", actions)) {
            const more = makeButton("mobile-toolbar-icon billing-mobile-more-toggle", "More billing options", "⋮", () => {
                const menu = one("#billingMobileMoreMenu");
                if (menu) menu.hidden = !menu.hidden;
                more.setAttribute("aria-expanded", String(menu && !menu.hidden));
            });
            more.setAttribute("aria-expanded", "false");
            actions.append(more);
            const menu = document.createElement("div");
            menu.id = "billingMobileMoreMenu";
            menu.className = "mobile-toolbar-more-menu";
            menu.hidden = true;
            menu.innerHTML = '<button type="button" data-action="view-bill">View bill</button><button type="button" data-action="clear-bill">Clear bill</button>';
            menu.addEventListener("click", event => {
                const action = event.target.closest("button")?.dataset.action;
                menu.hidden = true;
                if (action === "view-bill") openCart();
                if (action === "clear-bill") window.clearBillingCart?.();
            });
            actions.append(menu);
        }

        const cartHeader = one("#new-order .billing-cart-header");
        if (cartHeader && !one(".mobile-cart-back", cartHeader)) {
            const back = makeButton("mobile-cart-back", "Back to menu", "←", closeCart);
            cartHeader.prepend(back);
            const copy = one(":scope > div", cartHeader);
            if (copy && !one(".mobile-cart-title", copy)) {
                const title = document.createElement("span");
                title.className = "mobile-cart-title";
                title.textContent = "Cart";
                copy.prepend(title);
            }
        }
        const workspace = one("#new-order .billing-workspace");
        if (workspace && !one("#androidBillingBar")) {
            const bar = document.createElement("div");
            bar.id = "androidBillingBar";
            bar.className = "mobile-billing-bar";
            bar.hidden = true;
            bar.innerHTML = '<div class="mobile-billing-bar-total"><small><span id="androidBillItemCount">0 items</span> · Bill amount</small><strong id="androidBillTotal">₹0</strong></div><button type="button">View bill <span aria-hidden="true">›</span></button>';
            one("#new-order .billing-shell")?.append(bar);
            one("button", bar)?.addEventListener("click", openCart);
        }
        updateCartBar();
    }

    function getTags(item) {
        const raw = item?.tags;
        return (Array.isArray(raw) ? raw : String(raw || "").split(/[;,]/)).map(tag => String(tag || "").trim()).filter(Boolean);
    }
    let activeTag = "";
    function applyTagFilter() {
        all("#new-order .food-card").forEach(card => {
            const matches = !activeTag || String(card.dataset.androidTags || "").split("|").includes(activeTag);
            card.hidden = !matches;
        });
    }
    function ensureMenuLayout() {
        const sidebar = one("#billingCategorySidebar");
        if (sidebar) all(".category-btn", sidebar).forEach(button => {
            if (one(".category-initial", button)) return;
            const label = button.textContent.trim() || "All Items";
            button.innerHTML = `<span class="category-initial" aria-hidden="true">${escapeHtml(Array.from(label)[0] || "•")}</span><span class="category-label">${escapeHtml(label)}</span>`;
        });
        const items = typeof currentMenu !== "undefined" && Array.isArray(currentMenu) ? currentMenu : [];
        all("#new-order .food-card").forEach(card => {
            const item = items.find(entry => String(entry.name || "") === one("h3", card)?.textContent?.trim());
            if (item) card.dataset.androidTags = getTags(item).map(tag => tag.toLowerCase()).join("|");
            const content = one(".food-card-content", card);
            const add = one(".food-card-bottom button", card);
            if (add && content && !one(".food-card-add", card)) {
                add.classList.add("food-card-add");
                add.textContent = "ADD";
                content.after(add);
                if (item && ((Array.isArray(item.variants) && item.variants.length) || (Array.isArray(item.optionSetIds || item.option_set_ids) && (item.optionSetIds || item.option_set_ids).length))) {
                    const custom = document.createElement("span");
                    custom.className = "food-customizable";
                    custom.textContent = "+Customisable";
                    one(".food-card-bottom", content)?.append(custom);
                }
            }
        });
        const shell = one("#new-order .billing-shell");
        if (shell && !one("#billingMenuTagFilters")) {
            const tags = [...new Map(items.flatMap(getTags).map(tag => [tag.toLowerCase(), tag])).values()];
            if (tags.length) {
                const wrap = document.createElement("div");
                wrap.id = "billingMenuTagFilters";
                wrap.className = "billing-menu-tag-filters";
                wrap.innerHTML = tags.map(tag => `<button type="button" class="billing-menu-tag-chip" data-tag="${escapeHtml(tag.toLowerCase())}">${escapeHtml(tag)}</button>`).join("");
                wrap.addEventListener("click", event => {
                    const button = event.target.closest("button[data-tag]");
                    if (!button) return;
                    activeTag = activeTag === button.dataset.tag ? "" : button.dataset.tag;
                    all("button[data-tag]", wrap).forEach(chip => chip.classList.toggle("active", chip === button && activeTag));
                    applyTagFilter();
                });
                one(".billing-header", shell)?.after(wrap);
            }
        }
        applyTagFilter();
    }

    function ensureOrdersTools() {
        const orders = one("#orders");
        const tabs = one(".orders-tabs", orders);
        if (!orders || !tabs) return;
        const heading = one(".orders-detail-heading", orders);
        if (heading && !one(".android-order-back", heading)) {
            const back = makeButton("android-order-back", "Back to orders", '<span aria-hidden="true">←</span><span>Orders</span>', () => window.closeOrderDetails?.());
            heading.prepend(back);
        }
        if (!one(".orders-mobile-toolbar", orders)) {
            const toolbar = document.createElement("div");
            toolbar.className = "orders-mobile-toolbar";
            toolbar.innerHTML = '<button type="button" class="mobile-toolbar-menu-toggle" aria-label="Open app menu">☰</button><select id="androidOrdersSource" aria-label="Order source"><option value="all">All orders</option><option value="store">In Store</option><option value="online">Slash / QR</option></select><button type="button" class="mobile-toolbar-icon" aria-label="Search orders">⌕</button><button type="button" class="mobile-toolbar-icon" aria-label="Open orders"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12a2 2 0 0 0 4 0h-4Z"/></svg></button><button type="button" class="mobile-toolbar-icon" aria-label="More order options">⋮</button>';
            toolbar.querySelector(".mobile-toolbar-menu-toggle")?.addEventListener("click", () => setModuleDrawer(!body.classList.contains("billing-nav-open")));
            const searchToggle = toolbar.querySelector('[aria-label="Search orders"]');
            const moreToggle = toolbar.querySelector('[aria-label="More order options"]');
            searchToggle?.addEventListener("click", () => {
                const search = one("#androidOrdersSearchWrap");
                if (!search) return;
                search.hidden = !search.hidden;
                body.classList.toggle("mobile-orders-search-open", !search.hidden);
                if (!search.hidden) one("input", search)?.focus();
                else { const input = one("input", search); if (input) input.value = ""; renderAndroidOrders(); }
            });
            toolbar.querySelector('[aria-label="Open orders"]')?.addEventListener("click", () => window.switchOrdersTab?.("open"));
            moreToggle?.addEventListener("click", () => body.classList.toggle("mobile-orders-filters-open"));
            toolbar.querySelector("select")?.addEventListener("change", renderAndroidOrders);
            orders.insertBefore(toolbar, tabs);
        }
        if (!one("#androidOrdersSearchWrap", orders)) {
            const search = document.createElement("label");
            search.id = "androidOrdersSearchWrap";
            search.className = "mobile-orders-search";
            search.hidden = true;
            search.innerHTML = '<span aria-hidden="true">⌕</span><input id="androidOrdersSearch" type="search" placeholder="Search orders…" autocomplete="off"><button type="button" aria-label="Clear order search">×</button>';
            one("input", search)?.addEventListener("input", renderAndroidOrders);
            one("button", search)?.addEventListener("click", () => { const input = one("input", search); if (input) input.value = ""; renderAndroidOrders(); });
            orders.insertBefore(search, tabs);
        }
        if (!one('[data-tab="due"]', tabs)) {
            const due = document.createElement("button");
            due.type = "button";
            due.className = "orders-tab-btn";
            due.dataset.tab = "due";
            due.innerHTML = 'Amount Due <span id="androidDueOrdersCount">0</span>';
            due.addEventListener("click", () => { window.__androidOrdersTab = "due"; all(".orders-tab-btn", tabs).forEach(tab => tab.classList.toggle("active", tab === due)); renderAndroidOrders(); });
            tabs.append(due);
        }
        all('.orders-tab-btn:not([data-tab="due"])', tabs).forEach(button => {
            if (button.dataset.androidBound === "true") return;
            button.dataset.androidBound = "true";
            button.addEventListener("click", () => setTimeout(() => { window.__androidOrdersTab = window.currentOrdersTab || "open"; renderAndroidOrders(); }, 0));
        });
        ["ordersSearch", "ordersDateFrom", "ordersDateTo", "ordersChannelFilter", "ordersPaymentFilter", "ordersStatusFilter"].forEach(id => {
            const input = one(`#${id}`);
            if (!input || input.dataset.androidBound === "true") return;
            input.dataset.androidBound = "true";
            input.addEventListener("input", renderAndroidOrders);
        });
    }

    function renderAndroidOrders() {
        const list = one("#ordersTableBody");
        if (!list || typeof currentOrders === "undefined" || !Array.isArray(currentOrders)) return;
        const orders = currentOrders;
        const group = order => {
            const status = String(order.status || "").toLowerCase();
            return status === "completed" ? "closed" : status === "cancelled" ? "cancelled" : "open";
        };
        const isQr = order => typeof window.isQrTrackedOrder === "function" && window.isQrTrackedOrder(order);
        const source = one("#androidOrdersSource")?.value || "all";
        const sourceOrders = orders.filter(order => source === "all" || (source === "online" ? isQr(order) : !isQr(order)));
        const selectedTab = window.__androidOrdersTab || window.currentOrdersTab || "open";
        const hasBalance = order => { const method = String(order.payment_method || "").toLowerCase(); if (/non.?chargeable/i.test(method)) return false; if (order.amount_collected != null) return Number(order.total || 0) - Number(order.amount_collected || 0) > 0.009; if (group(order) === "closed" && method && !/(unpaid|pending|partial)/.test(method)) return false; return Number(order.total || 0) > 0; };
        const dueOrders = sourceOrders.filter(order => group(order) !== "cancelled" && hasBalance(order));
        const statusFilter = one("#ordersStatusFilter")?.value || "";
        const visibleTab = statusFilter || selectedTab;
        const activeOrders = statusFilter ? sourceOrders.filter(order => group(order) === statusFilter) : selectedTab === "due" ? dueOrders : sourceOrders.filter(order => group(order) === selectedTab);
        const query = one("#androidOrdersSearch")?.value.trim().toLowerCase() || one("#ordersSearch")?.value.trim().toLowerCase() || "";
        const fromDate = one("#ordersDateFrom")?.value || "";
        const toDate = one("#ordersDateTo")?.value || "";
        const channel = String(one("#ordersChannelFilter")?.value || "").trim().toLowerCase();
        const payment = String(one("#ordersPaymentFilter")?.value || "").trim().toLowerCase();
        const localDateKey = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"); };
        const filtered = activeOrders.filter(order => {
            const previewItems = Array.isArray(order.item_preview) ? order.item_preview : [];
            const preview = previewItems.map(item => item.item_name).join(" ");
            const modes = Array.isArray(order.payment_modes) ? order.payment_modes.map(value => String(value || "").trim().toLowerCase()).filter(Boolean) : [];
            const method = String(order.payment_method || "").trim().toLowerCase();
            const date = localDateKey(order.created_at);
            const dateMatches = (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
            const channelMatches = !channel || String(order.sale_channel || order.order_type || "").trim().toLowerCase() === channel;
            const paymentMatches = !payment || (payment === "__unpaid" ? !modes.length && (!method || method === "unpaid" || method === "partially paid") : modes.includes(payment) || method === payment);
            const searchMatches = !query || [order.order_number, order.id, order.sale_channel, order.order_type, order.table_number, order.customer_name, order.customer_phone, preview].some(value => String(value || "").toLowerCase().includes(query));
            return dateMatches && channelMatches && paymentMatches && searchMatches;
        });
        const dueCount = one("#androidDueOrdersCount");
        if (dueCount) dueCount.textContent = String(dueOrders.length);
        const title = one("#ordersListTitle");
        if (title) title.textContent = visibleTab === "due" ? "Amount Due" : `${visibleTab[0].toUpperCase()}${visibleTab.slice(1)} orders`;
        const count = one("#ordersResultCount");
        if (count) count.textContent = `${filtered.length} ${filtered.length === 1 ? "order" : "orders"}`;
        list.innerHTML = filtered.map(order => {
            const id = Number(order.id);
            const status = group(order);
            const total = Number(order.total || 0);
            const collected = Number(order.amount_collected || 0);
            const paid = /non.?chargeable/i.test(String(order.payment_method || "")) || collected >= total - 0.009 || status === "closed";
            const payLabel = paid ? "PAID" : collected > 0 ? "PART PAID" : "UNPAID";
            const time = order.created_at ? new Date(order.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
            const channel = [order.sale_channel || order.order_type, order.table_number ? `Table ${order.table_number}${Number(order.pax) > 0 ? ` · ${order.pax} PAX` : ""}` : ""].filter(Boolean).join(" · ");
            const preview = (Array.isArray(order.item_preview) ? order.item_preview : []).slice(0, 2).map(item => `${Math.max(1, Number(item.quantity || 1))} x ${escapeHtml(item.item_name || "Item")}`).join("<br>") || "Order details";
            const action = isQr(order) && status === "open" && typeof window.renderQrOrderListAction === "function" ? window.renderQrOrderListAction(order) : "";
            return `<article class="order-list-card ${Number(window.selectedOrderId) === id ? "selected" : ""} ${isQr(order) ? "qr-order-list-card" : ""}" data-order-id="${id}" role="listitem"><button type="button" class="order-list-card-open" onclick="viewOrder(${id})"><span class="mobile-order-card-content"><span class="mobile-order-card-head"><strong>${escapeHtml(order.order_number || `#${id}`)}</strong><em class="mobile-payment-state ${paid ? "paid" : collected > 0 ? "partial" : "unpaid"}">${payLabel}</em><time>${escapeHtml(time)}</time></span><span class="mobile-order-card-channel">${escapeHtml(channel)}</span><span class="mobile-order-preview">${preview}</span><span class="mobile-order-card-bottom"><span>Order total</span><strong>${money(total)}</strong></span></span></button>${action}</article>`;
        }).join("") || '<div class="orders-empty-state"><span>⌕</span><strong>No matching orders</strong><small>Try another status or search.</small></div>';
    }

    function wrapAppFunctions() {
        if (typeof window.loadMenu === "function" && !window.loadMenu.__androidWrapped) {
            const original = window.loadMenu;
            const wrapped = async function () {
                try { return await original.apply(this, arguments); }
                finally { scheduleInstall(); }
            };
            wrapped.__androidWrapped = true;
            window.loadMenu = wrapped;
        }
        if (typeof window.loginUser === "function" && !window.loginUser.__androidWrapped) {
            const original = window.loginUser;
            const wrapped = async function () {
                try { return await original.apply(this, arguments); }
                finally { scheduleInstall(); }
            };
            wrapped.__androidWrapped = true;
            window.loginUser = wrapped;
        }
        if (typeof window.updateBill === "function" && !window.updateBill.__androidWrapped) {
            const original = window.updateBill;
            const wrapped = function () { const result = original.apply(this, arguments); updateCartBar(); return result; };
            wrapped.__androidWrapped = true;
            window.updateBill = wrapped;
        }
        if (typeof window.updateOrdersTable === "function" && !window.updateOrdersTable.__androidWrapped) {
            const original = window.updateOrdersTable;
            const wrapped = async function () {
                            const mobile = window.matchMedia("(max-width: 760px)").matches;
                            const keepDetailOpen = body.classList.contains("mobile-order-detail-open");
                            window.__androidSuppressOrderAutoOpen = mobile && !keepDetailOpen;
                            if (window.__androidSuppressOrderAutoOpen) window.selectedOrderId = null;
                            try { return await original.apply(this, arguments); }
                            finally { window.__androidSuppressOrderAutoOpen = false; renderAndroidOrders(); }
                        };
            wrapped.__androidWrapped = true;
            window.updateOrdersTable = wrapped;
        }
        if (typeof window.viewOrder === "function" && !window.viewOrder.__androidWrapped) {
            const original = window.viewOrder;
            const wrapped = async function () {
                            const orderId = Number(arguments[0]);
                            if (window.__androidSuppressOrderAutoOpen && window.matchMedia("(max-width: 760px)").matches) return null;
                            const result = await original.apply(this, arguments);
                            const content = one("#orderDetailsContent");
                            if (window.matchMedia("(max-width: 760px)").matches && Number(window.selectedOrderId) === orderId && content && !content.hidden) body.classList.add("mobile-order-detail-open");
                            return result;
                        };
            wrapped.__androidWrapped = true;
            window.viewOrder = wrapped;
        }
        if (typeof window.closeOrderDetails === "function" && !window.closeOrderDetails.__androidWrapped) {
            const original = window.closeOrderDetails;
            const wrapped = function () { body.classList.remove("mobile-order-detail-open"); return original.apply(this, arguments); };
            wrapped.__androidWrapped = true;
            window.closeOrderDetails = wrapped;
        }
        if (typeof window.showPage === "function" && !window.showPage.__androidWrapped) {
            const original = window.showPage;
            const wrapped = function (page) {
                setModuleDrawer(false);
                closeCart();
                const moreMenu = one("#billingMobileMoreMenu");
                if (moreMenu) moreMenu.hidden = true;
                body.classList.remove("mobile-orders-filters-open", "mobile-orders-search-open");
                if (page !== "orders") body.classList.remove("mobile-order-detail-open");
                const result = original.apply(this, arguments);
                scheduleInstall();
                return result;
            };
            wrapped.__androidWrapped = true;
            window.showPage = wrapped;
        }
    }

    function handleAndroidBack() {
        if (body.classList.contains("billing-nav-open")) { setModuleDrawer(false); return true; }
        const moreMenu = one("#billingMobileMoreMenu");
        if (moreMenu && !moreMenu.hidden) { moreMenu.hidden = true; return true; }
        const orderMenu = one("#orderDetailsMoreMenu");
        if (orderMenu && !orderMenu.hidden && typeof window.closeOrderDetailsMenu === "function") { window.closeOrderDetailsMenu(); return true; }
        if (body.classList.contains("mobile-order-detail-open")) { window.closeOrderDetails?.(); return true; }
        if (body.classList.contains("mobile-cart-open")) { closeCart(); return true; }
        if (body.classList.contains("mobile-orders-filters-open")) { body.classList.remove("mobile-orders-filters-open"); return true; }
        if (body.classList.contains("mobile-orders-search-open")) {
            body.classList.remove("mobile-orders-search-open");
            const search = one("#androidOrdersSearchWrap");
            if (search) search.hidden = true;
            return true;
        }
        return false;
    }

    function install() {
        ensureAndroidLoginBrand();
        ensureNavigation();
        ensureDrawerIdentity();
        ensureDrawerScrim();
        ensureBillingTools();
        ensureMenuLayout();
        ensureOrdersTools();
        wrapAppFunctions();
        updateCartBar();
        window.__slashAndroidHandleBack = handleAndroidBack;
    }

    function scheduleInstall() {
        if (window.__slashAndroidPosRefreshPending) return;
        window.__slashAndroidPosRefreshPending = true;
        requestAnimationFrame(() => {
            window.__slashAndroidPosRefreshPending = false;
            install();
        });
    }

    install();
    document.addEventListener("click", event => {
        if (!event.target.closest("#billingMobileMoreMenu, .billing-mobile-more-toggle")) {
            const menu = one("#billingMobileMoreMenu");
            if (menu) menu.hidden = true;
        }
        if (event.target.closest(".app-module-nav .nav-btn")) setTimeout(() => setModuleDrawer(false), 0);
    });
})();
