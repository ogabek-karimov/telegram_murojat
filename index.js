// index.js
// npm i node-telegram-bot-api dotenv
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const token = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID);
if (!token || !ADMIN_ID) {
  console.error("❗ .env da BOT_TOKEN va ADMIN_CHAT_ID ni to‘ldiring.");
  process.exit(1);
}

// ================== Single instance guard (avoid 409 getUpdates conflict) ==================
const LOCK_PATH = path.join(__dirname, ".bot.lock");

function isProcessRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return false;
  }
}

function acquireSingleInstanceLock() {
  try {
    // Try exclusive create; fails if file exists
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e && e.code === "EEXIST") {
      try {
        const existingPidStr = fs.readFileSync(LOCK_PATH, "utf8").trim();
        const existingPid = Number(existingPidStr);
        if (!isProcessRunning(existingPid)) {
          // Stale lock — remove and retry once
          fs.unlinkSync(LOCK_PATH);
          return acquireSingleInstanceLock();
        }
      } catch (_) {
        /* ignore and treat as active */
      }
      console.error(
        "❗ Boshqa bot instansiyasi ishlayapti (lock mavjud). Bu nusxa chiqadi."
      );
      process.exit(0);
    }
    throw e;
  }
}

function releaseSingleInstanceLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (_) {
    /* ignore */
  }
}

acquireSingleInstanceLock();
process.on("exit", releaseSingleInstanceLock);
process.on("SIGTERM", () => {
  releaseSingleInstanceLock();
  process.exit(0);
});
process.on("SIGINT", () => {
  releaseSingleInstanceLock(); /* other SIGINT handlers may follow */
});

const bot = new TelegramBot(token, { polling: { autoStart: false } });

// ================== Fayl bazasi (contacts.json, legacy format + username) ==================
const CONTACTS_PATH = path.join(__dirname, "contacts.json");
const LEGACY_DB_PATH = path.join(__dirname, "db.json");

const BUTTON_COMPOSE = "✍️ Murojaatni yozing";
const BUTTON_SUBMIT = "📨 Murojaatni yuborish";

const normUsername = (u) => {
  if (!u) return "";
  const s = String(u).trim();
  return !s ? "" : s.startsWith("@") ? s : "@" + s;
};

// Yakuniy saqlash formati:
// "12345": { userId: 12345, firstName: "Ism Familya", phoneNumber: "99890...", username: "@user", updatedAt: ISO }
function asLegacyUser(userId, src = {}, from = {}) {
  const keyId = Number(userId);
  const first = [from.first_name, from.last_name].filter(Boolean).join(" ");
  // allaqachon legacy bo'lsa
  if ("userId" in src && "phoneNumber" in src) {
    return {
      userId: src.userId ?? keyId,
      firstName: src.firstName ?? first,
      phoneNumber: src.phoneNumber ?? "",
      username: normUsername(src.username ?? from.username),
      updatedAt: src.updatedAt ?? new Date().toISOString(),
    };
  }
  // yangi formatdan o'tkazish
  if ("phone" in src) {
    return {
      userId: keyId,
      firstName: first,
      phoneNumber: String(src.phone || "").replace(/^\+/, ""),
      username: normUsername(from.username),
      updatedAt: new Date().toISOString(),
    };
  }
  // bo'sh
  return {
    userId: keyId,
    firstName: first,
    phoneNumber: "",
    username: normUsername(from.username),
    updatedAt: new Date().toISOString(),
  };
}

function tryReadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadDB() {
  // 1) contacts.json
  let parsed = tryReadJSON(CONTACTS_PATH);
  if (parsed && typeof parsed === "object") {
    const normalized = {
      users: {},
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
    };
    if (parsed.users && typeof parsed.users === "object") {
      for (const [id, u] of Object.entries(parsed.users)) {
        normalized.users[String(id)] = asLegacyUser(id, u);
      }
    }
    return normalized;
  }
  // 2) db.json -> migratsiya
  parsed = tryReadJSON(LEGACY_DB_PATH);
  if (parsed && typeof parsed === "object") {
    const migrated = {
      users: {},
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
    };
    if (parsed.users && typeof parsed.users === "object") {
      for (const [id, u] of Object.entries(parsed.users)) {
        migrated.users[String(id)] = asLegacyUser(id, u);
      }
    }
    fs.writeFileSync(CONTACTS_PATH, JSON.stringify(migrated, null, 2), "utf8");
    console.log("ℹ️ db.json → contacts.json ga migratsiya qilindi.");
    return migrated;
  }
  // 3) bo'sh
  return { users: {}, requests: [] };
}

function saveDB(db) {
  const out = {
    users: {},
    requests: Array.isArray(db.requests) ? db.requests : [],
  };
  for (const [id, u] of Object.entries(db.users || {})) {
    out.users[String(id)] = asLegacyUser(id, u);
  }
  fs.writeFileSync(CONTACTS_PATH, JSON.stringify(out, null, 2), "utf8");
}

let DB = loadDB();

// ================== Sessiya holati (RAM, faylga yozilmaydi) ==================
// Foydalanuvchi uchun: composing (draft holati), draft (matn), media (so'nggi media)
const STATE = Object.create(null); // { [chatId]: { composing: boolean, draft: string, media: {type,file_id,name?}|null } }
// Admin uchun: qidirish holati
const ADMIN_STATE = Object.create(null); // { [chatId]: { awaitingSearch: boolean } }

// ================== Util ==================
const PAGE_SIZE = 10;
const formatTime = (d = new Date()) =>
  new Date(d).toLocaleString("uz-UZ", { hour12: false });

// Markdown (legacy) uchun minimal xavfsiz escape
function mdEscape(input) {
  if (input === null || input === undefined) return "";
  const s = String(input);
  // Escape: _ * [ ] ( )
  return s.replace(/([_*\[\]()])/g, "\\$1");
}

