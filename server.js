import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Telegraf, Markup } from 'telegraf';
import { readMenu, updateItem, addItem, deleteItem, getCategories } from './db.js';
import { mkdirSync, createWriteStream, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

// Public URL of THIS server (e.g. https://your-app.up.railway.app). Needed so
// photos uploaded through the bot can be turned into a public image link the
// website can display. Set this in Railway → Variables once you have your
// domain (see README).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing. Set it in your .env file or hosting environment variables.');
  process.exit(1);
}

if (ADMIN_IDS.length === 0) {
  console.warn('⚠️  ADMIN_CHAT_IDS is empty — nobody will be able to use admin commands yet.');
  console.warn('    Message your bot, run /start, and check the reply for your chat ID.');
}

if (!PUBLIC_URL) {
  console.warn('⚠️  PUBLIC_URL is empty — photo uploads from the bot will not work until you set it.');
  console.warn('    Set PUBLIC_URL to your Railway domain, e.g. https://your-app.up.railway.app');
}

// ─────────────────────────────────────────────────────────────
// UPLOADED IMAGES (photos sent to the bot get saved here)
// ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = join(__dirname, 'data', 'images');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────
// REST API (used by the website to load the live menu)
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use('/images', express.static(UPLOADS_DIR));

app.get('/api/menu', (req, res) => {
  res.json(readMenu());
});

app.get('/api/menu/categories', (req, res) => {
  res.json(getCategories());
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`✅ Menu API running on port ${PORT}`);
});

// ─────────────────────────────────────────────────────────────
// TELEGRAM BOT
// ─────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// In-memory conversation state per admin chat: what are we waiting for?
const sessions = new Map();

function isAdmin(ctx) {
  return ADMIN_IDS.includes(ctx.chat.id);
}

async function downloadTelegramPhoto(ctx, fileId) {
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileUrl.href);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download photo: ${response.status}`);
  }
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`;
  const filepath = join(UPLOADS_DIR, filename);
  await pipeline(response.body, createWriteStream(filepath));
  return `${PUBLIC_URL}/images/${filename}`;
}

function formatPrice(num) {
  return new Intl.NumberFormat('uz-UZ').format(Math.round(num)) + ' so‘m';
}

const CATEGORY_LABELS = {
  burgers: '🍔 Burgerlar',
  lavash: '🌯 Lavash',
  donar: '🥙 Donar & Shaurma',
  chicken: '🍗 Sochli Tovuq',
  hotdogs: '🌭 Xot-dog & Sendvich',
  sides: '🍟 Kartoshka & Sous',
  drinks: '🥤 Ichimliklar',
  desserts: '🍫 Desertlar'
};

// Reject non-admins early, but let /start through so we can show their chat ID.
bot.use((ctx, next) => {
  if (!ctx.chat) return next();
  if (isAdmin(ctx)) return next();
  const isStart = ctx.message?.text === '/start';
  if (isStart) return next();
  return; // silently ignore everything else from non-admins
});

// ---- /start ----
bot.start((ctx) => {
  if (!isAdmin(ctx)) {
    console.log(`ℹ️  /start from non-admin chat ID: ${ctx.chat.id} (${ctx.from.first_name || ''})`);
    return ctx.reply(
      `Salom! Bu bot faqat administratorlar uchun.\n\nSizning Chat ID: ${ctx.chat.id}\n\n` +
      `Agar siz administrator bo‘lsangiz, shu ID'ni ADMIN_CHAT_IDS o‘zgaruvchisiga qo‘shing va serverni qayta ishga tushiring.`
    );
  }

  sessions.delete(ctx.chat.id);
  return ctx.reply(
    `👋 Salom, Admin!\n\nKuroCraft Menyu Boshqaruvi\n\n` +
    `/menu — Menyuni ko‘rish va tahrirlash\n` +
    `/qoshish — Yangi taom qo‘shish\n` +
    `/bekor — Joriy amalni bekor qilish`
  );
});

// ---- /bekor (cancel current flow) ----
bot.command('bekor', (ctx) => {
  sessions.delete(ctx.chat.id);
  return ctx.reply('✅ Bekor qilindi.');
});

