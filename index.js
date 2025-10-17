// index.js
// npm i node-telegram-bot-api dotenv
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID);
if (!token || !ADMIN_ID) {
  console.error('❗ .env da BOT_TOKEN va ADMIN_CHAT_ID ni to‘ldiring.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ================== Fayl bazasi (contacts.json, legacy format + username) ==================
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const LEGACY_DB_PATH = path.join(__dirname, 'db.json');

const BUTTON_REQUEST = '✍️ Murojaat yuborish';

const normUsername = (u) => {
  if (!u) return '';
  const s = String(u).trim();
  return !s ? '' : (s.startsWith('@') ? s : '@' + s);
};

// Yakuniy saqlash formati:
// "12345": { userId: 12345, firstName: "Ism Familya", phoneNumber: "99890...", username: "@user", updatedAt: ISO }
function asLegacyUser(userId, src = {}, from = {}) {
  const keyId = Number(userId);
  const first = [from.first_name, from.last_name].filter(Boolean).join(' ');
  // allaqachon legacy bo'lsa
  if ('userId' in src && 'phoneNumber' in src) {
    return {
      userId: src.userId ?? keyId,
      firstName: src.firstName ?? first,
      phoneNumber: src.phoneNumber ?? '',
      username: normUsername(src.username ?? from.username),
      updatedAt: src.updatedAt ?? new Date().toISOString(),
    };
  }
  // yangi formatdan o'tkazish
  if ('phone' in src) {
    return {
      userId: keyId,
      firstName: first,
      phoneNumber: String(src.phone || '').replace(/^\+/, ''),
      username: normUsername(from.username),
      updatedAt: new Date().toISOString(),
    };
  }
  // bo'sh
  return {
    userId: keyId,
    firstName: first,
    phoneNumber: '',
    username: normUsername(from.username),
    updatedAt: new Date().toISOString(),
  };
}

function tryReadJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function loadDB() {
  // 1) contacts.json
  let parsed = tryReadJSON(CONTACTS_PATH);
  if (parsed && typeof parsed === 'object') {
    const normalized = { users: {}, requests: Array.isArray(parsed.requests) ? parsed.requests : [] };
    if (parsed.users && typeof parsed.users === 'object') {
      for (const [id, u] of Object.entries(parsed.users)) {
        normalized.users[String(id)] = asLegacyUser(id, u);
      }
    }
    return normalized;
  }
  // 2) db.json -> migratsiya
  parsed = tryReadJSON(LEGACY_DB_PATH);
  if (parsed && typeof parsed === 'object') {
    const migrated = { users: {}, requests: Array.isArray(parsed.requests) ? parsed.requests : [] };
    if (parsed.users && typeof parsed.users === 'object') {
      for (const [id, u] of Object.entries(parsed.users)) {
        migrated.users[String(id)] = asLegacyUser(id, u);
      }
    }
    fs.writeFileSync(CONTACTS_PATH, JSON.stringify(migrated, null, 2), 'utf8');
    console.log('ℹ️ db.json → contacts.json ga migratsiya qilindi.');
    return migrated;
  }
  // 3) bo'sh
  return { users: {}, requests: [] };
}

function saveDB(db) {
  const out = { users: {}, requests: Array.isArray(db.requests) ? db.requests : [] };
  for (const [id, u] of Object.entries(db.users || {})) {
    out.users[String(id)] = asLegacyUser(id, u);
  }
  fs.writeFileSync(CONTACTS_PATH, JSON.stringify(out, null, 2), 'utf8');
}

let DB = loadDB();

// ================== Sessiya holati (RAM, faylga yozilmaydi) ==================
const STATE = Object.create(null); // { [chatId]: { awaitingRequest: boolean } }

// ================== Util ==================
const PAGE_SIZE = 10;
const formatTime = (d = new Date()) => new Date(d).toLocaleString('uz-UZ', { hour12: false });

// Markdown (legacy) uchun minimal xavfsiz escape
function mdEscape(input) {
  if (input === null || input === undefined) return '';
  const s = String(input);
  // Escape: _ * [ ] ( )
  return s.replace(/([_*\[\]()])/g, '\\$1');
}

function ensureUser(userId, fromMeta) {
  const key = String(userId);
  if (!DB.users[key]) DB.users[key] = asLegacyUser(userId, {}, fromMeta);
}
function userLine(userId, fromMeta) {
  const key = String(userId);
  const u = DB.users[key] || asLegacyUser(userId, {}, fromMeta);
  const firstName = mdEscape(u.firstName || 'Noma’lum');
  const username = mdEscape(u.username || '—');
  const phone = mdEscape(u.phoneNumber || '—');
  return `👤 *Foydalanuvchi:* ${firstName}
🔗 *Username:* ${username}
☎️ *Telefon:* ${phone}
🆔 *UserID:* \`${u.userId}\``;
}
function paginate(list, page) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  return { slice, p, pages, total };
}

// ================== Admin menyu ==================
function adminMenuKeyboard() {
  const totalReq = Array.isArray(DB.requests) ? DB.requests.length : 0;
  const totalPhones = Object.values(DB.users || {}).filter(u => u && u.phoneNumber).length;
  return {
    inline_keyboard: [
      [{ text: `📨 Murojaatlar (${totalReq})`, callback_data: 'admin:reqs:0' }],
      [{ text: `📞 Telefonlar (${totalPhones})`, callback_data: 'admin:phones:0' }],
      [{ text: '🔄 CSV eksport', callback_data: 'admin:export' }],
      [{ text: '🔍 ID bo‘yicha qidirish', callback_data: 'admin:search' }],
    ],
  };
}
async function renderAdminHome(chatId, messageId = null) {
  const text = "🛠 *Admin menyu*\nBo‘limni tanlang:";
  const opts = { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() };
  if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  return bot.sendMessage(chatId, text, opts);
}
function adminRequestsText(page = 0) {
  const arr = [...(DB.requests || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const { slice, p, pages, total } = paginate(arr, page);
  if (!total) return { text: "📨 Murojaatlar yo‘q.", p, pages };
  let out = `📨 *Murojaatlar* (jami: ${total}) — *${p + 1}/${pages}*\n\n`;
  slice.forEach((r, idx) => {
    out += `*#${p * PAGE_SIZE + idx + 1}* | 🕒 ${formatTime(r.at)}\n`;
    const first = [r.from?.first_name, r.from?.last_name].filter(Boolean).join(' ');
    const username = normUsername(r.from?.username || '');
    const phone = r.phone || (DB.users?.[String(r.userId)]?.phoneNumber || '');
    out += `👤 *Foydalanuvchi:* ${mdEscape(first || 'Noma’lum')}\n`;
    out += `🔗 *Username:* ${mdEscape(username || '—')}\n`;
    out += `☎️ *Telefon:* ${mdEscape(phone || '—')}\n`;
    out += `🆔 *UserID:* \`${r.userId}\`\n`;
    const safeText = mdEscape(r.text || '');
    out += `✉️ *Matn:* ${safeText}\n`;
    if (r.media) out += `📎 Media: ${r.media.type} (${r.media.file_id})\n`;
    out += `— — —\n`;
  });
  return { text: out.trim(), p, pages };
}
function adminPhonesText(page = 0) {
  const list = Object.values(DB.users || {}).filter(u => u && u.phoneNumber);
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const { slice, p, pages, total } = paginate(list, page);
  if (!total) return { text: "📞 Telefonlar ro‘yxati bo‘sh.", p, pages };
  let out = `📞 *Telefonlar* (jami: ${total}) — *${p + 1}/${pages}*\n\n`;
  slice.forEach((u, idx) => {
    out += `*#${p * PAGE_SIZE + idx + 1}* | 🕒 ${formatTime(u.updatedAt)}\n`;
    out += `🆔 \`${u.userId}\`\n`;
    out += `👤 ${mdEscape(u.firstName || '—')}\n`;
    out += `🔗 ${mdEscape(u.username || '—')}\n`;
    out += `☎️ ${mdEscape(u.phoneNumber)}\n`;
    out += `— — —\n`;
  });
  return { text: out.trim(), p, pages };
}
function navKeyboard(base, p, pages) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '◀️ Oldingi', callback_data: `${base}:${Math.max(0, p - 1)}` },
          { text: '▶️ Keyingi', callback_data: `${base}:${Math.min(pages - 1, p + 1)}` },
        ],
        [{ text: '🏠 Menyu', callback_data: 'admin:home' }],
      ],
    },
  };
}