function ensureUser(userId, fromMeta) {
  const key = String(userId);
  if (!DB.users[key]) DB.users[key] = asLegacyUser(userId, {}, fromMeta);
}
function userLine(userId, fromMeta) {
  const key = String(userId);
  const u = DB.users[key] || asLegacyUser(userId, {}, fromMeta);
  const firstName = mdEscape(u.firstName || "Noma’lum");
  const username = mdEscape(u.username || "—");
  const phone = mdEscape(u.phoneNumber || "—");
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
  const totalPhones = Object.values(DB.users || {}).filter(
    (u) => u && u.phoneNumber
  ).length;
  return {
    inline_keyboard: [
      [{ text: `📨 Murojaatlar (${totalReq})`, callback_data: "admin:reqs:0" }],
      [
        {
          text: `📞 Telefonlar (${totalPhones})`,
          callback_data: "admin:phones:0",
        },
      ],
      [{ text: "🔄 CSV eksport", callback_data: "admin:export" }],
      [{ text: "🔍 ID bo‘yicha qidirish", callback_data: "admin:search" }],
    ],
  };
}
function adminReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "📨 Murojaatlar" }, { text: "📞 Telefonlar" }],
      [{ text: "🔄 CSV eksport" }, { text: "🔍 Qidirish" }],
    ],
    resize_keyboard: true,
  };
}
async function renderAdminHome(chatId, messageId = null) {
  const text = "🛠 *Admin menyu*\nBo‘limni tanlang:";
  const opts = { parse_mode: "Markdown", reply_markup: adminMenuKeyboard() };
  if (messageId)
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...opts,
    });
  return bot.sendMessage(chatId, text, opts);
}
function adminRequestsText(page = 0) {
  const arr = [...(DB.requests || [])].sort(
    (a, b) => new Date(b.at) - new Date(a.at)
  );
  const { slice, p, pages, total } = paginate(arr, page);
  if (!total) return { text: "📨 Murojaatlar yo‘q.", p, pages };
  let out = `📨 *Murojaatlar* (jami: ${total}) — *${p + 1}/${pages}*\n\n`;
  slice.forEach((r, idx) => {
    out += `*#${p * PAGE_SIZE + idx + 1}* | 🕒 ${formatTime(r.at)}\n`;
    const first = [r.from?.first_name, r.from?.last_name]
      .filter(Boolean)
      .join(" ");
    const username = normUsername(r.from?.username || "");
    const phone = r.phone || DB.users?.[String(r.userId)]?.phoneNumber || "";
    out += `👤 *Foydalanuvchi:* ${mdEscape(first || "Noma’lum")}\n`;
    out += `🔗 *Username:* ${mdEscape(username || "—")}\n`;
    out += `☎️ *Telefon:* ${mdEscape(phone || "—")}\n`;
    out += `🆔 *UserID:* \`${r.userId}\`\n`;
    const safeText = mdEscape(r.text || "");
    out += `✉️ *Matn:* ${safeText}\n`;
    if (r.media) out += `📎 Media: ${r.media.type} (${r.media.file_id})\n`;
    out += `— — —\n`;
  });
  return { text: out.trim(), p, pages };
}
function adminPhonesText(page = 0) {
  const list = Object.values(DB.users || {}).filter((u) => u && u.phoneNumber);
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const { slice, p, pages, total } = paginate(list, page);
  if (!total) return { text: "📞 Telefonlar ro‘yxati bo‘sh.", p, pages };
  let out = `📞 *Telefonlar* (jami: ${total}) — *${p + 1}/${pages}*\n\n`;
  slice.forEach((u, idx) => {
    out += `*#${p * PAGE_SIZE + idx + 1}* | 🕒 ${formatTime(u.updatedAt)}\n`;
    out += `🆔 \`${u.userId}\`\n`;
    out += `👤 ${mdEscape(u.firstName || "—")}\n`;
    out += `🔗 ${mdEscape(u.username || "—")}\n`;
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
          {
            text: "◀️ Oldingi",
            callback_data: `${base}:${Math.max(0, p - 1)}`,
          },
          {
            text: "▶️ Keyingi",
            callback_data: `${base}:${Math.min(pages - 1, p + 1)}`,
          },
        ],
        [{ text: "🏠 Menyu", callback_data: "admin:home" }],
      ],
    },
  };
}

