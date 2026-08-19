require('dotenv').config({ override: true });
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { initDB, getPool } = require('./db');
const { generateExcelReport } = require('./excel');

// Environment check
const BOT_TOKEN = process.env.BOT_TOKEN ? process.env.BOT_TOKEN.trim() : '';
const HR_GROUP_CHAT_ID = process.env.HR_GROUP_CHAT_ID ? process.env.HR_GROUP_CHAT_ID.trim() : '';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing or undefined in .env!');
  process.exit(1);
}

if (!HR_GROUP_CHAT_ID) {
  console.error('❌ HR_GROUP_CHAT_ID is missing or undefined in .env!');
  process.exit(1);
}

// Force IPv4 and keepalive on Telegram API requests
const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  timeout: 45000,
});

const bot = new Telegraf(BOT_TOKEN, {
  telegram: { agent: httpsAgent },
  handlerTimeout: 90000,
});
let pool;

// In-memory state tracking per user
// userSessions[userId] = { step, department, issueType, ratingDate }
const userSessions = {};

// ----------------------------------------------------
// Master Department & Issue Type Lists
// ----------------------------------------------------
const DEPARTMENTS = [
  '💻 IT Support',
  '🏢 HR & Admin',
  '❄️ HVAC',
  '📞 Accounts (TEL)',
  '🚚 Supply Chain',
  '👔 Management',
  '🛒 TD (Transcom Digital)',
  '🏭 BLL (Bangladesh Lamps)',
  '⚡ GAL (Global Appliances)',
  '📊 Accounts (BLL)',
];

const ISSUE_TYPES = [
  '📦 Supplies Shortage',
  '🪑 Furniture Damage',
  '🧹 Cleanliness / Janitorial',
  '💻 IT / Network / Hardware',
  '🛠️ Equipment / Maintenance',
  '❓ Other Problem',
];

// Helper: Get Asia/Dhaka date string YYYY-MM-DD
function getDhakaDateString() {
  const d = new Date();
  const dhakaStr = d.toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
  const dhakaDate = new Date(dhakaStr);
  const year = dhakaDate.getFullYear();
  const month = String(dhakaDate.getMonth() + 1).padStart(2, '0');
  const day = String(dhakaDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: Generate unique ticket code (TK-XXXXX)
async function generateUniqueTicketCode(dbPool) {
  let unique = false;
  let code = '';
  while (!unique) {
    const randomNum = Math.floor(10000 + Math.random() * 90000);
    code = `TK-${randomNum}`;
    const [rows] = await dbPool.query('SELECT id FROM tickets WHERE ticket_code = ?', [code]);
    if (rows.length === 0) {
      unique = true;
    }
  }
  return code;
}

// Helper: Format Clickable User Mention Link using Telegram ID
function getUserMention(telegramId, firstName, lastName, username) {
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || username || `User ${telegramId}`;
  // tg://user?id= opens a direct Telegram chat/profile window for that exact user ID
  return `[${fullName}](tg://user?id=${telegramId})`;
}

// Helper: Upsert User into Database
async function registerOrUpdateUser(ctx, phoneNumber = null) {
  const user = ctx.from;
  if (!user) return;

  try {
    await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, phone_number)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
         username = VALUES(username), 
         first_name = VALUES(first_name),
         last_name = VALUES(last_name),
         phone_number = COALESCE(VALUES(phone_number), phone_number)`,
      [user.id, user.username || null, user.first_name || '', user.last_name || '', phoneNumber]
    );
  } catch (error) {
    console.error('Failed to register/update user:', error);
  }
}

// Helper: Fetch User Details from Database
async function getUserFromDB(telegramId) {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    if (rows.length > 0) {
      return rows[0];
    }
  } catch (e) {
    console.error('Failed to get user from DB:', e);
  }
  return null;
}

// Helper: Build Admin Group Keyboard
function buildAdminKeyboard(ticketId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⏳ In Progress', `status_inprogress_${ticketId}`),
      Markup.button.callback('✅ Mark Fixed', `status_fixed_${ticketId}`),
    ],
    [
      Markup.button.callback('❌ Reject', `status_rejected_${ticketId}`),
      Markup.button.callback('📊 Download Excel Report', 'export_excel'),
    ],
  ]);
}

// Helper: Format Ticket Message Text for Group
function formatTicketGroupMessage(ticket, reporterUser, adminUser = null) {
  let statusEmoji = '🔴 Pending';
  if (ticket.status === 'In Progress') {
    statusEmoji = '⏳ In Progress';
  } else if (ticket.status === 'Fixed') {
    statusEmoji = '✅ Fixed';
  } else if (ticket.status === 'Rejected') {
    statusEmoji = '❌ Rejected';
  }

  const reporterMention = getUserMention(
    reporterUser.telegram_id,
    reporterUser.first_name,
    reporterUser.last_name,
    reporterUser.username
  );

  const phoneStr = reporterUser.phone_number || 'Not Provided';

  let text = `📌 *NEW WORKPLACE TICKET REPORTED*\n\n`;
  text += `🎫 *Ticket Code:* \`${ticket.ticket_code}\`\n`;
  text += `🏢 *Department:* ${ticket.department}\n`;
  text += `🏷️ *Issue Type:* ${ticket.issue_type}\n`;
  text += `👤 *Reported By:* ${reporterMention} (ID: \`${reporterUser.telegram_id}\`)\n`;
  text += `📞 *Phone Number:* \`${phoneStr}\`\n`;
  text += `📝 *Description:* ${ticket.description}\n`;
  text += `📊 *Status:* ${statusEmoji}\n`;

  if (adminUser) {
    const adminMention = getUserMention(
      adminUser.telegram_id,
      adminUser.first_name,
      adminUser.last_name,
      adminUser.username
    );
    text += `👤 *Updated By:* ${adminMention}\n`;
  }

  const reportDateStr = ticket.created_at
    ? new Date(ticket.created_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })
    : new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });

  text += `\n📅 *Reported At:* ${reportDateStr} (BD Time)`;

  if (ticket.resolved_at) {
    const resolvedDateStr = new Date(ticket.resolved_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
    if (ticket.status === 'Fixed') {
      text += `\n✅ *Fixed At:* ${resolvedDateStr} (BD Time)`;
    } else if (ticket.status === 'Rejected') {
      text += `\n❌ *Rejected At:* ${resolvedDateStr} (BD Time)`;
    }
  }

  return text;
}

