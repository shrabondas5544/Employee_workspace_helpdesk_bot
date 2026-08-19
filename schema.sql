-- Create database if not exists
CREATE DATABASE IF NOT EXISTS Transcom_Workplace_Helpdesk;
USE Transcom_Workplace_Helpdesk;

-- Table 1: Registered Users
CREATE TABLE IF NOT EXISTS users (
    telegram_id BIGINT PRIMARY KEY,
    username VARCHAR(100),
    first_name VARCHAR(100),
    last_name VARCHAR(100) DEFAULT NULL,
    phone_number VARCHAR(30) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table 2: Reported Tickets
CREATE TABLE IF NOT EXISTS tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_code VARCHAR(20) UNIQUE NOT NULL,
    department VARCHAR(50) NOT NULL,
    issue_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    photo_file_id VARCHAR(255) DEFAULT NULL,
    telegram_user_id BIGINT NOT NULL,
    status ENUM('Pending', 'In Progress', 'Fixed', 'Rejected') DEFAULT 'Pending',
    hr_message_id BIGINT DEFAULT NULL,
    resolved_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Table 3: Daily Evening Satisfaction Ratings & Remarks
CREATE TABLE IF NOT EXISTS daily_ratings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    rating_score TINYINT NOT NULL, -- 1 to 5 Stars
    remarks TEXT DEFAULT NULL,
    rating_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
