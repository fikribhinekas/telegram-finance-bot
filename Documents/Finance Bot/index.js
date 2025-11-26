// index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_FILE = process.env.SERVICE_ACCOUNT_FILE; // path to JSON key
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'IDR';

if (!BOT_TOKEN || !SPREADSHEET_ID || !SERVICE_ACCOUNT_FILE) {
  console.error("Please set BOT_TOKEN, SPREADSHEET_ID, SERVICE_ACCOUNT_FILE in .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- Utility: normalize amount strings like "35k", "1.200.000", "1,200,000" ---
function parseAmount(raw) {
  if (!raw) return null;
  raw = raw.toString().trim().toLowerCase();
  // replace commas with nothing, dots as thousand separator (handle both)
  raw = raw.replace(/,/g, '').replace(/\./g, '');
  // k suffix
  const kMatch = raw.match(/^([0-9]+(\.[0-9]+)?)k$/);
  if (kMatch) {
    return Math.round(parseFloat(kMatch[1]) * 1000);
  }
  const num = raw.match(/-?\d+/);
  if (num) return parseInt(num[0], 10);
  return null;
}

// create TxID
function createTxId() {
  return 'TX' + Date.now();
}

// parse message text based on rules
async function parseMessage(text) {
  if (!text) return null;
  const orig = text.trim();
  const t = orig.replace(/\s+/g, ' ').trim();
  const result = {
    type: null, amount: null, category: null, note: '', raw: orig
  };

  // detect + or -
  const sign = t[0];
  let body = t;
  if (sign === '+' || sign === '-') {
    result.type = sign === '+' ? 'Income' : 'Expense';
    body = t.slice(1).trim();
  }

  // tokenize
  const tokens = body.split(' ');
  // find amount token (first token containing digit or ending with k)
  let amountTokenIndex = -1;
  for (let i=0;i<tokens.length;i++) {
    if (/[0-9]/.test(tokens[i])) { amountTokenIndex = i; break; }
    if (/^[0-9]+k$/i.test(tokens[i])) { amountTokenIndex = i; break; }
  }

  // category is first token (if amount is next) or tokens[0] if amount later
  if (tokens.length > 0) {
    result.category = tokens[0].toLowerCase();
  }

  if (amountTokenIndex >= 0) {
    const amt = parseAmount(tokens[amountTokenIndex]);
    result.amount = amt;
    // note = everything except category and amount
    const noteParts = tokens.slice(0, amountTokenIndex).concat(tokens.slice(amountTokenIndex+1));
    // if category was first token and equals tokens[0], remove from noteParts
    if (noteParts.length > 0 && noteParts[0].toLowerCase() === result.category) {
      noteParts.shift();
    }
    result.note = noteParts.join(' ').trim();
  } else {
    // no explicit amount found — attempt to find numbers inside text
    const num = (t.match(/([0-9\.,]+)k?/i) || [])[0];
    if (num) {
      result.amount = parseAmount(num);
      result.note = t.replace(num,'').trim();
    } else {
      result.note = t;
    }
  }

  return result;
}

// Append transaction to sheet
async function appendTransaction(row) {
  const values = [row];
  const resource = { values };
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Transactions!A:J',
    valueInputOption: 'USER_ENTERED',
    resource,
  });
}

// Find category mapping from Categories sheet (simple keyword match)
async function mapCategory(guess) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Categories!A:B'
    });
    const rows = res.data.values || [];
    const lowerGuess = (guess || '').toLowerCase();
    for (const r of rows) {
      const cat = (r[0] || '').toString();
      const keywords = (r[1] || '').toString().toLowerCase();
      if (!keywords) continue;
      const keywordsList = keywords.split(',').map(x => x.trim());
      if (keywordsList.includes(lowerGuess) || keywordsList.some(k => lowerGuess.includes(k))) {
        return cat;
      }
    }
  } catch (err) {
    console.error('mapCategory error', err);
  }
  return null;
}