// Helper: Send Department Selection Menu directly
async function sendDepartmentMenu(ctx) {
  const deptButtons = [];
  for (let i = 0; i < DEPARTMENTS.length; i += 2) {
    const row = [Markup.button.callback(DEPARTMENTS[i], `dept_${i}`)];
    if (i + 1 < DEPARTMENTS.length) {
      row.push(Markup.button.callback(DEPARTMENTS[i + 1], `dept_${i + 1}`));
    }
    deptButtons.push(row);
  }

  const firstName = ctx.from.first_name || 'Employee';
  const welcomeText =
    `👋 Hello *${firstName}*! Welcome to the *Workplace Helpdesk Bot*.\n\n` +
    `Please select your *Department* to report an issue or workplace problem:`;

  return ctx.reply(welcomeText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(deptButtons),
  });
}

// ----------------------------------------------------
// Employee Flow - Issue Reporting
// ----------------------------------------------------

// /start Command Handler
bot.start(async (ctx) => {
  await registerOrUpdateUser(ctx);

  const userId = ctx.from.id;
  delete userSessions[userId];

  // Directly show Department selection menu
  return sendDepartmentMenu(ctx);
});

// /phone Command Handler (Optional phone update)
bot.command('phone', async (ctx) => {
  return ctx.reply(
    `📱 To help HR & Admin contact you regarding tickets, click the button below to share your phone number:`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([[Markup.button.contactRequest('📱 Share Phone Number')]])
        .resize()
        .oneTime(),
    }
  );
});

// Contact Sharing Handler (Native Telegram Contact Button)
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;

  if (contact) {
    let rawPhone = contact.phone_number.trim();
    if (!rawPhone.startsWith('+')) {
      rawPhone = `+${rawPhone}`;
    }

    await registerOrUpdateUser(ctx, rawPhone);

    return ctx.reply(`✅ Thank you! Phone number *${rawPhone}* saved successfully.`, {
      parse_mode: 'Markdown',
      ...Markup.removeKeyboard(),
    });
  }
});

