# Workplace Helpdesk Telegram Bot with Scheduled Daily Broadcasts & Excel Export

A complete Node.js backend service powered by `telegraf` (v4+), `mysql2`, `node-cron`, `exceljs`, and `dotenv` for employee workplace issue reporting, automated HR admin group notifications with interactive action buttons, scheduled daily broadcasts & satisfaction surveys, and dual-sheet Excel exports.

---

## 🌟 Key Features

1. **Employee Issue Reporting Workflow (`/start`)**:
   - Automatic user registration & profile update in MySQL DB.
   - Interactive 10-Department selection inline keyboard.
   - 6-Category Issue Type selection.
   - Detailed text description & optional photo submission.
   - Auto-generated unique ticket code (`TK-XXXXX`).

2. **HR / Maintenance Admin Group Notifications**:
   - Instant forwarding of reported tickets with details and photos to `HR_GROUP_CHAT_ID`.
   - Interactive action buttons:
     - `[ ⏳ In Progress ]`: Updates DB status and updates group chat status label.
     - `[ ✅ Mark Fixed ]`: Marks status as Fixed, updates group chat, and **triggers a direct private Telegram message to the employee**.
     - `[ 📊 Download Excel Report ]`: Generates and attaches Excel report.

3. **Scheduled Daily Cron Tasks (Timezone: `Asia/Dhaka`, GMT+6)**:
   - **09:30 AM BD Time Broadcast**: Sends morning motivation & issue reporting reminder to all registered users.
    - **03:50 PM BD Time Daily Survey**: Interactive 1 to 5 Star rating survey (`⭐ 1` to `⭐ 5`) with optional text feedback/remarks prompt.

4. **Dual-Sheet Excel Report Export**:
   - Triggered via group command `/excel` or group inline button `[ 📊 Download Excel Report ]`.
   - Generates `.xlsx` document containing:
     - **Sheet 1: Issue Tickets** (Ticket Code, Department, Issue Type, Description, User ID, Status, Created Date).
     - **Sheet 2: Daily Ratings & Remarks** (User ID, Rating Score, Remarks, Date).
   - Automatically cleans up local temporary files after upload.

---

## 📦 Prerequisites

- **Node.js**: v18.0.0 or higher
- **Database**: MySQL Server v8.0+ or MariaDB v10.5+
- **Process Manager**: PM2 (for 24/7 background operation)

---

## ⚙️ Installation & Setup

### 1. Clone & Install Dependencies
```bash
cd /home/user/Telegram_Employee_feedbackbot
npm install
```

### 2. Configure Environment Variables (`.env`)
Create or edit the `.env` file in the project root:

```env
BOT_TOKEN=your_telegram_bot_token_here
HR_GROUP_CHAT_ID=group_chat_id
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=database name
DB_PORT=3306
```

> ⚠️ **Note**: Make sure to add the bot to your Telegram HR Admin Group and promote it to Admin so it can send messages and read commands/callbacks.

### 3. Database Initialization
The bot will automatically create the database `company_helpdesk` and all required tables (`users`, `tickets`, `daily_ratings`) on startup!

Alternatively, you can manually run the DDL schema script:
```bash
mysql -u root -p < schema.sql
```

---

## 🚀 Running the Bot

### Development / Direct Mode
```bash
# Run using node
npm start

# Run with auto-reload (Node 18+)
npm run dev
```

---

## 🛡️ 24/7 Background Operation with PM2

PM2 ensures the bot runs continuously in the background, automatically restarts after crashes, and starts up automatically when the server reboots.

### 1. Install PM2 Globally
```bash
sudo npm install -g pm2
```

### 2. Start the Bot Process
```bash
pm2 start index.js --name "helpdesk-telegram-bot"
```

### 3. Save PM2 Process List & Setup Auto-Start on System Boot
```bash
pm2 save
pm2 startup
```

### 4. Useful PM2 Commands
```bash
# Check status of running processes
pm2 status

# View live application logs
pm2 logs helpdesk-telegram-bot

# Restart the bot
pm2 restart helpdesk-telegram-bot

# Stop the bot
pm2 stop helpdesk-telegram-bot

# Monitor CPU/Memory usage
pm2 monit
```

---

## 📊 Database Schema Details

```sql
-- Table 1: Registered Users
CREATE TABLE users (
    telegram_id BIGINT PRIMARY KEY,
    username VARCHAR(100),
    first_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table 2: Reported Tickets
CREATE TABLE tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_code VARCHAR(20) UNIQUE NOT NULL,
    department VARCHAR(50) NOT NULL,
    issue_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    photo_file_id VARCHAR(255) DEFAULT NULL,
    telegram_user_id BIGINT NOT NULL,
    status ENUM('Pending', 'In Progress', 'Fixed') DEFAULT 'Pending',
    hr_message_id BIGINT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Table 3: Daily Evening Satisfaction Ratings & Remarks
CREATE TABLE daily_ratings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    rating_score TINYINT NOT NULL,
    remarks TEXT DEFAULT NULL,
    rating_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

---

## 🧪 Verification & Testing

- Run `npm test` to verify syntax across all project files.
- Test `/start` in Telegram to trigger department selection keyboard.
- Verify status changes in HR Group (`HR_GROUP_CHAT_ID`) and verify that private messages are delivered to the employee when marked as `Fixed`.