// ================== /start ==================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId, msg.from);
  saveDB(DB);
  STATE[chatId] = { awaitingRequest: false };

  if (msg.from.id === ADMIN_ID) {
    return bot.sendMessage(chatId, "👨‍💼 Admin paneliga xush kelibsiz!\nMenyu uchun /menu ni bosing.", {
      reply_markup: { remove_keyboard: true },
    });
  }

  await bot.sendMessage(
    chatId,
    "Assalomu alaykum! 👋\nBotdan foydalanish uchun avval telefon raqamingizni ulashing.",
    {
      reply_markup: {
        keyboard: [[{ text: '📱 Telefon raqamni ulashish', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
});

// ================== /menu (admin) ==================
bot.onText(/^\/menu$/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  await renderAdminHome(msg.chat.id);
});

// ================== callback_query (admin) ==================
bot.on('callback_query', async (cq) => {
  const data = cq.data || '';
  const chatId = cq.message?.chat?.id;
  if (!chatId) return;

  if (cq.from.id !== ADMIN_ID) {
    return bot.answerCallbackQuery(cq.id, { text: 'Faqat admin uchun.', show_alert: true });
  }

  if (data === 'admin:home') {
    await renderAdminHome(chatId, cq.message.message_id);
    return bot.answerCallbackQuery(cq.id);
  }

  const m = data.match(/^admin:(reqs|phones):(\d+)$/);
  if (m) {
    const section = m[1];
    const page = Number(m[2]) || 0;
    if (section === 'reqs') {
      const { text, p, pages } = adminRequestsText(page);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: cq.message.message_id,
        parse_mode: 'Markdown',
        ...navKeyboard('admin:reqs', p, pages),
      });
    } else {
      const { text, p, pages } = adminPhonesText(page);
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: cq.message.message_id,
        parse_mode: 'Markdown',
        ...navKeyboard('admin:phones', p, pages),
      });
    }
    return bot.answerCallbackQuery(cq.id);
  }

  if (data === 'admin:export') {
    try {
      const exportDir = path.join(__dirname, 'exports');
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      const phones = [['user_id', 'first_name', 'username', 'phone_number', 'updated_at']];
      for (const u of Object.values(DB.users || {})) {
        if (u && u.phoneNumber) phones.push([u.userId, u.firstName || '', u.username || '', u.phoneNumber, u.updatedAt || '']);
      }
      fs.writeFileSync(path.join(exportDir, `phones_${stamp}.csv`), toCSV(phones), 'utf8');

      const reqRows = [['request_id', 'user_id', 'time', 'phone', 'text']];
      for (const r of (DB.requests || [])) {
        reqRows.push([r.id, r.userId, r.at, r.phone || '', (r.text || '').replace(/\r?\n/g, ' ')]);
      }
      fs.writeFileSync(path.join(exportDir, `requests_${stamp}.csv`), toCSV(reqRows), 'utf8');

      await bot.sendDocument(ADMIN_ID, path.join(exportDir, `phones_${stamp}.csv`), { caption: '📞 Telefonlar CSV' });
      await bot.sendDocument(ADMIN_ID, path.join(exportDir, `requests_${stamp}.csv`), { caption: '📨 Murojaatlar CSV' });

      await bot.answerCallbackQuery(cq.id, { text: 'CSV fayllar yuborildi.' });
    } catch (e) {
      console.error('CSV export error:', e);
      await bot.answerCallbackQuery(cq.id, { text: 'Xato: CSV eksportda muammo.', show_alert: true });
    }
    return;
  }

  if (data === 'admin:search') {
    await bot.answerCallbackQuery(cq.id);
    return bot.sendMessage(chatId, "🔍 Qidirish: iltimos *UserID* (raqam) yuboring.", { parse_mode: 'Markdown' });
  }

  await bot.answerCallbackQuery(cq.id);
});

