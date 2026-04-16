require('dotenv').config()
const { createUser } = require('../src/auth')

const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('Usage: node scripts/create-user.js <email> <password>')
  process.exit(1)
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.')
  process.exit(1)
}

createUser(email, password)
  .then(user => {
    console.log(`✓ User created: ${user.email}`)
    process.exit(0)
  })
  .catch(err => {
    if (err.code === '23505') {
      console.error('Error: That email is already in use.')
    } else {
      console.error('Error:', err.message)
    }
    process.exit(1)
  })
