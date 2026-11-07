import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const { LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, EASYSLIP_API_KEY } = process.env;

const missing = [
  ["LINE_CHANNEL_ACCESS_TOKEN", LINE_CHANNEL_ACCESS_TOKEN],
  ["LINE_CHANNEL_SECRET", LINE_CHANNEL_SECRET],
  ["EASYSLIP_API_KEY", EASYSLIP_API_KEY]
].filter(([, value]) => !value);

if (missing.length) {
  console.error("Missing environment variables:", missing.map(([key]) => key).join(", "));
  process.exit(1);
}

app.get("/", (_req, res) => res.status(200).send("LINE EasySlip webhook is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));

function verifyLineSignature(req) {
  const signature = req.get("x-line-signature");
  if (!signature || !req.rawBody) return false;
  const expected = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.rawBody).digest();
  try {
    const actual = Buffer.from(signature, "base64");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function replyLine(replyToken, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] })
  });
  if (!response.ok) console.error("LINE reply failed:", response.status, await response.text());
}

async function downloadLineImage(messageId) {
  const response = await fetch(
    `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
  );
  if (!response.ok) throw new Error(`LINE image download failed: ${response.status}`);
  const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0];
  const image = Buffer.from(await response.arrayBuffer());
  if (!image.length || image.length > 4 * 1024 * 1024) throw new Error("Image is empty or exceeds 4 MB");
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(contentType)) throw new Error("Unsupported image format");
  const ext = ({ "image/png": "png", "image/gif": "gif", "image/webp": "webp" })[contentType] || "jpg";
  return { image, contentType, filename: `slip.${ext}` };
}

async function verifySlip(file) {
  const form = new FormData();
  form.append("image", new Blob([file.image], { type: file.contentType }), file.filename);
  form.append("checkDuplicate", "true");
  form.append("matchAccount", "true");

  const response = await fetch("https://api.easyslip.com/v2/verify/bank", {
    method: "POST",
    headers: { Authorization: `Bearer ${EASYSLIP_API_KEY}` },
    body: form
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true || !result.data) {
    const error = new Error(result?.error?.message || "EasySlip could not verify this slip");
    error.code = result?.error?.code || `HTTP_${response.status}`;
    throw error;
  }
  return result.data;
}

async function processSlip(event) {
  try {
    const file = await downloadLineImage(event.message.id);
    const data = await verifySlip(file);

    if (data.isDuplicate) {
      await replyLine(event.replyToken,
        "⚠️ สลิปนี้เคยถูกส่งมาตรวจสอบแล้ว\nไม่รับยืนยันการชำระเงินซ้ำ กรุณาติดต่อร้านค้าหากต้องการให้ตรวจสอบเพิ่มเติม");
      return;
    }

    if (!data.matchedAccount) {
      await replyLine(event.replyToken,
        "⚠️ ยังยืนยันไม่ได้ว่าเงินเข้าบัญชีร้านค้า\nระบบอ่านข้อมูลสลิปได้ แต่บัญชีผู้รับไม่ตรงกับบัญชีที่ตั้งค่าไว้ จึงยังไม่ถือว่าชำระเงินสำเร็จ");
      return;
    }

    const amount = Number(data.amountInSlip);
    if (!Number.isFinite(amount) || amount <= 0) {
      await replyLine(event.replyToken,
        "❌ สลิปไม่ผ่านการตรวจสอบ\nไม่พบยอดเงินที่ถูกต้อง กรุณาตรวจสอบสลิปหรือติดต่อร้านค้า");
      return;
    }

    const receiver = data.matchedAccount.nameTh || data.matchedAccount.nameEn || "บัญชีร้านค้าที่ลงทะเบียน";
    const transRef = data.rawSlip?.transRef || "-";
    const date = data.rawSlip?.date ? new Date(data.rawSlip.date).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "-";

    await replyLine(event.replyToken,
      "✅ สลิปถูกต้อง ตรวจสอบ QR กับระบบธนาคารแล้ว\n" +
      `ยอดเงิน: ${amount.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท\n` +
      `บัญชีผู้รับ: ${receiver}\nวันที่: ${date}\nเลขอ้างอิง: ${transRef}\n\n` +
      "หมายเหตุ: โปรดตรวจสอบยอดกับคำสั่งซื้อก่อนส่งสินค้า");
  } catch (error) {
    console.error("Slip verification error:", error);
    if (error.code === "SLIP_NOT_FOUND") {
      await replyLine(event.replyToken,
        "❌ สลิปไม่ถูกต้อง หรือ QR Code อ่านไม่ได้\nระบบตรวจสอบไม่พบรายการโอนที่ยืนยันได้ จึงไม่รับสลิปนี้ กรุณาส่งภาพสลิปต้นฉบับที่ชัดเจนอีกครั้ง");
    } else {
      await replyLine(event.replyToken,
        "⚠️ ตรวจสอบสลิปไม่สำเร็จในขณะนี้\nยังสรุปไม่ได้ว่าสลิปถูกต้องหรือปลอม กรุณาลองใหม่อีกครั้ง หรือติดต่อร้านค้า");
    }
  }
}

app.post("/webhook/line", (req, res) => {
  if (!verifyLineSignature(req)) return res.status(401).send("Invalid LINE signature");
  res.status(200).send("OK");

  for (const event of req.body?.events || []) {
    if (event.type === "message" && event.message?.type === "image" && event.replyToken) {
      processSlip(event).catch(err => console.error("Unhandled slip event:", err));
    }
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Webhook listening on port ${PORT}`));