// ---- /menu — show category picker ----
bot.command('menu', (ctx) => sendCategoryPicker(ctx));

function categoryKeyboard() {
  const categories = getCategories();
  return Markup.inlineKeyboard(
    categories.map(cat => ([Markup.button.callback(CATEGORY_LABELS[cat] || cat, `cat:${cat}`)]))
  );
}

async function sendCategoryPicker(ctx) {
  await ctx.reply('📋 Toifani tanlang:', categoryKeyboard());
}

function itemListKeyboard(category) {
  const items = readMenu().filter(i => i.category === category);
  const rows = items.map(item => ([
    Markup.button.callback(`${item.name} — ${formatPrice(item.price)}`, `item:${item.id}`)
  ]));
  rows.push([Markup.button.callback('⬅️ Orqaga', 'back:categories')]);
  return Markup.inlineKeyboard(rows);
}

async function showItemList(ctx, category, edit) {
  const text = `${CATEGORY_LABELS[category] || category}\n\nTaomni tanlang:`;
  const keyboard = itemListKeyboard(category);
  if (edit) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

function itemDetailText(item) {
  const ingredientsList = (item.ingredients && item.ingredients.length)
    ? item.ingredients.map(i => `• ${i}`).join('\n')
    : '— (kiritilmagan)';

  const nutrition = item.nutrition || {};

  return (
    `🍽 ${item.name}\n` +
    `${item.subtitle || ''}\n\n` +
    `💰 Narxi: ${formatPrice(item.price)}\n` +
    `📁 Toifa: ${CATEGORY_LABELS[item.category] || item.category}\n` +
    `⭐ Reyting: ${item.rating}\n` +
    `${item.featured ? '✨ Saralanganlar ro‘yxatida\n' : ''}\n` +
    `📝 Tarkibi:\n${ingredientsList}\n\n` +
    `🥗 Ozuqaviy qiymati:\n` +
    `Kaloriya: ${item.calories || '-'} | Oqsil: ${nutrition.protein || '-'} | Uglevod: ${nutrition.carbs || '-'} | Yog‘: ${nutrition.fat || '-'}`
  );
}

function itemDetailKeyboard(item) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Narxni O‘zgartirish', `editprice:${item.id}`)],
    [Markup.button.callback('📝 Tarkibini O‘zgartirish', `editingredients:${item.id}`)],
    [Markup.button.callback('🥗 Ozuqaviy Qiymatni O‘zgartirish', `editnutrition:${item.id}`)],
    [Markup.button.callback(
      item.featured ? '☆ Saralanganlardan Olib Tashlash' : '⭐ Saralanganlarga Qo‘shish',
      `togglefeatured:${item.id}`
    )],
    [Markup.button.callback('🗑 O‘chirish', `deleteconfirm:${item.id}`)],
    [Markup.button.callback('⬅️ Orqaga', `back:cat:${item.category}`)]
  ]);
}

