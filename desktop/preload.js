const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cafePOSDesktop", Object.freeze({
    getApiBase: () => ipcRenderer.invoke("desktop:get-api-base"),
    saveApiBase: value => ipcRenderer.invoke("desktop:set-api-base", String(value || "")),
    getWindowState: () => ipcRenderer.invoke("desktop:window-state"),
    minimizeWindow: () => ipcRenderer.invoke("desktop:window-minimize"),
    toggleMaximizeWindow: () => ipcRenderer.invoke("desktop:window-toggle-maximize"),
    closeWindow: () => ipcRenderer.invoke("desktop:window-close"),
    openServerSettings: () => ipcRenderer.invoke("desktop:open-server-settings"),
    saveReceiptPdf: payload => ipcRenderer.invoke("desktop:save-receipt-pdf", payload),
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