// ================== CSV helper ==================
function toCSV(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

// ================== Kontakt (foydalanuvchi) ==================
bot.on('contact', async (msg) => {
  if (msg.from.id === ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "Admin sifatida kontakt ulashingiz shart emas.", {
      reply_markup: { remove_keyboard: true },
    });
  }

  const chatId = msg.chat.id;
  if (!msg.contact || msg.contact.user_id !== msg.from.id) {
    return bot.sendMessage(
      chatId,
      "Iltimos, *o‘zingizga tegishli* telefon raqamini '📱 Telefon raqamni ulashish' tugmasi bilan jo‘nating.",
      { parse_mode: 'Markdown' }
    );
  }

  const key = String(chatId);
  DB.users[key] = asLegacyUser(chatId, {
    userId: chatId,
    firstName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    phoneNumber: String(msg.contact.phone_number || '').replace(/^\+/, ''),
    username: normUsername(msg.from.username || ''),
    updatedAt: new Date().toISOString(),
  }, msg.from);
  saveDB(DB);

  // flagni tozalaymiz
  STATE[chatId] = { awaitingRequest: false };

  // Adminga xabar
  const first = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  const username = normUsername(msg.from.username || '');
  const phone = DB.users[key]?.phoneNumber || '';
  const contactAdminMsg =
    `🆕 *Yangi kontakt ulashildi*\n` +
    `👤 *Foydalanuvchi:* ${mdEscape(first || 'Noma’lum')}\n` +
    `🔗 *Username:* ${mdEscape(username || '—')}\n` +
    `☎️ *Telefon:* ${mdEscape(phone || '—')}\n` +
    `🆔 *UserID:* \`${msg.from.id}\`\n` +
    `🕒 ${formatTime()}`;
  await bot.sendMessage(ADMIN_ID, contactAdminMsg, { parse_mode: 'Markdown' });

  // Foydalanuvchiga tugma chiqaramiz
  await bot.sendMessage(chatId, "Rahmat! ✅ Endi murojaatingizni yuborishingiz mumkin.", {
    reply_markup: { keyboard: [[BUTTON_REQUEST]], resize_keyboard: true },
  });
});