async function showItemDetail(ctx, itemId, edit) {
  const item = readMenu().find(i => i.id === itemId);
  if (!item) {
    return ctx.reply('❌ Taom topilmadi (o‘chirilgan bo‘lishi mumkin).');
  }
  const text = itemDetailText(item);
  const keyboard = itemDetailKeyboard(item);
  if (edit) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

function finalizeNewItem(ctx, chatId, draft) {
  const id = `custom-${Date.now()}`;
  const newItem = {
    id,
    name: draft.name,
    subtitle: '',
    category: draft.category,
    price: draft.price,
    priceDisplay: formatPrice(draft.price),
    rating: 4.8,
    reviewsCount: 0,
    cookTime: '10 daq',
    calories: draft.calories || '-',
    spiceLevel: 0,
    image: draft.image,
    featured: false,
    badge: null,
    tags: [],
    description: draft.description || '',
    ingredients: draft.ingredients || [],
    nutrition: {
      protein: draft.protein || '-',
      carbs: draft.carbs || '-',
      fat: draft.fat || '-',
      sodium: '-'
    },
    customOptions: [],
    ru: null
  };

  addItem(newItem);
  sessions.delete(chatId);

  const ingredientsList = (newItem.ingredients.length)
    ? newItem.ingredients.map(i => `• ${i}`).join('\n')
    : '— (kiritilmagan)';

  return ctx.reply(
    `✅ Yangi taom qo‘shildi!\n\n` +
    `🍽 ${newItem.name}\n` +
    `💰 ${newItem.priceDisplay}\n` +
    `📁 ${CATEGORY_LABELS[newItem.category]}\n` +
    `${newItem.description ? `📄 ${newItem.description}\n` : ''}` +
    `📝 Tarkibi:\n${ingredientsList}\n` +
    `🥗 Kaloriya: ${newItem.calories} | Oqsil: ${newItem.nutrition.protein} | Uglevod: ${newItem.nutrition.carbs} | Yog‘: ${newItem.nutrition.fat}\n\n` +
    `Saytda 1 daqiqa ichida ko‘rinadi.`
  );
}

// ---- /qoshish — add new item flow ----
bot.command('qoshish', (ctx) => {
  sessions.set(ctx.chat.id, { action: 'add_name', draft: {} });
  return ctx.reply('➕ Yangi taom qo‘shish.\n\nTaom nomini kiriting (masalan: "Katta Burger"):');
});

// ---- Callback query (button) handlers ----
bot.action('back:categories', async (ctx) => {
  await ctx.answerCbQuery();
  await sendCategoryPicker(ctx);
  await ctx.deleteMessage().catch(() => {});
});

bot.action(/^back:cat:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showItemList(ctx, ctx.match[1], true);
});

bot.action(/^cat:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showItemList(ctx, ctx.match[1], true);
});

bot.action(/^item:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showItemDetail(ctx, ctx.match[1], true);
});

bot.action(/^editprice:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  sessions.set(ctx.chat.id, { action: 'awaiting_price', itemId: ctx.match[1] });
  await ctx.reply('💰 Yangi narxni kiriting (faqat raqam, masalan: 45000):');
});

bot.action(/^editingredients:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId = ctx.match[1];
  const item = readMenu().find(i => i.id === itemId);
  const current = (item && item.ingredients && item.ingredients.length)
    ? item.ingredients.map(i => `• ${i}`).join('\n')
    : '— (kiritilmagan)';
  sessions.set(ctx.chat.id, { action: 'awaiting_ingredients', itemId });
  await ctx.reply(
    `📝 Joriy tarkib:\n${current}\n\n` +
    `Yangi tarkibni yuboring — har bir ingredientni alohida qatorga yozing.\n\n` +
    `Masalan:\nMol go‘shti kotleti\nYangi bulochka\nPomidor va bodring`
  );
});

bot.action(/^editnutrition:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId = ctx.match[1];
  const item = readMenu().find(i => i.id === itemId);
  const n = (item && item.nutrition) || {};
  sessions.set(ctx.chat.id, { action: 'awaiting_calories', itemId, nutritionDraft: {} });
  await ctx.reply(
    `🥗 Joriy qiymatlar:\n` +
    `Kaloriya: ${item?.calories || '-'} | Oqsil: ${n.protein || '-'} | Uglevod: ${n.carbs || '-'} | Yog‘: ${n.fat || '-'}\n\n` +
    `Kaloriyani kiriting (masalan: 540 kkal):`
  );
});

bot.action(/^togglefeatured:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId = ctx.match[1];
  const item = readMenu().find(i => i.id === itemId);
  if (item) {
    updateItem(itemId, { featured: !item.featured });
    await showItemDetail(ctx, itemId, true);
  }
});

bot.action(/^deleteconfirm:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId = ctx.match[1];
  await ctx.editMessageText(
    '❗️ Ushbu taomni o‘chirishga aminmisiz?',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Ha, o‘chirish', `deleteyes:${itemId}`),
        Markup.button.callback('❌ Bekor qilish', `item:${itemId}`)
      ]
    ])
  );
});

bot.action(/^deleteyes:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const itemId = ctx.match[1];
  const item = readMenu().find(i => i.id === itemId);
  deleteItem(itemId);
  await ctx.editMessageText(`🗑 "${item ? item.name : itemId}" o‘chirildi.`);
});

bot.action('addskip:ingredients', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session || session.action !== 'add_ingredients') return;
  session.draft.ingredients = [];
  await finalizeNewItem(ctx, chatId, session.draft);
});

