# Cafe Pilot POS for Windows

The desktop app wraps the existing Cafe POS interface in a resizable Electron window with a custom Cafe Pilot title bar and native minimize, maximize/restore, and close controls. It connects to the existing POS API and database; database credentials are not copied to the Windows computer.

## Run the desktop app during development

From the project folder in PowerShell:

```powershell
npm install
npm run desktop:dev
```

The app connects to `https://cafe-pos-six-gamma.vercel.app` by default. Click the gear in the desktop title bar to choose another HTTPS POS deployment. For local development, use `http://localhost:3000` while the POS server is running with `npm start`. The selected address is stored in the current Windows user's application settings.

## Build the Windows installer

On Windows, run:

```powershell
npm run desktop:build:win
```

The x64 NSIS installer and unpacked application are written to `desktop-dist/`. The installer supports choosing an installation folder and creates Start Menu and desktop shortcuts.

The app and installer use `desktop/assets/cafe-pilot-icon.ico`. Its editable vector source is `desktop/assets/cafe-pilot-icon.svg`; regenerate the ICO and PNG preview with `node desktop/assets/generate-icon.js`.

## Windows receipt printing

The app starts its loopback-only printer bridge and stops it when the app exits. In POS **Printer** settings, refresh local printers, select a printer installed in Windows, save it, and set it as the default bill printer. No separate Node installation or manually started helper is needed for the Windows app.

The hosted POS API must allow the desktop origin `cafe-pos://app`. This origin is included in this project's `server.js`; deploy that server configuration before using the packaged desktop app.
