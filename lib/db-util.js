import mysql from 'mysql2/promise'

async function createConnection(config) {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: true,
    charset: 'utf8mb4_0900_ai_ci'
  })
}

async function bulkInsert(conn, table, rows) {
  if (rows.length === 0) return
  const columns = Object.keys(rows[0])
  const placeholders = `(${columns.map(() => '?').join(', ')})`
  const values = rows.map(row => columns.map(c => row[c]))
  const sql = `INSERT INTO \`${table}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}`
  await conn.query(sql, values.flat())
}

export { createConnection, bulkInsert }