// ---- Handle photo uploads (used for the image step when adding a new item) ----
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session || session.action !== 'add_image') return;

  if (!PUBLIC_URL) {
    return ctx.reply(
      '⚠️ Serverda PUBLIC_URL sozlanmagan, shuning uchun fotoni saqlab bo‘lmadi.\n\n' +
      'Iltimos, hozircha rasm havolasini (URL) matn sifatida yuboring, yoki administratorga ' +
      'PUBLIC_URL o‘zgaruvchisini sozlashni so‘rang.'
    );
  }

  try {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1]; // Telegram sends smallest→largest
    await ctx.reply('⏳ Foto yuklanmoqda...');
    const imageUrl = await downloadTelegramPhoto(ctx, largest.file_id);

    session.draft.image = imageUrl;
    session.action = 'add_ingredients';
    sessions.set(chatId, session);

    await ctx.reply(
      '✅ Foto saqlandi!\n\n' +
      '📝 Tarkibini kiriting — har bir ingredientni alohida qatorga yozing.\n\n' +
      'Masalan:\nMol go‘shti kotleti\nYangi bulochka\nMaxsus sous',
      Markup.inlineKeyboard([[Markup.button.callback('⏭ Tarkibsiz o‘tkazish', 'addskip:ingredients')]])
    );
  } catch (err) {
    console.error('Photo download error:', err.message);
    await ctx.reply('❌ Fotoni saqlashda xatolik yuz berdi. Qaytadan urinib ko‘ring yoki rasm havolasini (URL) yuboring.');
  }
});