// ================== /start ==================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  ensureUser(chatId, msg.from);
  saveDB(DB);
  STATE[chatId] = { composing: false, draft: "", media: null };

  if (msg.from.id === ADMIN_ID) {
    await bot.sendMessage(chatId, "👨‍💼 Admin paneliga xush kelibsiz!", {
      reply_markup: adminReplyKeyboard(),
    });
    return renderAdminHome(chatId);
  }

  await bot.sendMessage(
    chatId,
    "Assalomu alaykum! 👋\nBotdan foydalanish uchun avval telefon raqamingizni ulashing.",
    {
      reply_markup: {
        keyboard: [
          [{ text: "📱 Telefon raqamni ulashish", request_contact: true }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
});

// ================== /menu (admin) ==================
bot.onText(/^\/menu$/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  await bot.sendMessage(msg.chat.id, "🛠 Admin menyu", {
    reply_markup: adminReplyKeyboard(),
  });
  await renderAdminHome(msg.chat.id);
});

// ================== callback_query (admin) ==================
bot.on("callback_query", async (cq) => {
  const data = cq.data || "";
  const chatId = cq.message?.chat?.id;
  if (!chatId) return;

  if (cq.from.id !== ADMIN_ID) {
    return bot.answerCallbackQuery(cq.id, {
      text: "Faqat admin uchun.",
      show_alert: true,
    });
  }

  if (data === "admin:home") {
    await renderAdminHome(chatId, cq.message.message_id);
    return bot.answerCallbackQuery(cq.id);
  }

  // Delete request
  const mDelReq = data.match(/^admin:delreq:([^:]+):(\d+)$/);
  if (mDelReq) {
    const reqId = mDelReq[1];
    const page = Number(mDelReq[2]) || 0;
    const idx = (DB.requests || []).findIndex((r) => r.id === reqId);
    if (idx !== -1) {
      DB.requests.splice(idx, 1);
      saveDB(DB);
    }
    // Re-render current page
    const arr = [...(DB.requests || [])].sort(
      (a, b) => new Date(b.at) - new Date(a.at)
    );
    const { slice, p, pages } = paginate(arr, page);
    const { text } = adminRequestsText(p);
    const inline_keyboard = [
      [
        {
          text: "◀️ Oldingi",
          callback_data: `admin:reqs:${Math.max(0, p - 1)}`,
        },
        {
          text: "▶️ Keyingi",
          callback_data: `admin:reqs:${Math.min(pages - 1, p + 1)}`,
        },
      ],
      ...slice.map((it, idx2) => [
        {
          text: `🗑 #${p * PAGE_SIZE + idx2 + 1}`,
          callback_data: `admin:delreq:${it.id}:${p}`,
        },
      ]),
      [{ text: "🏠 Menyu", callback_data: "admin:home" }],
    ];
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: cq.message.message_id,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard },
    });
    return bot.answerCallbackQuery(cq.id, { text: "Murojaat o'chirildi." });
  }

  // Delete phone (clear phone number)
  const mDelPhone = data.match(/^admin:delphone:(\d+):(\d+)$/);
  if (mDelPhone) {
    const userIdStr = mDelPhone[1];
    const page = Number(mDelPhone[2]) || 0;
    if (DB.users?.[userIdStr]) {
      DB.users[userIdStr].phoneNumber = "";
      DB.users[userIdStr].updatedAt = new Date().toISOString();
      saveDB(DB);
    }
    const list = Object.values(DB.users || {}).filter(
      (u) => u && u.phoneNumber
    );
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const { slice, p, pages } = paginate(list, page);
    const { text } = adminPhonesText(p);
    const inline_keyboard = [
      [
        {
          text: "◀️ Oldingi",
          callback_data: `admin:phones:${Math.max(0, p - 1)}`,
        },
        {
          text: "▶️ Keyingi",
          callback_data: `admin:phones:${Math.min(pages - 1, p + 1)}`,
        },
      ],
      ...slice.map((u, idx2) => [
        {
          text: `🗑 #${p * PAGE_SIZE + idx2 + 1}`,
          callback_data: `admin:delphone:${u.userId}:${p}`,
        },
      ]),
      [{ text: "🏠 Menyu", callback_data: "admin:home" }],
    ];
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: cq.message.message_id,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard },
    });
    return bot.answerCallbackQuery(cq.id, { text: "Telefon o'chirildi." });
  }

  const m = data.match(/^admin:(reqs|phones):(\d+)$/);
  if (m) {
    const section = m[1];
    const page = Number(m[2]) || 0;
    if (section === "reqs") {
      const arr = [...(DB.requests || [])].sort(
        (a, b) => new Date(b.at) - new Date(a.at)
      );
      const { slice, p, pages } = paginate(arr, page);
      const { text } = adminRequestsText(p);
      const inline_keyboard = [
        [
          {
            text: "◀️ Oldingi",
            callback_data: `admin:reqs:${Math.max(0, p - 1)}`,
          },
          {
            text: "▶️ Keyingi",
            callback_data: `admin:reqs:${Math.min(pages - 1, p + 1)}`,
          },
        ],
        ...slice.map((it, idx2) => [
          {
            text: `🗑 #${p * PAGE_SIZE + idx2 + 1}`,
            callback_data: `admin:delreq:${it.id}:${p}`,
          },
        ]),
        [{ text: "🏠 Menyu", callback_data: "admin:home" }],
      ];
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: cq.message.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard },
      });
    } else {
      const list = Object.values(DB.users || {}).filter(
        (u) => u && u.phoneNumber
      );
      list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      const { slice, p, pages } = paginate(list, page);
      const { text } = adminPhonesText(p);
      const inline_keyboard = [
        [
          {
            text: "◀️ Oldingi",
            callback_data: `admin:phones:${Math.max(0, p - 1)}`,
          },
          {
            text: "▶️ Keyingi",
            callback_data: `admin:phones:${Math.min(pages - 1, p + 1)}`,
          },
        ],
        ...slice.map((u, idx2) => [
          {
            text: `🗑 #${p * PAGE_SIZE + idx2 + 1}`,
            callback_data: `admin:delphone:${u.userId}:${p}`,
          },
        ]),
        [{ text: "🏠 Menyu", callback_data: "admin:home" }],
      ];
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: cq.message.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard },
      });
    }
    return bot.answerCallbackQuery(cq.id);
  }

  if (data === "admin:export") {
    try {
      await exportCsvAndSend(ADMIN_ID);
      await bot.answerCallbackQuery(cq.id, { text: "CSV fayllar yuborildi." });
    } catch (e) {
      console.error("CSV export error:", e);
      await bot.answerCallbackQuery(cq.id, {
        text: "Xato: CSV eksportda muammo.",
        show_alert: true,
      });
    }
    return;
  }

  if (data === "admin:search") {
    await bot.answerCallbackQuery(cq.id);
    ADMIN_STATE[chatId] = { awaitingSearch: true };
    return bot.sendMessage(
      chatId,
      "🔍 Qidirish: iltimos *UserID* (raqam) yuboring.",
      { parse_mode: "Markdown" }
    );
  }

  await bot.answerCallbackQuery(cq.id);
});

