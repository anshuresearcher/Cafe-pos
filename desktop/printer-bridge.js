const http = require("node:http");
const { execFile } = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = 18181;
const ALLOWED_ORIGINS = new Set([
    "cafe-pos://app",
    "https://cafe-pos-six-gamma.vercel.app",
    "https://cafe-pos-pos-cafe.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
]);
let server = null;

function runPowerShell(script) {
    return new Promise((resolve, reject) => {
        // Passing values after `-Command` makes Windows PowerShell treat them
        // as additional commands in some hosts. Run the complete script as one
        // UTF-16LE encoded command instead.
        const quietScript = "$ProgressPreference = 'SilentlyContinue'\r\n" + script;
        const encodedScript = Buffer.from(quietScript, "utf16le").toString("base64");
        execFile("powershell.exe", [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript
        ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                const details = `${stderr || ""}\n${error.message || ""}`;
                const winError = details.match(/(?:Windows error|failed):\s*(\d+)/i)?.[1];
                const diagnostic = String(stderr || "")
                    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
                    .replace(/#< CLIXML[\s\S]*?<\/Objs>/gi, " ")
                    .replace(/#< CLIXML[\s\S]*$/gi, " ")
                    .split(/\r?\n/).map(line => line.trim())
                    .filter(line => line && !line.startsWith("At ") && !line.startsWith("+"))
                    .slice(-2).join(" ").slice(0, 300);
                if (winError === "1801") {
                    return reject(new Error("Windows could not find that printer (error 1801). Refresh the printer list, select the installed printer again, then save and retry."));
                }
                if (winError === "5") {
                    return reject(new Error("Windows denied access to this printer. Check that your Windows account can print to it."));
                }
                if (!diagnostic && /Preparing modules for first use/i.test(stderr || "")) {
                    return reject(new Error("Windows printer support is initializing. Close and reopen Cafe POS, then try printing again."));
                }
                return reject(new Error(diagnostic || "Windows could not send the print job. Check that the selected printer is installed and online, then retry."));
            }
            resolve(stdout.trim());
        });
    });
}

async function listPrinters() {
    const output = await runPowerShell(`
        $items = Get-Printer | ForEach-Object {
            [PSCustomObject]@{
                name = $_.Name
                status = [string]$_.PrinterStatus
                shared = [bool]$_.Shared
                driver = [string]$_.DriverName
                port = [string]$_.PortName
            }
        }
        ConvertTo-Json -InputObject @($items) -Compress -Depth 3
    `);
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
}

async function rawPrint(printerName, receipt) {
    const printer64 = Buffer.from(String(printerName), "utf8").toString("base64");
    const receipt64 = Buffer.from(String(receipt), "utf8").toString("base64");
    const script = `
$printer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${printer64}'))
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${receipt64}'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CafePosRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }
    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
    public static void Send(string printer, byte[] bytes) {
        IntPtr handle;
        if (!OpenPrinter(printer, out handle, IntPtr.Zero)) throw new Exception("Could not open printer. Windows error: " + Marshal.GetLastWin32Error());
        try {
            DOCINFO info = new DOCINFO(); info.pDocName = "Cafe POS Receipt"; info.pDataType = "RAW";
            if (!StartDocPrinter(handle, 1, info)) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
            try {
                if (!StartPagePrinter(handle)) throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());
                try { int written; if (!WritePrinter(handle, bytes, bytes.Length, out written)) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error()); }
                finally { EndPagePrinter(handle); }
            } finally { EndDocPrinter(handle); }
        } finally { ClosePrinter(handle); }
    }
}
'@
$bytes = [Text.Encoding]::UTF8.GetBytes($data)
$prefix = [byte[]](0x1B,0x40)
$suffix = [byte[]](0x0A,0x0A,0x0A,0x1D,0x56,0x00)
$payload = New-Object byte[] ($prefix.Length + $bytes.Length + $suffix.Length)
[Array]::Copy($prefix,0,$payload,0,$prefix.Length)
[Array]::Copy($bytes,0,$payload,$prefix.Length,$bytes.Length)
[Array]::Copy($suffix,0,$payload,$prefix.Length+$bytes.Length,$suffix.Length)
[CafePosRawPrinter]::Send($printer, $payload)
`;
    await runPowerShell(script);
}

async function driverPrint(printerName, receipt) {
    const printer64 = Buffer.from(String(printerName), "utf8").toString("base64");
    const receipt64 = Buffer.from(String(receipt), "utf8").toString("base64");
    const script = `
$printer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${printer64}'))
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${receipt64}'))
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Printing;
public class CafePosDriverPrinter {
    public static void Send(string printer, string data) {
        PrintDocument document = new PrintDocument();
        document.PrinterSettings.PrinterName = printer;
        if (!document.PrinterSettings.IsValid) throw new Exception("Windows could not find that printer (error 1801).");
        document.DocumentName = "Cafe POS Print Job";
        document.DefaultPageSettings.Margins = new Margins(35, 35, 35, 35);
        document.PrintController = new StandardPrintController();
        Font font = new Font("Consolas", 10);
        string[] lines = data.Replace("\\r", "").Split('\\n');
        int index = 0;
        document.PrintPage += delegate(object sender, PrintPageEventArgs e) {
            float y = e.MarginBounds.Top;
            float lineHeight = font.GetHeight(e.Graphics);
            while (index < lines.Length && y + lineHeight <= e.MarginBounds.Bottom) {
                e.Graphics.DrawString(lines[index++], font, Brushes.Black, e.MarginBounds.Left, y);
                y += lineHeight;
            }
            e.HasMorePages = index < lines.Length;
        };
        try { document.Print(); }
        finally { font.Dispose(); document.Dispose(); }
    }
}
'@
[CafePosDriverPrinter]::Send($printer, $data)
`;
    await runPowerShell(script);
}

function usesWindowsDriver(printer) {
    return /pdf|xps|fax|onenote|dummy|generic.*text|text.only/i.test(`${printer?.name || ""} ${printer?.driver || ""}`);
}

function sendJson(req, res, status, value, origin) {
    const body = value === null ? "" : JSON.stringify(value);
    const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
    }
    if (body) headers["Content-Length"] = Buffer.byteLength(body);
    res.writeHead(status, headers);
    res.end(body);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
                reject(new Error("Print request is too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error("Invalid JSON body.")); }
        });
        req.on("error", reject);
    });
}