// Handler for incoming text messages
async function handleIncomingMessage(ctx) {
  try {
    const message = ctx.message || ctx.update.message;
    if (!message || !message.text) return;
    const text = message.text.trim();
    // Ignore bot messages
    if (message.from.is_bot) return;

    const parsed = await parseMessage(text);
    if (!parsed) return;

    // If not explicit type, try infer from category keywords (simple)
    if (!parsed.type) {
      if (/gaji|salary|income/i.test(parsed.raw)) parsed.type = 'Income';
      else parsed.type = 'Expense';
    }

    // Map category via sheet
    const mapped = await mapCategory(parsed.category);
    const finalCategory = mapped || (parsed.category ? parsed.category : 'Uncategorized');

    // fallback amount check
    if (!parsed.amount || isNaN(parsed.amount)) {
      // ask user to clarify - reply in group
      await ctx.reply(`⚠️ Maaf, tidak menemukan jumlah yang jelas pada pesan:\n"${text}".\nContoh format: "- belanja 150000" atau "+ gaji 7000000"`);
      return;
    }

    // compose row
    const row = [
      new Date().toISOString(),
      message.chat.id.toString(),
      message.from.id.toString(),
      (message.from.username || (message.from.first_name || '') + (message.from.last_name ? ' ' + message.from.last_name : '')),
      parsed.type,
      parsed.amount,
      DEFAULT_CURRENCY,
      finalCategory,
      parsed.note || '',
      createTxId()
    ];

    await appendTransaction(row);

    // reply confirmation
    await ctx.reply(`✅ Tercatat: ${parsed.type === 'Expense' ? 'Pengeluaran' : 'Pemasukan'} • ${finalCategory} • ${parsed.amount.toLocaleString()} • Note: ${parsed.note || '-'} `);
  } catch (err) {
    console.error('handleIncomingMessage err', err);
    // don't crash on errors
    try { await ctx.reply('⚠️ Terjadi kesalahan saat mencatat. Coba lagi.'); } catch(e){/*ignore*/ }
  }
}

// Set up message listeners (works for group messages as long as privacy disabled)
bot.on('text', async (ctx) => {
  await handleIncomingMessage(ctx);
});

// --- Scheduled jobs: example monthly summary to a particular chatId (group)
// You should set REPORT_CHAT_ID in .env to the ID of the group where bot posts reports
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID; // e.g. -1001234567890 (group id)
// cron usage: '0 8 * * *' daily at 08:00 server time; here we'll do monthly at 07:00 on day 1
cron.schedule('0 7 1 * *', async () => {
  try {
    if (!REPORT_CHAT_ID) return console.log('REPORT_CHAT_ID not set');
    // build a simple monthly summary from sheet using Sheets API: we can read Transactions and compute
    // For simplicity, fetch last 1000 rows and compute in JS
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Transactions!A:J',
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) {
      await bot.telegram.sendMessage(REPORT_CHAT_ID, '📊 Rekap bulanan: belum ada transaksi.');
      return;
    }
    // skip header if present
    const dataRows = rows.filter(r => r.length >= 6);
    // determine current month
    const now = new Date();
    const month = now.getUTCMonth(); // 0-based
    const year = now.getUTCFullYear();
    let income = 0, expense = 0;
    const categorySums = {};
    for (const r of dataRows) {
      // r[0]=timestamp, r[4]=type, r[5]=amount, r[7]=category
      const ts = new Date(r[0]);
      if (ts.getUTCFullYear() === year && ts.getUTCMonth() === month-1) { // previous month (since running day 1)
        const type = r[4];
        const amt = parseInt(r[5],10) || 0;
        const cat = r[7] || 'Uncategorized';
        if (type === 'Income') income += amt;
        else expense += amt;
        categorySums[cat] = (categorySums[cat] || 0) + amt;
      }
    }
    // build message
    let msg = `📊 *Rekap Bulanan* (${year}-${(month).toString().padStart(2,'0')})\n`;
    msg += `Pemasukan: ${income.toLocaleString()}\nPengeluaran: ${expense.toLocaleString()}\nSaldo: ${(income - expense).toLocaleString()}\n\nTop kategori:\n`;
    const sortedCats = Object.entries(categorySums).sort((a,b)=>b[1]-a[1]).slice(0,5);
    if (sortedCats.length===0) msg += '- tidak ada data -\n';
    else sortedCats.forEach(([c,v],i)=>{ msg += `${i+1}. ${c}: ${v.toLocaleString()}\n`});
    await bot.telegram.sendMessage(REPORT_CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('cron report err', err);
  }
});

// start bot (long polling)
bot.launch().then(()=>console.log('Bot started (polling)')).catch(err=>console.error(err));

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