// ---- Handle plain text replies (for multi-step flows) ----
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session) return;
  const text = ctx.message.text.trim();

  // --- Editing price of an existing item ---
  if (session.action === 'awaiting_price') {
    const newPrice = parseInt(text.replace(/[^\d]/g, ''), 10);
    if (isNaN(newPrice) || newPrice <= 0) {
      return ctx.reply('⚠️ Iltimos, to‘g‘ri raqam kiriting (masalan: 45000).');
    }
    const updated = updateItem(session.itemId, {
      price: newPrice,
      priceDisplay: formatPrice(newPrice)
    });
    sessions.delete(chatId);
    if (updated) {
      return ctx.reply(`✅ "${updated.name}" narxi ${formatPrice(newPrice)} ga o‘zgartirildi.\n\nSaytda 1 daqiqa ichida yangilanadi.`);
    }
    return ctx.reply('❌ Xatolik yuz berdi.');
  }

  // --- Editing ingredients of an existing item ---
  if (session.action === 'awaiting_ingredients') {
    const ingredients = text
      .split('\n')
      .map(s => s.replace(/^[•\-*]\s*/, '').trim())
      .filter(Boolean);

    if (ingredients.length === 0) {
      return ctx.reply('⚠️ Iltimos, kamida bitta ingredient kiriting (har birini alohida qatorga yozing).');
    }

    const item = readMenu().find(i => i.id === session.itemId);
    const patch = { ingredients };
    // Clear the stale Russian translation of ingredients so the site doesn't show
    // a mismatched old translation next to the new Uzbek list. The site will fall
    // back to showing the Uzbek text in Russian mode until retranslated.
    if (item && item.ru && item.ru.ingredients) {
      patch.ru = { ...item.ru, ingredients: undefined };
    }
    const updated = updateItem(session.itemId, patch);
    sessions.delete(chatId);
    if (updated) {
      return ctx.reply(
        `✅ "${updated.name}" tarkibi yangilandi:\n${ingredients.map(i => `• ${i}`).join('\n')}\n\n` +
        `Saytda 1 daqiqa ichida yangilanadi.`
      );
    }
    return ctx.reply('❌ Xatolik yuz berdi.');
  }

  // --- Editing nutrition of an existing item (multi-step: calories -> protein -> carbs -> fat) ---
  if (session.action === 'awaiting_calories') {
    session.nutritionDraft.calories = text;
    session.action = 'awaiting_protein';
    sessions.set(chatId, session);
    return ctx.reply('💪 Oqsil miqdorini kiriting (masalan: 24g):');
  }

  if (session.action === 'awaiting_protein') {
    session.nutritionDraft.protein = text;
    session.action = 'awaiting_carbs';
    sessions.set(chatId, session);
    return ctx.reply('🍞 Uglevod miqdorini kiriting (masalan: 38g):');
  }

  if (session.action === 'awaiting_carbs') {
    session.nutritionDraft.carbs = text;
    session.action = 'awaiting_fat';
    sessions.set(chatId, session);
    return ctx.reply('🧈 Yog‘ miqdorini kiriting (masalan: 26g):');
  }

  if (session.action === 'awaiting_fat') {
    session.nutritionDraft.fat = text;
    const draft = session.nutritionDraft;
    const item = readMenu().find(i => i.id === session.itemId);
    const updated = updateItem(session.itemId, {
      calories: draft.calories,
      nutrition: {
        ...(item?.nutrition || {}),
        protein: draft.protein,
        carbs: draft.carbs,
        fat: draft.fat,
        sodium: item?.nutrition?.sodium || '-'
      }
    });
    sessions.delete(chatId);
    if (updated) {
      return ctx.reply(
        `✅ "${updated.name}" ozuqaviy qiymati yangilandi:\n` +
        `Kaloriya: ${draft.calories} | Oqsil: ${draft.protein} | Uglevod: ${draft.carbs} | Yog‘: ${draft.fat}\n\n` +
        `Saytda 1 daqiqa ichida yangilanadi.`
      );
    }
    return ctx.reply('❌ Xatolik yuz berdi.');
  }

  // --- Add new item flow (multi-step) ---
  if (session.action === 'add_name') {
    session.draft.name = text;
    session.action = 'add_category';
    sessions.set(chatId, session);
    const categories = Object.keys(CATEGORY_LABELS);
    return ctx.reply(`Toifani tanlang:\n\n${categories.map((c, i) => `${i + 1}. ${CATEGORY_LABELS[c]}`).join('\n')}\n\nRaqamini yuboring:`);
  }

  if (session.action === 'add_category') {
    const categories = Object.keys(CATEGORY_LABELS);
    const idx = parseInt(text, 10) - 1;
    if (isNaN(idx) || !categories[idx]) {
      return ctx.reply('⚠️ Iltimos, ro‘yxatdagi raqamni yuboring.');
    }
    session.draft.category = categories[idx];
    session.action = 'add_price';
    sessions.set(chatId, session);
    return ctx.reply('💰 Narxini kiriting (faqat raqam, masalan: 42000):');
  }

  if (session.action === 'add_price') {
    const price = parseInt(text.replace(/[^\d]/g, ''), 10);
    if (isNaN(price) || price <= 0) {
      return ctx.reply('⚠️ Iltimos, to‘g‘ri raqam kiriting.');
    }
    session.draft.price = price;
    session.action = 'add_image';
    sessions.set(chatId, session);
    return ctx.reply('🖼 Rasmni yuboring — telefondan foto sifatida jo‘nating YOKI rasm havolasini (URL) yozing (yoki "yo‘q" deb yozing):');
  }

  if (session.action === 'add_image') {
    const lower = text.toLowerCase();
    session.draft.image = (lower === 'yo‘q' || lower === 'yoq')
      ? 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=80'
      : text;
    session.action = 'add_ingredients';
    sessions.set(chatId, session);
    return ctx.reply(
      '📝 Tarkibini kiriting — har bir ingredientni alohida qatorga yozing.\n\n' +
      'Masalan:\nMol go‘shti kotleti\nYangi bulochka\nMaxsus sous',
      Markup.inlineKeyboard([[Markup.button.callback('⏭ Tarkibsiz o‘tkazish', 'addskip:ingredients')]])
    );
  }

  if (session.action === 'add_ingredients') {
    const ingredients = text
      .split('\n')
      .map(s => s.replace(/^[•\-*]\s*/, '').trim())
      .filter(Boolean);
    session.draft.ingredients = ingredients;
    return finalizeNewItem(ctx, chatId, session.draft);
  }
});

bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
});

bot.launch().then(() => {
  console.log('🤖 Telegram bot started (polling)...');
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