// ================== CSV helper ==================
function toCSV(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

async function exportCsvAndSend(targetChatId) {
  const exportDir = path.join(__dirname, "exports");
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const phones = [
    ["user_id", "first_name", "username", "phone_number", "updated_at"],
  ];
  for (const u of Object.values(DB.users || {})) {
    if (u && u.phoneNumber)
      phones.push([
        u.userId,
        u.firstName || "",
        u.username || "",
        u.phoneNumber,
        u.updatedAt || "",
      ]);
  }
  fs.writeFileSync(
    path.join(exportDir, `phones_${stamp}.csv`),
    toCSV(phones),
    "utf8"
  );

  const reqRows = [["request_id", "user_id", "time", "phone", "text"]];
  for (const r of DB.requests || []) {
    reqRows.push([
      r.id,
      r.userId,
      r.at,
      r.phone || "",
      (r.text || "").replace(/\r?\n/g, " "),
    ]);
  }
  fs.writeFileSync(
    path.join(exportDir, `requests_${stamp}.csv`),
    toCSV(reqRows),
    "utf8"
  );

  await bot.sendDocument(
    targetChatId,
    path.join(exportDir, `phones_${stamp}.csv`),
    { caption: "📞 Telefonlar CSV" }
  );
  await bot.sendDocument(
    targetChatId,
    path.join(exportDir, `requests_${stamp}.csv`),
    { caption: "📨 Murojaatlar CSV" }
  );
}

// ================== Kontakt (foydalanuvchi) ==================
bot.on("contact", async (msg) => {
  if (msg.from.id === ADMIN_ID) {
    return bot.sendMessage(
      msg.chat.id,
      "Admin sifatida kontakt ulashingiz shart emas.",
      {
        reply_markup: { remove_keyboard: true },
      }
    );
  }

  const chatId = msg.chat.id;
  if (!msg.contact || msg.contact.user_id !== msg.from.id) {
    return bot.sendMessage(
      chatId,
      "Iltimos, *o‘zingizga tegishli* telefon raqamini '📱 Telefon raqamni ulashish' tugmasi bilan jo‘nating.",
      { parse_mode: "Markdown" }
    );
  }

  const key = String(chatId);
  DB.users[key] = asLegacyUser(
    chatId,
    {
      userId: chatId,
      firstName: [msg.from.first_name, msg.from.last_name]
        .filter(Boolean)
        .join(" "),
      phoneNumber: String(msg.contact.phone_number || "").replace(/^\+/, ""),
      username: normUsername(msg.from.username || ""),
      updatedAt: new Date().toISOString(),
    },
    msg.from
  );
  saveDB(DB);

  // flagni tozalaymiz
  STATE[chatId] = { composing: false, draft: "", media: null };

  // Adminga xabar
  const first = [msg.from.first_name, msg.from.last_name]
    .filter(Boolean)
    .join(" ");
  const username = normUsername(msg.from.username || "");
  const phone = DB.users[key]?.phoneNumber || "";
  const contactAdminMsg =
    `🆕 *Yangi kontakt ulashildi*\n` +
    `👤 *Foydalanuvchi:* ${mdEscape(first || "Noma’lum")}\n` +
    `🔗 *Username:* ${mdEscape(username || "—")}\n` +
    `☎️ *Telefon:* ${mdEscape(phone || "—")}\n` +
    `🆔 *UserID:* \`${msg.from.id}\`\n` +
    `🕒 ${formatTime()}`;
  await bot.sendMessage(ADMIN_ID, contactAdminMsg, { parse_mode: "Markdown" });

  // Foydalanuvchiga tugma chiqaramiz
  await bot.sendMessage(
    chatId,
    "Rahmat! ✅ Endi murojaatingizni yozishingiz va u bilan birga foto yuborishingiz mumkin.       Ishlab chiquvchi : @bek_xacker ",
    {
      reply_markup: { keyboard: [[BUTTON_COMPOSE]], resize_keyboard: true },
    }
  );
});

// ================== Xabarlar (faqat foydalanuvchi oqimi) ==================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const typedText = (msg.text || "").trim();
  const content = (msg.text || msg.caption || "").trim();

  // Kontakt qayta ishlanmaydi
  if (msg.contact) return;

  // ADMIN matnli xabarlar: qidirish holati
  if (msg.from.id === ADMIN_ID) {
    if (ADMIN_STATE[chatId]?.awaitingSearch) {
      const idNum = Number(typedText);
      ADMIN_STATE[chatId].awaitingSearch = false;
      if (!Number.isFinite(idNum)) {
        await bot.sendMessage(chatId, "Raqamli UserID yuboring.");
        return;
      }
      const keyStr = String(idNum);
      const u = DB.users?.[keyStr];
      if (!u) {
        await bot.sendMessage(chatId, "Topilmadi.");
        return;
      }
      await bot.sendMessage(chatId, userLine(idNum, {}), {
        parse_mode: "Markdown",
      });
      return;
    }
    // boshqa admin matnlari yuqorida qayta ishlangan
    return;
  }

  const key = String(chatId);
  const u = DB.users[key];

  // 1) Telefon bermagan bo‘lsa — avval telefon
  if (!u || !u.phoneNumber) {
    return bot.sendMessage(
      chatId,
      "Avval telefon raqamingizni ulashing, keyin murojaat yuborishingiz mumkin.",
      {
        reply_markup: {
          keyboard: [
            [{ text: "📱 Telefon raqamni ulashish", request_contact: true }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  }

  // 2) Admin matnli buyruqlar (reply keyboard)
  if (msg.from.id === ADMIN_ID) {
    const lower = typedText.toLowerCase();
    if (lower === "📨 murojaatlar" || lower.includes("murojaa")) {
      const { text } = adminRequestsText(0);
      const arr = [...(DB.requests || [])].sort(
        (a, b) => new Date(b.at) - new Date(a.at)
      );
      const { slice, p, pages } = paginate(arr, 0);
      const inline_keyboard = [
        [
          {
            text: "◀️ Oldingi",
            callback_data: `admin:reqs:${Math.max(0, p - 1)}`,
          },
          {
            text: "▶️ Keyingi",
            callback_data: `admin:reqs:${Math.min(pages - 1, p + 1)}`,
          },
        ],
        ...slice.map((it, idx2) => [
          {
            text: `🗑 #${p * PAGE_SIZE + idx2 + 1}`,
            callback_data: `admin:delreq:${it.id}:${p}`,
          },
        ]),
        [{ text: "🏠 Menyu", callback_data: "admin:home" }],
      ];
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard },
      });
      return;
    }
    if (lower === "📞 telefonlar" || lower.includes("telefon")) {
      const list = Object.values(DB.users || {}).filter(
        (u) => u && u.phoneNumber
      );
      list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      const { slice, p, pages } = paginate(list, 0);
      const { text } = adminPhonesText(0);
      const inline_keyboard = [
        [
          {
            text: "◀️ Oldingi",
            callback_data: `admin:phones:${Math.max(0, p - 1)}`,
          },
          {
            text: "▶️ Keyingi",
            callback_data: `admin:phones:${Math.min(pages - 1, p + 1)}`,
          },
        ],
        ...slice.map((u, idx2) => [
          {
            text: `🗑 #${p * PAGE_SIZE + idx2 + 1}`,
            callback_data: `admin:delphone:${u.userId}:${p}`,
          },
        ]),
        [{ text: "🏠 Menyu", callback_data: "admin:home" }],
      ];
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard },
      });
      return;
    }
    if (lower === "🔄 csv eksport" || lower.includes("csv")) {
      await exportCsvAndSend(chatId);
      return;
    }
    if (lower === "🔍 qidirish" || lower.includes("qidir")) {
      ADMIN_STATE[chatId] = { awaitingSearch: true };
      await bot.sendMessage(
        chatId,
        "🔍 Qidirish: iltimos *UserID* (raqam) yuboring.",
        { parse_mode: "Markdown" }
      );
      return;
    }
  }

  // 3) Foydalanuvchi oqimi

  // 3) Tugma: Murojaatni yozing — composing holatini yoqish
  if (typedText === BUTTON_COMPOSE || /murojaatni yoz/i.test(typedText)) {
    STATE[chatId] = { composing: true, draft: "", media: null };
    return bot.sendMessage(
      chatId,
      'Murojaat matnini yozing. Tayyor bo‘lgach pastdagi *"' +
        BUTTON_SUBMIT +
        '"* tugmasi bilan yuboring.',
      {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [[BUTTON_SUBMIT]], resize_keyboard: true },
      }
    );
  }

  // 4) Composing holatida matn/media yig‘ish
  if (STATE[chatId]?.composing) {
    // Media saqlash (faqat so‘nggi fayl)
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      STATE[chatId].media = { type: "photo", file_id: largest.file_id };
    } else if (msg.document) {
      STATE[chatId].media = {
        type: "document",
        file_id: msg.document.file_id,
        name: msg.document.file_name,
      };
    }
    // Matnni draftga qo‘shish (yangi qatordan)
    if (content) {
      STATE[chatId].draft =
        (STATE[chatId].draft ? STATE[chatId].draft + "\n" : "") + content;
    }

    // Agar hozir yuborish tugmasi bosilmagan bo‘lsa, hech narsa qaytarmaymiz
    if (typedText !== BUTTON_SUBMIT) {
      return; // davom etaveradi
    }
  }

  // 5) Yuborish tugmasi — composing bo‘lsa saqlash va adminga jo‘natish
  if (typedText === BUTTON_SUBMIT && STATE[chatId]?.composing) {
    const draftText = STATE[chatId].draft?.trim() || content;
    const media = STATE[chatId].media || null;
    STATE[chatId].composing = false;

    // saqlash
    DB.requests = DB.requests || [];
    const phoneSnapshot = DB.users[key]?.phoneNumber || "";
    DB.requests.push({
      id: `${msg.from.id}-${Date.now()}`,
      userId: msg.from.id,
      text: draftText,
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
    DB.users[key] = asLegacyUser(
      chatId,
      {
        userId: chatId,
        firstName: [msg.from.first_name, msg.from.last_name]
          .filter(Boolean)
          .join(" "),
        phoneNumber: DB.users[key].phoneNumber || "",
        username: normUsername(
          msg.from.username || DB.users[key].username || ""
        ),
        updatedAt: new Date().toISOString(),
      },
      msg.from
    );
    saveDB(DB);

    // Admin ga yuboramiz
    const first = [msg.from.first_name, msg.from.last_name]
      .filter(Boolean)
      .join(" ");
    const username = normUsername(msg.from.username || "");
    const adminMsg =
      `📨 *Yangi murojaat!*\n` +
      `👤 *Foydalanuvchi:* ${mdEscape(first || "Noma’lum")}\n` +
      `🔗 *Username:* ${mdEscape(username || "—")}\n` +
      `☎️ *Telefon:* ${mdEscape(phoneSnapshot || "—")}\n` +
      `🆔 *UserID:* \`${msg.from.id}\`\n\n` +
      `✉️ *Matn:*\n${mdEscape(draftText)}\n\n` +
      `🕒 ${formatTime()}`;
    await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: "Markdown" });
    if (media) {
      if (media.type === "photo")
        await bot.sendPhoto(ADMIN_ID, media.file_id, {
          caption: "📎 Rasm ilova",
        });
      else
        await bot.sendDocument(
          ADMIN_ID,
          media.file_id,
          {},
          { filename: media.name || "file" }
        );
    }

    // Telefonni qayta talab qilmaslik — raqam saqlab boriladi
    // Foydalanuvchiga tasdiq va yana yozish imkonini qoldiramiz
    return bot.sendMessage(
      chatId,
      "✅ Murojaatingiz yuborildi! Xohlasangiz yana murojaat yozishingiz va u bilan birga foto yuborishingiz mumkin.🤖 Ishlab chiquvchi : @bek_xacker ",
      
      {
        reply_markup: { keyboard: [[BUTTON_COMPOSE]], resize_keyboard: true },
      }
    );
  }

  // 6) Agar composing yoqilmagan bo‘lsa, foydalanuvchiga yo‘riqnoma
  return bot.sendMessage(
    chatId,
    `Murojaat yozish uchun pastdagi *“${BUTTON_COMPOSE}”* tugmasini bosing.`,
    {
      parse_mode: "Markdown",
      reply_markup: { keyboard: [[BUTTON_COMPOSE]], resize_keyboard: true },
    }
  );
});

