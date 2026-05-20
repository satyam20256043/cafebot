require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── In-memory conversation store ─────────────────────────────────────────────
const conversations = {};

function getHistory(phoneNumber) {
  if (!conversations[phoneNumber]) conversations[phoneNumber] = [];
  return conversations[phoneNumber];
}

function addToHistory(phoneNumber, role, content) {
  const history = getHistory(phoneNumber);
  history.push({ role, content });
  // Keep last 20 messages to avoid token overflow
  if (history.length > 20) history.splice(0, history.length - 20);
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
  addToHistory(phoneNumber, 'user', userMessage);
  const history = getHistory(phoneNumber);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: CAFE_SYSTEM_PROMPT,
    messages: history
  });

  const reply = response.content[0].text;
  addToHistory(phoneNumber, 'assistant', reply);
  return reply;
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
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== 'text') return res.sendStatus(200);

    const from = message.from;
    const text = message.text.body;

    console.log(`📩 Message from ${from}: ${text}`);

    // Generate and send AI reply
    const reply = await generateReply(from, text);
    await sendWhatsAppMessage(from, reply);

    console.log(`📤 Replied to ${from}: ${reply}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error handling message:', err.message);
    res.sendStatus(500);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('☕ CaféBot is running!');
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`☕ CaféBot server running on port ${PORT}`);
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
