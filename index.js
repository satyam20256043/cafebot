require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: '', // filled per-request from CAFE_SYSTEM_PROMPT
});

// ── Café context for Claude ──────────────────────────────────────────────────
const CAFE_SYSTEM_PROMPT = `You are CaféBot, the friendly AI assistant for The Brew Lab café.
You speak in a warm, casual, helpful tone. You can understand both English and Hinglish (Hindi-English mix).

Here is everything about The Brew Lab:

MENU:
☕ Hot Beverages:
- Espresso – ₹80
- Cappuccino – ₹120
- Latte – ₹130
- Americano – ₹100
- Masala Chai – ₹60
- Filter Coffee – ₹70

🥤 Cold Beverages:
- Cold Brew – ₹150
- Iced Latte – ₹140
- Mango Smoothie – ₹160
- Cold Coffee – ₹130

🍽️ Food:
- Croissant – ₹90
- Club Sandwich – ₹180
- Veg Pasta – ₹200
- Chocolate Brownie – ₹110
- Cheesecake (slice) – ₹150
- Banana Bread – ₹100

CURRENT OFFERS:
🎉 Happy Hours (3pm–6pm): 20% off all beverages
🎂 Birthday Special: Free slice of cake on your birthday (show ID)
☀️ Morning Combo (8am–11am): Any hot drink + croissant = ₹150

TIMINGS:
Monday–Friday: 8:00 AM – 10:00 PM
Saturday–Sunday: 9:00 AM – 11:00 PM

LOCATION:
The Brew Lab, IISER Tirupati Campus, Tirupati, Andhra Pradesh

TABLE BOOKING:
We accept table reservations! To book a table, we need:
1. Your name
2. Date and time
3. Number of people
If someone wants to book, collect these details and confirm the booking warmly.

RULES:
- Be concise — reply in 3–5 lines max unless showing full menu
- Use emojis naturally to keep it friendly
- If you don't know something, say "I'll check with our team and get back to you!"
- For payments/billing questions, direct them to the counter staff
- Always end table booking confirmations with: "See you at The Brew Lab! ☕"`;

// ── In-memory chat sessions (one per phone number) ───────────────────────────
// Gemini's startChat() keeps conversation history automatically.
const chatSessions = {};

function getOrCreateChat(phoneNumber) {
  if (!chatSessions[phoneNumber]) {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: CAFE_SYSTEM_PROMPT,
    });
    chatSessions[phoneNumber] = model.startChat({
      history: [],
      generationConfig: { maxOutputTokens: 512 },
    });
  }
  return chatSessions[phoneNumber];
}

// ── Send WhatsApp message ────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// ── Generate AI reply ────────────────────────────────────────────────────────
async function generateReply(phoneNumber, userMessage) {
  const chat = getOrCreateChat(phoneNumber);
  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

// ── Webhook verification (GET) ───────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── Incoming messages (POST) ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always return 200 immediately so Meta never pauses webhook delivery
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from = message.from;
    const text = message.text.body;

    console.log(`📩 Message from ${from}: ${text}`);

    try {
      const reply = await generateReply(from, text);
      await sendWhatsAppMessage(from, reply);
      console.log(`📤 Replied to ${from}: ${reply}`);
    } catch (aiErr) {
      console.error('❌ AI/Send error:', aiErr.message);
      try {
        await sendWhatsAppMessage(from, '☕ Hey! Our bot is taking a quick break. Please call us or visit The Brew Lab directly. We\'ll be back shortly!');
      } catch (fallbackErr) {
        console.error('❌ Fallback message failed:', fallbackErr.message);
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('☕ CaféBot is running!');
});

// ── Diagnostic endpoint (pass ?secret=cafebot_secret_42 to use) ──────────────
app.get('/diagnose', async (req, res) => {
  if (req.query.secret !== process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const report = {
    timestamp: new Date().toISOString(),
    env: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '✅ set (' + process.env.GEMINI_API_KEY.slice(0, 10) + '...)' : '❌ missing',
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN ? '✅ set (' + process.env.WHATSAPP_ACCESS_TOKEN.slice(0, 20) + '...)' : '❌ missing',
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '❌ missing',
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN ? '✅ set' : '❌ missing',
    },
    checks: {}
  };

  // 1. Test Gemini API
  try {
    const testModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const r = await testModel.generateContent('ping');
    report.checks.gemini = '✅ Working — response: ' + r.response.text().slice(0, 60);
  } catch (e) {
    report.checks.gemini = '❌ FAILED: ' + e.message;
  }

  // 2. Test WhatsApp token — check phone number details
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
    );
    report.checks.whatsapp_token = '✅ Valid — phone: ' + (r.data.display_phone_number || r.data.id);
  } catch (e) {
    report.checks.whatsapp_token = '❌ FAILED: ' + (e.response?.data?.error?.message || e.message);
  }

  // 3. Webhook subscription note
  report.checks.waba_subscription = 'ℹ️ Managed via Meta App Dashboard — not checked via API (requires System User token)';

  res.json(report);
});

// ── Test webhook simulate endpoint ───────────────────────────────────────────
app.post('/test-message', async (req, res) => {
  if (req.query.secret !== process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  try {
    const reply = await generateReply(phone, message);
    await sendWhatsAppMessage(phone, reply);
    res.json({ success: true, reply });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`☕ CaféBot server running on port ${PORT}`);
  console.log('ℹ️  Webhook subscription is managed via Meta App Dashboard.');
});

// ── Keep-alive ping (prevents Render free tier from sleeping) ─────────────────
const RENDER_URL = 'https://cafebot-qq2b.onrender.com';
setInterval(async () => {
  try {
    await axios.get(RENDER_URL);
    console.log('🔄 Keep-alive ping sent');
  } catch (err) {
    console.error('⚠️ Keep-alive ping failed:', err.message);
  }
}, 10 * 60 * 1000); // every 10 minutes