// ================== Xatolar ==================
bot.on("polling_error", async (err) => {
  const msg = err?.message || String(err);
  console.error("Polling error:", msg);
  const statusCode = err?.response?.statusCode || err?.code;
  const is409 = /\b409\b/.test(String(statusCode)) || /409/.test(msg);
  if (is409) {
    console.error(
      "⚠️  409 Conflict: boshqa getUpdates so‘rovi ishlamoqda. Ushbu instansiya to‘xtatiladi."
    );
    try {
      await bot.stopPolling();
    } catch (_) {}
    // Process exits so that faqat bitta instansiya qoladi
    process.exit(0);
  }
});
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) =>
  console.error("unhandledRejection:", e)
);
// Fayl eng pastiga (bot.on('polling_error', ...) dan keyin joylashtiring)
process.on("SIGINT", () => {
  console.log("\n♻️ Bot qayta ishga tushmoqda...");
  setTimeout(() => {
    process.exit(0);
  }, 500);
});

// ================== Start polling after handlers are registered ==================
(async () => {
  try {
    // Webhook yoqilgan bo'lsa polling ishlamaydi, shuning uchun o'chiramiz
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch (e) {
    console.warn("deleteWebHook bajarilmadi:", e?.message || e);
  }

  try {
    await bot.startPolling();
    console.log("✅ Polling boshlandi.");
  } catch (e) {
    console.error("Polling start xatosi:", e?.message || e);
    const msg = e?.message || "";
    if (/409/.test(msg)) {
      console.error(
        "⚠️  409 Conflict: boshqa instansiya ishlamoqda. Chiqib ketiladi."
      );
      process.exit(0);
    }
  }
})();
console.log("🤖 Bot ishga tushdi.");