// Department Selection Callback Handler
bot.action(/^dept_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const deptIndex = parseInt(ctx.match[1], 10);
  const selectedDept = DEPARTMENTS[deptIndex];

  if (!selectedDept) {
    return ctx.reply('Invalid department selection. Please type /start again.');
  }

  const userId = ctx.from.id;
  userSessions[userId] = {
    step: 'AWAITING_ISSUE_TYPE',
    department: selectedDept,
  };

  // Build Issue Type Keyboard
  const issueButtons = [];
  for (let i = 0; i < ISSUE_TYPES.length; i += 2) {
    const row = [Markup.button.callback(ISSUE_TYPES[i], `issue_${i}`)];
    if (i + 1 < ISSUE_TYPES.length) {
      row.push(Markup.button.callback(ISSUE_TYPES[i + 1], `issue_${i + 1}`));
    }
    issueButtons.push(row);
  }

  return ctx.editMessageText(
    `🏢 Department: *${selectedDept}*\n\nNow, please select the *Issue Type*:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(issueButtons),
    }
  );
});

// Issue Type Selection Callback Handler
bot.action(/^issue_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const issueIndex = parseInt(ctx.match[1], 10);
  const selectedIssue = ISSUE_TYPES[issueIndex];

  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (!session || !session.department) {
    return ctx.reply('Session expired. Please restart using /start.');
  }

  session.issueType = selectedIssue;
  session.step = 'AWAITING_DESCRIPTION';

  return ctx.editMessageText(
    `🏢 *Department:* ${session.department}\n` +
      `🏷️ *Issue Type:* ${selectedIssue}\n\n` +
      `📝 *Please describe the problem in detail.*\n` +
      `You can send a text message, or send a photo with a caption!`,
    { parse_mode: 'Markdown' }
  );
});

// Text & Photo Message Handler (Ticket Details or Survey Remarks)
bot.on(['text', 'photo'], async (ctx, next) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  // Case A: User is submitting ticket description & photo
  if (session && session.step === 'AWAITING_DESCRIPTION') {
    const department = session.department;
    const issueType = session.issueType;
    delete userSessions[userId]; // Clear session

    let description = '';
    let photoFileId = null;

    if (ctx.message.photo && ctx.message.photo.length > 0) {
      photoFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      description = ctx.message.caption || 'Photo attached (No description provided)';
    } else if (ctx.message.text) {
      description = ctx.message.text;
    }

    if (!description.trim()) {
      return ctx.reply('Please provide a text description of the issue or attach a photo with a caption.');
    }

    try {
      // Generate unique ticket code
      const ticketCode = await generateUniqueTicketCode(pool);

      // Ensure user is in DB
      await registerOrUpdateUser(ctx);
      const reporterUser = (await getUserFromDB(userId)) || {
        telegram_id: userId,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
        username: ctx.from.username,
        phone_number: null,
      };

      // Save ticket in Database
      const [result] = await pool.query(
        `INSERT INTO tickets (ticket_code, department, issue_type, description, photo_file_id, telegram_user_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending')`,
        [ticketCode, department, issueType, description, photoFileId, userId]
      );

      const ticketId = result.insertId;

      // Send confirmation to employee
      await ctx.reply(
        `✅ *Issue Submitted Successfully!*\n\n` +
          `🎫 *Ticket Code:* \`${ticketCode}\`\n` +
          `🏢 *Department:* ${department}\n` +
          `🏷️ *Category:* ${issueType}\n\n` +
          `The Admin team has been notified. We will process your request shortly!`,
        { parse_mode: 'Markdown' }
      );

      const ticketObj = {
        id: ticketId,
        ticket_code: ticketCode,
        department,
        issue_type: issueType,
        description,
        status: 'Pending',
      };

      const groupMsgText = formatTicketGroupMessage(ticketObj, reporterUser);
      const adminKeyboard = buildAdminKeyboard(ticketId);

      let groupMessage;
      if (photoFileId) {
        groupMessage = await ctx.telegram.sendPhoto(HR_GROUP_CHAT_ID, photoFileId, {
          caption: groupMsgText,
          parse_mode: 'Markdown',
          ...adminKeyboard,
        });
      } else {
        groupMessage = await ctx.telegram.sendMessage(HR_GROUP_CHAT_ID, groupMsgText, {
          parse_mode: 'Markdown',
          ...adminKeyboard,
        });
      }

      // Store group message_id in database
      if (groupMessage && groupMessage.message_id) {
        await pool.query('UPDATE tickets SET hr_message_id = ? WHERE id = ?', [
          groupMessage.message_id,
          ticketId,
        ]);
      }
    } catch (err) {
      console.error('Error saving ticket:', err);
      await ctx.reply('❌ Failed to record your ticket due to a system error. Please try again later.');
    }
    return;
  }

  // Case B: User is replying with survey remarks
  if (session && session.step === 'AWAITING_RATING_REMARKS') {
    const ratingDate = session.ratingDate;
    delete userSessions[userId]; // Clear session

    let remarksText = ctx.message.text ? ctx.message.text.trim() : '';
    if (remarksText.toLowerCase() === 'none' || remarksText === '') {
      remarksText = 'Skipped / None';
    }

    try {
      await pool.query(
        `UPDATE daily_ratings 
         SET remarks = ? 
         WHERE telegram_user_id = ? AND rating_date = ?`,
        [remarksText, userId, ratingDate]
      );

      await ctx.reply('Thank you! Your feedback remarks have been recorded. 🙏');
    } catch (err) {
      console.error('Error saving survey remarks:', err);
      await ctx.reply('Thank you for your response!');
    }
    return;
  }

  return next();
});

