# Cafe POS – Profile + Billing Interaction Fix

This update keeps the existing Step 1–19 Cafe POS modules and focuses on the latest UI issues:

- Added Rista-style staff profile button and slide-out profile panel.
- Removed decorative circular/bullet markers from billing category buttons.
- Fixed billing category sidebar so categories are real clickable controls backed by database menu categories.
- Removed the visible table dropdown from billing and replaced it with clickable database-driven table cards.
- Table cards show Available (green), Occupied (yellow), Reserved (red) and selected state.
- Kept the hidden `tableNumber` field for backward compatibility with existing order/payment code.
- Billing menu and categories are rendered from `/api/menu`; hard-coded billing items/categories are no longer used by the active UI.
- Added keyboard activation for menu cards.

Run with the existing project setup:
1. `npm install`
2. `node server.js`
3. Open the Cafe POS and hard refresh with `Ctrl + Shift + R`.
