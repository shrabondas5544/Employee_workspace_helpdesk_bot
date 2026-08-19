const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

/**
 * Generates an Excel report with two sheets: Issue Tickets & Daily Ratings
 * @param {object} pool MySQL connection pool
 * @returns {Promise<string>} Path to temporary generated Excel file
 */
async function generateExcelReport(pool) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Company Helpdesk Bot';
  workbook.created = new Date();

  // Header styling options
  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E78' }, // Dark Blue
  };
  const headerFont = {
    name: 'Calibri',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };

  // ----------------------------------------------------
  // Sheet 1: Issue Tickets
  // ----------------------------------------------------
  const sheet1 = workbook.addWorksheet('Issue Tickets');
  sheet1.columns = [
    { header: 'Ticket Code', key: 'ticket_code', width: 18 },
    { header: 'Department', key: 'department', width: 25 },
    { header: 'Issue Type', key: 'issue_type', width: 25 },
    { header: 'Description', key: 'description', width: 45 },
    { header: 'Reporter Name', key: 'reporter_name', width: 25 },
    { header: 'Phone Number', key: 'phone_number', width: 20 },
    { header: 'User ID', key: 'telegram_user_id', width: 18 },
    { header: 'Status', key: 'status', width: 15 },
    { header: 'Created Date', key: 'created_at', width: 22 },
  ];

  // Style header row 1
  const row1 = sheet1.getRow(1);
  row1.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // Query tickets from DB joining users table
  const [tickets] = await pool.query(
    `SELECT 
       t.ticket_code, 
       t.department, 
       t.issue_type, 
       t.description, 
       CONCAT_WS(' ', u.first_name, u.last_name) AS reporter_name,
       u.phone_number,
       t.telegram_user_id, 
       t.status, 
       t.created_at 
     FROM tickets t 
     LEFT JOIN users u ON t.telegram_user_id = u.telegram_id 
     ORDER BY t.created_at DESC`
  );

  tickets.forEach((t) => {
    sheet1.addRow({
      ticket_code: t.ticket_code,
      department: t.department,
      issue_type: t.issue_type,
      description: t.description,
      reporter_name: t.reporter_name || 'N/A',
      phone_number: t.phone_number || 'N/A',
      telegram_user_id: String(t.telegram_user_id),
      status: t.status,
      created_at: t.created_at ? new Date(t.created_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : '',
    });
  });

  // ----------------------------------------------------
  // Sheet 2: Daily Ratings & Remarks
  // ----------------------------------------------------
  const sheet2 = workbook.addWorksheet('Daily Ratings & Remarks');
  sheet2.columns = [
    { header: 'Reporter Name', key: 'reporter_name', width: 25 },
    { header: 'Phone Number', key: 'phone_number', width: 20 },
    { header: 'User ID', key: 'telegram_user_id', width: 18 },
    { header: 'Rating Score', key: 'rating_score', width: 15 },
    { header: 'Remarks', key: 'remarks', width: 45 },
    { header: 'Date', key: 'rating_date', width: 18 },
  ];

  // Style header row 1
  const sheet2Row1 = sheet2.getRow(1);
  sheet2Row1.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // Query ratings from DB joining users table
  const [ratings] = await pool.query(
    `SELECT 
       CONCAT_WS(' ', u.first_name, u.last_name) AS reporter_name,
       u.phone_number,
       r.telegram_user_id, 
       r.rating_score, 
       r.remarks, 
       r.rating_date 
     FROM daily_ratings r 
     LEFT JOIN users u ON r.telegram_user_id = u.telegram_id 
     ORDER BY r.rating_date DESC, r.created_at DESC`
  );

  ratings.forEach((r) => {
    sheet2.addRow({
      reporter_name: r.reporter_name || 'N/A',
      phone_number: r.phone_number || 'N/A',
      telegram_user_id: String(r.telegram_user_id),
      rating_score: r.rating_score,
      remarks: r.remarks || 'N/A',
      rating_date: r.rating_date ? new Date(r.rating_date).toISOString().split('T')[0] : '',
    });
  });

  // Save temporary file
  const tempDir = path.join(__dirname, 'temp_exports');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `helpdesk_report_${Date.now()}.xlsx`;
  const filePath = path.join(tempDir, filename);

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

module.exports = {
  generateExcelReport,
};