// ----------------------------------------------------
// Admin / Group Notification Callback Handlers
// ----------------------------------------------------

// Action: In Progress Button Clicked
bot.action(/^status_inprogress_(\d+)$/, async (ctx) => {
  const ticketId = parseInt(ctx.match[1], 10);
  const adminUser = {
    telegram_id: ctx.from.id,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    username: ctx.from.username,
  };

  try {
    // 1. Update status and clear resolved_at in database
    await pool.query("UPDATE tickets SET status = 'In Progress', resolved_at = NULL WHERE id = ?", [ticketId]);

    // 2. Fetch updated ticket details & reporter user
    const [rows] = await pool.query(
      `SELECT t.*, u.username, u.first_name, u.last_name, u.phone_number 
       FROM tickets t 
       LEFT JOIN users u ON t.telegram_user_id = u.telegram_id 
       WHERE t.id = ?`,
      [ticketId]
    );

    if (rows.length === 0) {
      return ctx.answerCbQuery('Ticket not found!');
    }

    const ticket = rows[0];
    const reporterUser = {
      telegram_id: ticket.telegram_user_id,
      first_name: ticket.first_name,
      last_name: ticket.last_name,
      username: ticket.username,
      phone_number: ticket.phone_number,
    };

    const updatedText = formatTicketGroupMessage(ticket, reporterUser, adminUser);
    const adminKeyboard = buildAdminKeyboard(ticketId);

    // Edit message caption or text
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(updatedText, {
        parse_mode: 'Markdown',
        ...adminKeyboard,
      });
    } else {
      await ctx.editMessageText(updatedText, {
        parse_mode: 'Markdown',
        ...adminKeyboard,
      });
    }

    await ctx.answerCbQuery('⏳ Ticket status updated to In Progress.');
  } catch (err) {
    console.error('Error setting ticket in progress:', err);
    await ctx.answerCbQuery('❌ Failed to update status.');
  }
});

