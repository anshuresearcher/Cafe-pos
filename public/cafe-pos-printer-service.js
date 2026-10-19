// Slash POS Windows Printer Service
// Run on the Windows PC that has the printers installed:
//   node cafe-pos-printer-service.js
// The web POS calls http://127.0.0.1:18181

const http = require('http');
const { execFile } = require('child_process');

const PORT = 18181;
const ALLOWED_ORIGINS = new Set([
  'http://localhost',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'https://cafe-pos-six-gamma.vercel.app'
]);

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    // Send one encoded script so trailing data cannot be parsed as extra
    // PowerShell commands by Windows PowerShell.
    const quietScript = "$ProgressPreference = 'SilentlyContinue'\r\n" + script;
    const encodedScript = Buffer.from(quietScript, 'utf16le').toString('base64');
    execFile('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedScript
    ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const details = `${stderr || ''}\n${error.message || ''}`;
        const winError = details.match(/(?:Windows error|failed):\s*(\d+)/i)?.[1];
        const diagnostic = String(stderr || '')
          .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/#< CLIXML[\s\S]*?<\/Objs>/gi, ' ')
          .replace(/#< CLIXML[\s\S]*$/gi, ' ')
          .split(/\r?\n/).map(line => line.trim())
          .filter(line => line && !line.startsWith('At ') && !line.startsWith('+'))
          .slice(-2).join(' ').slice(0, 300);
        if (winError === '1801') return reject(new Error('Windows could not find that printer (error 1801). Refresh the printer list, select the installed printer again, then retry.'));
        if (winError === '5') return reject(new Error('Windows denied access to this printer. Check that your Windows account can print to it.'));
        if (!diagnostic && /Preparing modules for first use/i.test(stderr || '')) return reject(new Error('Windows printer support is initializing. Close and reopen the printer helper, then try printing again.'));
        return reject(new Error(diagnostic || 'Windows could not send the print job. Check that the selected printer is installed and online, then retry.'));
      }
      resolve(stdout.trim());
    });
  });
}

async function listPrinters() {
  const ps = `
    $items = Get-Printer | ForEach-Object {
      [PSCustomObject]@{
        name = $_.Name
        status = [string]$_.PrinterStatus
        shared = [bool]$_.Shared
        driver = [string]$_.DriverName
        port = [string]$_.PortName
      }
    }
    $items | ConvertTo-Json -Compress
  `;
  const output = await runPowerShell(ps);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function rawPrint(printerName, receipt) {
  const printer64 = Buffer.from(String(printerName), 'utf8').toString('base64');
  const receipt64 = Buffer.from(String(receipt), 'utf8').toString('base64');

  // Uses the Windows RAW spooler API. The selected printer must be installed in Windows.
  const ps = `
$printer = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${printer64}'))
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${receipt64}'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }
    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFO di);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
    public static void Send(string printer, byte[] bytes) {
        IntPtr h;
        if(!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Could not open printer. Windows error: " + Marshal.GetLastWin32Error());
        try {
            DOCINFO di = new DOCINFO(); di.pDocName = "Slash POS Receipt"; di.pDataType = "RAW";
            if(!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
            try {
                if(!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed: " + Marshal.GetLastWin32Error());
                try {
                    int written;
                    if(!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
                } finally { EndPagePrinter(h); }
            } finally { EndDocPrinter(h); }
        } finally { ClosePrinter(h); }
    }
}
'@
$bytes = [Text.Encoding]::UTF8.GetBytes($data)
# ESC/POS: initialize, center, print, feed, partial cut where supported.
$prefix = [byte[]](0x1B,0x40)
$suffix = [byte[]](0x0A,0x0A,0x0A,0x1D,0x56,0x00)
$payload = New-Object byte[] ($prefix.Length + $bytes.Length + $suffix.Length)
[Array]::Copy($prefix,0,$payload,0,$prefix.Length)
[Array]::Copy($bytes,0,$payload,$prefix.Length,$bytes.Length)
[Array]::Copy($suffix,0,$payload,$prefix.Length+$bytes.Length,$suffix.Length)
[RawPrinterHelper]::Send($printer, $payload)
'`;

  await runPowerShell(ps);
}

async function driverPrint(printerName, receipt) {
  const printer64 = Buffer.from(String(printerName), 'utf8').toString('base64');
  const receipt64 = Buffer.from(String(receipt), 'utf8').toString('base64');
  const ps = `
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
        document.DocumentName = "Slash POS Print Job";
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
  await runPowerShell(ps);
}

function usesWindowsDriver(printer) {
  return /pdf|xps|fax|onenote|dummy|generic.*text|text.only/i.test(`${printer?.name || ''} ${printer?.driver || ''}`);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, service: 'Slash POS Printer Service', port: PORT });
    }

    if (req.method === 'GET' && req.url === '/printers') {
      return send(res, 200, { printers: await listPrinters() });
    }

    if (req.method === 'POST' && (req.url === '/print' || req.url === '/test')) {
      const body = await readBody(req);
      const printerName = String(body.printerName || '').trim();
      if (!printerName) return send(res, 400, { error: 'printerName is required.' });

      const printers = await listPrinters();
      const printer = printers.find(p => p.name.toLowerCase() === printerName.toLowerCase());
      if (!printer) return send(res, 404, { error: `Windows printer not found: ${printerName}` });

      const receipt = req.url === '/test'
        ? `SLASH POS\nPRINTER TEST\n${printerName}\n${new Date().toLocaleString()}\n\n\n`
        : String(body.receipt || '');
      if (!receipt) return send(res, 400, { error: 'receipt is required.' });

      if (usesWindowsDriver(printer)) await driverPrint(printerName, receipt);
      else await rawPrint(printerName, receipt);
      return send(res, 200, { ok: true, printer: printerName });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error.message || 'Printer service error.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Slash POS Printer Service running at http://127.0.0.1:${PORT}`);
  console.log('Open http://127.0.0.1:18181/printers to verify Windows printer discovery.');
});
