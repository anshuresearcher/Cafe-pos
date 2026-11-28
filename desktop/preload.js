const { contextBridge, ipcRenderer } = require("electron");

const orderNotificationListeners = new Set();
let queuedOrderNotification = null;
ipcRenderer.on("desktop:order-notification-clicked", (_event, payload) => {
    if (!orderNotificationListeners.size) {
        queuedOrderNotification = payload;
        return;
    }
    for (const listener of orderNotificationListeners) listener(payload);
});

function onOrderNotificationClick(callback) {
    if (typeof callback !== "function") return () => {};
    orderNotificationListeners.add(callback);
    if (queuedOrderNotification) {
        const payload = queuedOrderNotification;
        queuedOrderNotification = null;
        callback(payload);
    }
    return () => orderNotificationListeners.delete(callback);
}

contextBridge.exposeInMainWorld("cafePOSDesktop", Object.freeze({
    getApiBase: () => ipcRenderer.invoke("desktop:get-api-base"),
    saveApiBase: value => ipcRenderer.invoke("desktop:set-api-base", String(value || "")),
    getWindowState: () => ipcRenderer.invoke("desktop:window-state"),
    minimizeWindow: () => ipcRenderer.invoke("desktop:window-minimize"),
    toggleMaximizeWindow: () => ipcRenderer.invoke("desktop:window-toggle-maximize"),
    closeWindow: () => ipcRenderer.invoke("desktop:window-close"),
    openServerSettings: () => ipcRenderer.invoke("desktop:open-server-settings"),
    saveReceiptPdf: payload => ipcRenderer.invoke("desktop:save-receipt-pdf", payload),
    printReceipt: payload => ipcRenderer.invoke("desktop:print-receipt", payload),
    notifyIncomingOrder: payload => ipcRenderer.invoke("desktop:notify-incoming-order", payload),
    onOrderNotificationClick,
    speakHindiAlert: text => ipcRenderer.invoke("desktop:speak-hindi-alert", String(text || "")),
    cancelHindiAlert: () => ipcRenderer.send("desktop:cancel-hindi-alert"),
    selectBluetoothDevice: deviceId => ipcRenderer.send("desktop:bluetooth-select-device", String(deviceId || "")),
    cancelBluetoothSelection: () => ipcRenderer.send("desktop:bluetooth-cancel-selection"),
    onBluetoothDevices: callback => {
        if (typeof callback !== "function") return () => {};
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("desktop:bluetooth-devices", listener);
        return () => ipcRenderer.removeListener("desktop:bluetooth-devices", listener);
    },
    onBluetoothSelectionFinished: callback => {
        if (typeof callback !== "function") return () => {};
        const listener = () => callback();
        ipcRenderer.on("desktop:bluetooth-selection-finished", listener);
        return () => ipcRenderer.removeListener("desktop:bluetooth-selection-finished", listener);
    },
    onWindowStateChanged: callback => {
        if (typeof callback !== "function") return () => {};
        const listener = (_event, state) => callback(Boolean(state?.maximized));
        ipcRenderer.on("desktop:window-state", listener);
        return () => ipcRenderer.removeListener("desktop:window-state", listener);
    }
}));