function start() {
    if (process.platform !== "win32") return Promise.resolve();
    if (server) return Promise.resolve();
    server = http.createServer(async (req, res) => {
        const origin = req.headers.origin || "";
        if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJson(req, res, 403, { error: "Origin is not allowed." }, "");
        if (req.method === "OPTIONS") return sendJson(req, res, 204, null, origin);

        try {
            if (req.method === "GET" && req.url === "/health") {
                return sendJson(req, res, 200, { ok: true, service: "Cafe POS Windows printer bridge", port: PORT }, origin);
            }
            if (req.method === "GET" && req.url === "/printers") {
                return sendJson(req, res, 200, { printers: await listPrinters() }, origin);
            }
            if (req.method === "POST" && ["/print", "/test"].includes(req.url)) {
                const body = await readJson(req);
                const printerName = String(body.printerName || "").trim();
                if (!printerName) return sendJson(req, res, 400, { error: "printerName is required." }, origin);
                const printers = await listPrinters();
                const printer = printers.find(item => item.name.toLowerCase() === printerName.toLowerCase());
                if (!printer) return sendJson(req, res, 404, { error: `Windows printer not found: ${printerName}` }, origin);
                const receipt = req.url === "/test"
                    ? `CAFE POS\nPRINTER TEST\n${printer.name}\n${new Date().toLocaleString()}\n\n\n`
                    : String(body.receipt || "");
                if (!receipt) return sendJson(req, res, 400, { error: "receipt is required." }, origin);
                if (usesWindowsDriver(printer)) await driverPrint(printer.name, receipt);
                else await rawPrint(printer.name, receipt);
                return sendJson(req, res, 200, { ok: true, printer: printer.name }, origin);
            }
            return sendJson(req, res, 404, { error: "Not found." }, origin);
        } catch (error) {
            console.error("Cafe POS printer bridge:", error);
            return sendJson(req, res, 500, { error: error.message || "Printer service error." }, origin);
        }
    });

    return new Promise((resolve, reject) => {
        server.once("error", error => {
            if (error.code === "EADDRINUSE") {
                console.warn(`Printer bridge port ${PORT} is already in use; using the installed local service.`);
                server = null;
                return resolve();
            }
            server = null;
            reject(error);
        });
        server.listen(PORT, HOST, () => {
            console.log(`Cafe POS Windows printer bridge listening on http://${HOST}:${PORT}`);
            resolve();
        });
    });
}

function stop() {
    if (!server) return;
    const current = server;
    server = null;
    current.close();
}

module.exports = { start, stop };
