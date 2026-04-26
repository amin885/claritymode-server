require('dotenv').config()
const { resetPassword } = require('../src/auth')

const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('Usage: node scripts/reset-password.js <email> <new-password>')
  process.exit(1)
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.')
  process.exit(1)
}

resetPassword(email, password)
  .then(user => {
    console.log(`✓ Password reset for: ${user.email}`)
    process.exit(0)
  })
  .catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
  })
