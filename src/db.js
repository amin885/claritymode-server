const { Pool } = require('pg')

const connString = process.env.POSTGRES_URL || process.env.DATABASE_URL
const pool = new Pool({
  connectionString: connString,
  ssl: connString ? { rejectUnauthorized: false } : false,
})

module.exports = {
  query: (text, params) => pool.query(text, params),
}