// ================== Xabarlar (faqat foydalanuvchi oqimi) ==================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const typedText = (msg.text || '').trim();
  const content = (msg.text || msg.caption || '').trim();

  // Kontakt/komanda qayta ishlanmaydi
  if (msg.contact || (typedText && typedText.startsWith('/'))) return;

  // ADMIN uchun bu handler emas
  if (msg.from.id === ADMIN_ID) return;

  const key = String(chatId);
  const u = DB.users[key];

  // 1) Telefon bermagan bo‘lsa — avval telefon
  if (!u || !u.phoneNumber) {
    return bot.sendMessage(chatId,
      "Avval telefon raqamingizni ulashing, keyin murojaat yuborishingiz mumkin.",
      {
        reply_markup: {
          keyboard: [[{ text: '📱 Telefon raqamni ulashish', request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true,
        },
      }
    );
  }

  // 2) Tugma bosish — yumshoq tekshiruv
  const isRequestBtn = typedText === BUTTON_REQUEST || /murojaat/i.test(typedText);
  if (isRequestBtn) {
    STATE[chatId] = { awaitingRequest: true };
    return bot.sendMessage(
      chatId,
      "Iltimos, murojaatingizni *batafsil* yozib yuboring.",
      { parse_mode: 'Markdown' }
    );
  }

  // 3) Murojaat faqat flag yoqilgan bo‘lsa qabul qilinadi
  if (!STATE[chatId]?.awaitingRequest) {
    return bot.sendMessage(
      chatId,
      `Murojaat yuborish uchun avval pastdagi *“${BUTTON_REQUEST}”* tugmasini bosing.`,
      { parse_mode: 'Markdown', reply_markup: { keyboard: [[BUTTON_REQUEST]], resize_keyboard: true } }
    );
  }

  // Bu haqiqiy murojaat — flagni o'chiramiz
  STATE[chatId].awaitingRequest = false;

  // media (ixtiyoriy)
  let media = null;
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    media = { type: 'photo', file_id: largest.file_id };
  } else if (msg.document) {
    media = { type: 'document', file_id: msg.document.file_id, name: msg.document.file_name };
  }

  // saqlash
  DB.requests = DB.requests || [];
  const phoneSnapshot = DB.users[key]?.phoneNumber || '';
  DB.requests.push({
    id: `${msg.from.id}-${Date.now()}`,
    userId: msg.from.id,
    text: content,
    at: new Date().toISOString(),
    media,
    phone: phoneSnapshot,
    from: {
      id: msg.from.id,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name,
      username: msg.from.username,
    },
  });
  // profilni (ism/username) yangilab qo'yamiz
  DB.users[key] = asLegacyUser(chatId, {
    userId: chatId,
    firstName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    phoneNumber: DB.users[key].phoneNumber || '',
    username: normUsername(msg.from.username || DB.users[key].username || ''),
    updatedAt: new Date().toISOString(),
  }, msg.from);
  saveDB(DB);

  // Admin ga yuboramiz
  const first = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  const username = normUsername(msg.from.username || '');
  const adminMsg =
    `📨 *Yangi murojaat!*\n` +
    `👤 *Foydalanuvchi:* ${mdEscape(first || 'Noma’lum')}\n` +
    `🔗 *Username:* ${mdEscape(username || '—')}\n` +
    `☎️ *Telefon:* ${mdEscape(phoneSnapshot || '—')}\n` +
    `🆔 *UserID:* \`${msg.from.id}\`\n\n` +
    `✉️ *Matn:*\n${mdEscape(content)}\n\n` +
    `🕒 ${formatTime()}`;
  await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown' });
  if (media) {
    if (media.type === 'photo') await bot.sendPhoto(ADMIN_ID, media.file_id, { caption: '📎 Rasm ilova' });
    else await bot.sendDocument(ADMIN_ID, media.file_id, {}, { filename: media.name || 'file' });
  }

  // Telefonni qayta talab qilish uchun bazadan olib tashlaymiz
  if (DB.users[key]) {
    DB.users[key].phoneNumber = '';
    DB.users[key].updatedAt = new Date().toISOString();
    saveDB(DB);
  }

  // Foydalanuvchiga tasdiq
  return bot.sendMessage(chatId, "✅ Murojaatingiz qabul qilindi! Keyingi murojaat uchun qayta telefon raqamingizni ulashing.", {
    reply_markup: {
      keyboard: [[{ text: '📱 Telefon raqamni ulashish', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
});

// ================== Xatolar ==================
bot.on('polling_error', (err) => console.error('Polling error:', err?.message || err));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
// Fayl eng pastiga (bot.on('polling_error', ...) dan keyin joylashtiring)
process.on('SIGINT', () => {
    console.log('\n♻️ Bot qayta ishga tushmoqda...');
    setTimeout(() => {
      process.exit(0);
    }, 500);
  });

