CAFE POS - WINDOWS DIRECT PRINTING

1. Put these files on the Windows POS computer:
   - cafe-pos-printer-service.js
   - start-cafe-pos-printer-service.bat

2. Make sure Node.js is installed.

3. Double-click start-cafe-pos-printer-service.bat.

4. Open this in Chrome/Edge:
   http://127.0.0.1:18181/printers
   You should see JSON containing your Windows-installed printers.

5. In Cafe POS -> Printer:
   - Connection Type: Local computer printer
   - Refresh
   - Select your Windows printer
   - Use Selected
   - Save Printer
   - Tick Use as default bill printer
   - Test

6. Print Bill will now send the receipt directly to the selected Windows printer.
   The browser print dialog / popup is not used for the bill-print path.

IMPORTANT:
- USB, network and Bluetooth printers must first be installed/paired in Windows so they appear in Windows Printers & scanners.
- This service prints RAW ESC/POS data. It is intended for thermal receipt printers.
- If a printer does not support RAW/ESC-POS, use the existing network printer method or Windows driver printing.
