# LINE EasySlip QR Slip Verification

## Render
- Build command: npm install
- Start command: npm start
- Node.js: 20+

## Environment variables (Render > Environment)
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- EASYSLIP_API_KEY

Never commit real API keys or tokens.

## LINE webhook URL
https://YOUR-RENDER-SERVICE.onrender.com/webhook/line

Set this URL in LINE Developers > Messaging API and enable Use webhook.

## Health check
https://YOUR-RENDER-SERVICE.onrender.com/health

## How verification works
When a user sends a slip image to the LINE Official Account, the server downloads the image from LINE and sends it to EasySlip API v2 /verify/bank. EasySlip reads and verifies the QR code in the image. Duplicate detection and receiver-account matching are enabled.

The bot replies with verified, duplicate, unable-to-confirm, or not-found status. A QR not found response can also mean an unclear/cropped image, so it is reported as not accepted rather than a definitive legal finding of fraud.

Important: receiver matching requires the shop's receiving bank account to be registered in EasySlip. This starter does not compare against an order-specific expected amount. Add order amount matching before using it as the sole basis for order fulfillment.