// Action: Mark Fixed Button Clicked
bot.action(/^status_fixed_(\d+)$/, async (ctx) => {
  const ticketId = parseInt(ctx.match[1], 10);
  const adminUser = {
    telegram_id: ctx.from.id,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    username: ctx.from.username,
  };

  try {
    // 1. Update status and set resolved_at in database
    await pool.query("UPDATE tickets SET status = 'Fixed', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [ticketId]);

    // 2. Fetch updated ticket details & reporter user
    const [rows] = await pool.query(
      `SELECT t.*, u.username, u.first_name, u.last_name, u.phone_number 
       FROM tickets t 
       LEFT JOIN users u ON t.telegram_user_id = u.telegram_id 
       WHERE t.id = ?`,
      [ticketId]
    );

    if (rows.length === 0) {
      return ctx.answerCbQuery('Ticket not found!');
    }

    const ticket = rows[0];
    const reporterUser = {
      telegram_id: ticket.telegram_user_id,
      first_name: ticket.first_name,
      last_name: ticket.last_name,
      username: ticket.username,
      phone_number: ticket.phone_number,
    };

    const updatedText = formatTicketGroupMessage(ticket, reporterUser, adminUser);
    const adminKeyboard = buildAdminKeyboard(ticketId);

    // Edit group message caption or text
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(updatedText, {
        parse_mode: 'Markdown',
        ...adminKeyboard,
      });
    } else {
      await ctx.editMessageText(updatedText, {
        parse_mode: 'Markdown',
        ...adminKeyboard,
      });
    }

    await ctx.answerCbQuery('✅ Ticket marked as Fixed!');

    // 3. Private Notification to Employee
    try {
      await bot.telegram.sendMessage(
        ticket.telegram_user_id,
        `🎉 *Good news!* Your reported issue (*${ticket.ticket_code}*) has been marked as *FIXED* by the Admin team. Thank you!`,
        { parse_mode: 'Markdown' }
      );
    } catch (notifyErr) {
      console.error(`Could not send private notification to user ${ticket.telegram_user_id}:`, notifyErr.message);
    }
  } catch (err) {
    console.error('Error marking ticket fixed:', err);
    await ctx.answerCbQuery('❌ Failed to update status.');
  }
});

// Action: Reject Button Clicked
bot.action(/^status_rejected_(\d+)$/, async (ctx) => {
  const ticketId = parseInt(ctx.match[1], 10);
  const adminUser = {
    telegram_id: ctx.from.id,
    first_name: ctx.from.first_name,
    last_name: ctx.from.last_name,
    username: ctx.from.username,
  };

  try {
    // 1. Update status and set resolved_at in database
    await pool.query("UPDATE tickets SET status = 'Rejected', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [ticketId]);

    // 2. Fetch updated ticket details & reporter user
    const [rows] = await pool.query(
      `SELECT t.*, u.username, u.first_name, u.last_name, u.phone_number 
       FROM tickets t 
       LEFT JOIN users u ON t.telegram_user_id = u.telegram_id 
       WHERE t.id = ?`,
      [ticketId]
    );

    if (rows.length === 0) {
      return ctx.answerCbQuery('Ticket not found!');
    }

    const ticket = rows[0];
    const reporterUser = {
      telegram_id: ticket.telegram_user_id,
      first_name: ticket.first_name,
      last_name: ticket.last_name,
      username: ticket.username,
      phone_number: ticket.phone_number,
    };

    const updatedText = formatTicketGroupMessage(ticket, reporterUser, adminUser);
    const adminKeyboard = buildAdminKeyboard(ticketId);

    // Edit group message caption or text
    if (ctx.callbackQuery.message.photo) {
      await ctx.editMessageCaption(updatedText, {
        parse_mode: 'Markdown',
        ...adminKeyboard,
      });
    } else {
      await ctx.editMessageText(updatedText, {
        parse_mode: 'Markdown',
        ...adminKeyboard,
      });
    }

    await ctx.answerCbQuery('❌ Ticket marked as Rejected.');

    // 3. Private Notification to Employee
    try {
      await bot.telegram.sendMessage(
        ticket.telegram_user_id,
        `❌ Your reported issue (*${ticket.ticket_code}*) has been rejected by the Admin team.`,
        { parse_mode: 'Markdown' }
      );
    } catch (notifyErr) {
      console.error(`Could not send private notification to user ${ticket.telegram_user_id}:`, notifyErr.message);
    }
  } catch (err) {
    console.error('Error rejecting ticket:', err);
    await ctx.answerCbQuery('❌ Failed to reject ticket.');
  }
});

// Action / Command: Excel Report Generation
const handleExcelExport = async (ctx) => {
  try {
    const loadingMsg = await ctx.reply('⏳ Generating Excel report, please wait...');

    const filePath = await generateExcelReport(pool);
    const fileName = path.basename(filePath);

    // Send document to group chat
    await ctx.telegram.sendDocument(ctx.chat.id, {
      source: filePath,
      filename: fileName,
    });

    // Clean up temporary local file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete loading message if possible
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
    } catch (e) {
      // Ignore if cannot delete
    }
  } catch (err) {
    console.error('Excel Export Error:', err);
    await ctx.reply('❌ Failed to generate Excel report.');
  }
};

