# Cafe POS – Profile + Billing Interaction Fix

This update keeps the existing Step 1–19 Cafe POS modules and focuses on the latest UI issues:

- Added Cafe Pilot-style staff profile button and slide-out profile panel.
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


## QR menu app installs and customer notifications

- Serve the POS and guest QR menu over HTTPS in production. Browser app installation and Web Push require a secure origin; localhost is allowed for local development.
- Install server dependencies with `npm install`.
- Generate a VAPID key pair with `npx web-push generate-vapid-keys --json`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the server environment. Keep the private key server-side and reuse the same pair after deployment.
- Guests can install the cafe menu app or opt in to Get offers from the QR menu. POS users can compose and send messages from Marketing > Customer notifications.
- The existing startup migration creates tenant-scoped subscription and campaign tables.
