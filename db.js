const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
  database: process.env.DB_NAME || 'Transcom_Workplace_Helpdesk',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

async function initDB() {
  try {
    // 1. Connection without database to create DB if needed
    const tempConn = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      port: dbConfig.port,
    });

    await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
    await tempConn.end();

    // 2. Create tables if they do not exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(100),
        first_name VARCHAR(100),
        last_name VARCHAR(100) DEFAULT NULL,
        phone_number VARCHAR(30) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Safely apply migrations for existing installations
    try {
      await pool.query("ALTER TABLE users ADD COLUMN last_name VARCHAR(100) DEFAULT NULL;");
    } catch (e) {
      // Column may already exist
    }

    try {
      await pool.query("ALTER TABLE users ADD COLUMN phone_number VARCHAR(30) DEFAULT NULL;");
    } catch (e) {
      // Column may already exist
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tickets (
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
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_ratings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL,
        rating_score TINYINT NOT NULL,
        remarks TEXT DEFAULT NULL,
        rating_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
    `);

    console.log('✅ Database & tables initialized successfully.');
    return pool;
  } catch (error) {
    console.error('❌ Database Initialization Error:', error.message);
    throw error;
  }
}

function getPool() {
  return pool;
}

pool.initDB = initDB;
pool.getPool = getPool;

module.exports = pool;