// Bind Excel export handler to command & button callback
bot.command('excel', async (ctx) => {
  await handleExcelExport(ctx);
});

bot.action('export_excel', async (ctx) => {
  await ctx.answerCbQuery();
  await handleExcelExport(ctx);
});

// ----------------------------------------------------
// Daily Scheduled Cron Jobs (Timezone: Asia/Dhaka, GMT+6)
// ----------------------------------------------------

// Broadcast 1: 9:30 AM BD Time Morning Broadcast
cron.schedule(
  '30 9 * * *',
  async () => {
    console.log('⏰ Executing 9:30 AM BD Morning Broadcast...');
    try {
      const [users] = await pool.query('SELECT telegram_id FROM users');
      const broadcastMsg =
        'Good morning! ☀️ Wish you a productive day ahead. ' +
        'If you face any workplace issues today, feel free to report them here!';

      for (const user of users) {
        try {
          await bot.telegram.sendMessage(user.telegram_id, broadcastMsg);
        } catch (err) {
          console.error(`Failed broadcast to ${user.telegram_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Morning Broadcast Error:', err);
    }
  },
  {
    timezone: 'Asia/Dhaka',
  }
);

// Broadcast 2: 6:00 PM BD Time Daily Evening Survey
cron.schedule(
  '0 18 * * *',
  async () => {
    console.log('⏰ Executing 6:00 PM BD Daily Evening Survey...');
    try {
      const [users] = await pool.query('SELECT telegram_id FROM users');
      const surveyMsg = '🌇 *Evening Workplace Feedback*\n\nHow satisfied were you with your workplace environment today? Please select a rating:';

      const surveyKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('⭐ 1', 'rate_1'),
          Markup.button.callback('⭐ 2', 'rate_2'),
          Markup.button.callback('⭐ 3', 'rate_3'),
          Markup.button.callback('⭐ 4', 'rate_4'),
          Markup.button.callback('⭐ 5', 'rate_5'),
        ],
      ]);

      for (const user of users) {
        try {
          await bot.telegram.sendMessage(user.telegram_id, surveyMsg, {
            parse_mode: 'Markdown',
            ...surveyKeyboard,
          });
        } catch (err) {
          console.error(`Failed survey broadcast to ${user.telegram_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Evening Survey Error:', err);
    }
  },
  {
    timezone: 'Asia/Dhaka',
  }
);

// Rating Button Callback Handler (1 to 5 Stars)
bot.action(/^rate_([1-5])$/, async (ctx) => {
  await ctx.answerCbQuery();
  const score = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id;
  const todayDate = getDhakaDateString();

  try {
    // Save rating score in database
    await pool.query(
      `INSERT INTO daily_ratings (telegram_user_id, rating_score, rating_date)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE rating_score = VALUES(rating_score)`,
      [userId, score, todayDate]
    );

    // Set user session step to listen for optional text remarks
    userSessions[userId] = {
      step: 'AWAITING_RATING_REMARKS',
      ratingDate: todayDate,
    };

    return ctx.reply(
      `Thank you for rating *${score}/5*! ⭐\n\n` +
        `💬 *Optional:* Please type any remarks or feedback about your day (or reply 'None' to skip).`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error storing rating:', err);
    return ctx.reply('Thank you for rating!');
  }
});

// ----------------------------------------------------
// Server Startup & Graceful Shutdown
// ----------------------------------------------------
bot.catch((err, ctx) => {
  console.error(`Telegraf error for update type "${ctx.updateType}":`, err);
});

async function main() {
  try {
    pool = await initDB();
    console.log('✅ Database connected.');

    await bot.launch();
    console.log('🚀 Telegram Bot is live and listening for messages!');
  } catch (err) {
    console.error('Fatal startup error:', err);
  }
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main();
